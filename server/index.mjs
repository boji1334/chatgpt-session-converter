import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { DownloadCounter, DOWNLOAD_OUTCOMES, DOWNLOAD_PAGE_IDS } from "./downloads.mjs";
import { failedQuotaResult, normalizeAccountInput, normalizeQuotaResponse } from "./quota.mjs";
import { VisitCounter, VISIT_PAGE_IDS } from "./visits.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 50);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const SUBSCRIPTION_BRIDGE_PATH = process.env.SUBSCRIPTION_BRIDGE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "subscription_bridge.py");
const SUBSCRIPTION_PYTHON = process.env.SUBSCRIPTION_PYTHON || (process.platform === "win32" ? "python" : "python3");
const SUBSCRIPTION_MAX_BODY_BYTES = Number(process.env.SUBSCRIPTION_MAX_BODY_BYTES || 20 * 1024 * 1024);
const SUBSCRIPTION_REQUEST_TIMEOUT_MS = Number(process.env.SUBSCRIPTION_REQUEST_TIMEOUT_MS || 180_000);
const UPSTREAM_USAGE_URL = process.env.UPSTREAM_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage";
const AGENT_REGISTER_URL = process.env.AGENT_REGISTER_URL || "https://auth.openai.com/api/accounts/v1/agent/register";
const AGENT_VERSION = process.env.AGENT_VERSION || "0.138.0-alpha.6";
const AGENT_HARNESS_ID = process.env.AGENT_HARNESS_ID || "codex-cli";
const AGENT_RUNNING_LOCATION = process.env.AGENT_RUNNING_LOCATION || "local";
const VERIFY_UPSTREAM_URL = process.env.VERIFY_UPSTREAM_URL || "https://chatgpt.com/backend-api/me";
const TRIAL_UPSTREAM_URL = process.env.TRIAL_UPSTREAM_URL || "https://chatgpt.com/backend-api/accounts/check_trial_eligibility/{account_id}";
const TRIAL_UPSTREAM_METHOD = (process.env.TRIAL_UPSTREAM_METHOD || "PATCH").toUpperCase();
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "http://localhost:4173,http://127.0.0.1:4173,https://boji1334.github.io").split(",").map((value) => value.trim()).filter(Boolean));
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const VERIFY_BATCH_CONCURRENCY = Math.max(1, Number(process.env.VERIFY_BATCH_CONCURRENCY || 3));
const rateBuckets = new Map();
const VISIT_STORE_PATH = process.env.VISIT_STORE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "visits.json");
const VISIT_TIME_ZONE = process.env.VISIT_TIME_ZONE || "Asia/Shanghai";
const DOWNLOAD_STORE_PATH = process.env.DOWNLOAD_STORE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "downloads.json");
const visitCounter = new VisitCounter({ filePath: VISIT_STORE_PATH, timeZone: VISIT_TIME_ZONE });
const downloadCounter = new DownloadCounter({ filePath: DOWNLOAD_STORE_PATH });

function json(res, status, body, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers.Vary = "Origin";
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return "";
  return ALLOWED_ORIGINS.has("*") || ALLOWED_ORIGINS.has(origin) ? origin : undefined;
}

function clientAddress(request) {
  const cloudflareAddress = request.headers["cf-connecting-ip"];
  if (typeof cloudflareAddress === "string" && cloudflareAddress.trim()) return cloudflareAddress.trim();
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",", 1)[0].trim();
  return request.socket.remoteAddress || "unknown";
}

function clientAllowed(request) {
  const address = clientAddress(request);
  const now = Date.now();
  const existing = rateBuckets.get(address);
  if (!existing || now - existing.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(address, { startedAt: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= RATE_LIMIT_MAX;
}

function readBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求 JSON 无效"));
      }
    });
    request.on("error", reject);
  });
}

function runSubscriptionBridge(body, timeoutMs = SUBSCRIPTION_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(SUBSCRIPTION_PYTHON, [SUBSCRIPTION_BRIDGE_PATH], {
      cwd: path.dirname(SUBSCRIPTION_BRIDGE_PATH),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("订阅检查服务超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`订阅检查服务启动失败：${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch { parsed = undefined; }
      if (!parsed) {
        reject(new Error(code ? `订阅检查服务失败（${code}）` : "订阅检查服务没有返回 JSON"));
        return;
      }
      if (parsed.ok === false && parsed.error) {
        reject(new Error(parsed.error));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(JSON.stringify(body));
  });
}

function streamSubscriptionBridge(body, response, origin, timeoutMs = SUBSCRIPTION_REQUEST_TIMEOUT_MS) {
  const headers = {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers.Vary = "Origin";
  }
  response.writeHead(200, headers);
  response.flushHeaders?.();

  const child = spawn(SUBSCRIPTION_PYTHON, [SUBSCRIPTION_BRIDGE_PATH], {
    cwd: path.dirname(SUBSCRIPTION_BRIDGE_PATH),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdoutBuffer = "";
  let stderr = "";
  let finished = false;
  const writeEvent = (event) => {
    if (finished || response.writableEnded) return;
    response.write(`${JSON.stringify(event)}\n`);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (!response.writableEnded) response.end();
  };
  const timer = setTimeout(() => {
    if (finished) return;
    child.kill();
    writeEvent({ type: "error", error: "订阅检查服务超时" });
    finish();
  }, timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        writeEvent(JSON.parse(line));
      } catch {
        console.error("subscription stream returned invalid JSON line");
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    writeEvent({ type: "error", error: `订阅检查服务启动失败：${error.message}` });
    finish();
  });
  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      try { writeEvent(JSON.parse(stdoutBuffer)); } catch { /* ignore trailing noise */ }
    }
    if (code && !finished) {
      console.error("subscription stream failed", stderr.trim());
      writeEvent({ type: "error", error: `订阅检查服务失败（${code}）` });
    }
    finish();
  });
  response.on("close", () => {
    if (!response.writableFinished && !finished) child.kill();
  });
  child.stdin.end(JSON.stringify({ ...body, action: "check_stream" }));
}

function parseUpstreamBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function upstreamErrorMessage(status) {
  if (status === 401 || status === 403) return "账号授权已失效或被拒绝";
  if (status === 429) return "上游服务限流，请稍后重试";
  if (status >= 500) return "上游服务暂时不可用";
  return `上游额度请求失败（HTTP ${status}）`;
}

function agentRegistrationErrorMessage(status) {
  if (status === 401 || status === 403) return "AT 已失效或 Agent Runtime 注册被拒绝";
  if (status === 409) return "Agent Runtime 注册状态冲突，请重新生成密钥后再试";
  if (status === 429) return "Agent Runtime 注册请求过于频繁，请稍后重试";
  if (status >= 500) return "OpenAI Agent Runtime 注册服务暂时不可用";
  return `Agent Runtime 注册失败（HTTP ${status}）`;
}

function validEd25519SSHPublicKey(value) {
  if (typeof value !== "string") return false;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) return false;
  let blob;
  try { blob = Buffer.from(parts[1], "base64"); }
  catch { return false; }
  if (blob.length !== 51) return false;
  const typeLength = blob.readUInt32BE(0);
  if (typeLength !== 11 || blob.subarray(4, 15).toString("ascii") !== "ssh-ed25519") return false;
  const keyLength = blob.readUInt32BE(15);
  return keyLength === 32 && blob.length === 19 + keyLength;
}

async function checkAccount(account) {
  const normalized = normalizeAccountInput(account);
  if (!normalized.accessToken) return failedQuotaResult(normalized, "缺少 access_token");
  if (!normalized.accountId) return failedQuotaResult(normalized, "缺少 account_id");

  try {
    const response = await fetch(UPSTREAM_USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${normalized.accessToken}`,
        "ChatGPT-Account-Id": normalized.accountId,
        "User-Agent": "chatgpt-session-converter/1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payloadText = await response.text();
    if (!response.ok) return failedQuotaResult(normalized, upstreamErrorMessage(response.status), response.status);
    const payload = parseUpstreamBody(payloadText);
    if (!payload) return failedQuotaResult(normalized, "上游没有返回有效 JSON", response.status);
    return normalizeQuotaResponse(payload, normalized);
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "额度请求超时" : "额度请求连接失败";
    return failedQuotaResult(normalized, message);
  }
}

async function handleQuotaCheck(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "请求过于频繁，请稍后重试" }, origin);
    return;
  }
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }
  if (!body || !Array.isArray(body.accounts) || body.accounts.length < 1 || body.accounts.length > MAX_ACCOUNTS) {
    json(response, 400, { ok: false, error: `accounts 数量必须在 1-${MAX_ACCOUNTS} 之间` }, origin);
    return;
  }

  const results = await Promise.all(body.accounts.map(checkAccount));
  json(response, 200, { ok: results.some((result) => result.success), checkedAt: new Date().toISOString(), results }, origin);
}

async function handleAgentRegister(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "请求过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : typeof body?.accessToken === "string" ? body.accessToken.trim() : "";
  const publicKey = typeof body?.agent_public_key === "string" ? body.agent_public_key.trim() : typeof body?.agentPublicKey === "string" ? body.agentPublicKey.trim() : "";
  if (!accessToken) {
    json(response, 400, { ok: false, error: "缺少 access_token" }, origin);
    return;
  }
  if (!validEd25519SSHPublicKey(publicKey)) {
    json(response, 400, { ok: false, error: "agent_public_key 不是有效的 Ed25519 SSH 公钥" }, origin);
    return;
  }

  try {
    const upstream = await fetch(AGENT_REGISTER_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        abom: {
          agent_version: AGENT_VERSION,
          agent_harness_id: AGENT_HARNESS_ID,
          running_location: AGENT_RUNNING_LOCATION,
        },
        agent_public_key: publicKey,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const upstreamText = await upstream.text();
    if (!upstream.ok) {
      json(response, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, {
        ok: false,
        error: agentRegistrationErrorMessage(upstream.status),
        upstream_status: upstream.status,
      }, origin);
      return;
    }
    const payload = parseUpstreamBody(upstreamText);
    const runtimeID = typeof payload?.agent_runtime_id === "string" ? payload.agent_runtime_id.trim() : typeof payload?.agentRuntimeId === "string" ? payload.agentRuntimeId.trim() : "";
    if (!runtimeID) {
      json(response, 502, { ok: false, error: "OpenAI 返回结果缺少 agent_runtime_id" }, origin);
      return;
    }
    json(response, 200, { ok: true, agent_runtime_id: runtimeID }, origin);
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "Agent Runtime 注册超时" : "Agent Runtime 注册连接失败";
    json(response, 502, { ok: false, error: message }, origin);
  }
}

async function handleVisit(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "请求过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const page = typeof body?.page === "string" ? body.page.trim() : "";
  if (!VISIT_PAGE_IDS.has(page)) {
    json(response, 400, { ok: false, error: "page 不是有效的统计页面" }, origin);
    return;
  }

  try {
    const stats = await visitCounter.record(page);
    json(response, 200, { ok: true, stats }, origin);
  } catch (error) {
    console.error("visit counter write failed", error);
    json(response, 500, { ok: false, error: "访问统计写入失败" }, origin);
  }
}

async function handleDownloadRead(request, response, origin, page) {
  if (!DOWNLOAD_PAGE_IDS.has(page)) {
    json(response, 400, { ok: false, error: "page 不是有效的下载页面" }, origin);
    return;
  }

  try {
    const stats = await downloadCounter.get(page);
    json(response, 200, { ok: true, stats }, origin);
  } catch (error) {
    console.error("download counter read failed", error);
    json(response, 500, { ok: false, error: "下载统计读取失败" }, origin);
  }
}

async function handleDownloadRecord(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "请求过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const page = typeof body?.page === "string" ? body.page.trim() : "";
  const outcome = typeof body?.outcome === "string" ? body.outcome.trim() : "";
  if (!DOWNLOAD_PAGE_IDS.has(page)) {
    json(response, 400, { ok: false, error: "page 不是有效的下载页面" }, origin);
    return;
  }
  if (!DOWNLOAD_OUTCOMES.has(outcome)) {
    json(response, 400, { ok: false, error: "outcome 必须为 success 或 failed" }, origin);
    return;
  }

  try {
    const stats = await downloadCounter.record(page, outcome);
    json(response, 200, { ok: true, stats }, origin);
  } catch (error) {
    console.error("download counter write failed", error);
    json(response, 500, { ok: false, error: "下载统计写入失败" }, origin);
  }
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwtPayload(token) {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  try { return JSON.parse(decodeBase64Url(segments[1])); }
  catch { return undefined; }
}

function extractAccountFromJwt(payload) {
  const auth = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload["https://api.openai.com/auth"] || {})
    : {};
  const profile = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload["https://api.openai.com/profile"] || {})
    : {};
  return {
    account_id: auth.chatgpt_account_id || "",
    user_id: auth.chatgpt_user_id || auth.user_id || "",
    email: profile.email || payload?.email || "",
    plan_type: auth.chatgpt_plan_type || "free",
    expires_at: payload?.exp ? new Date(payload.exp * 1000).toISOString() : undefined,
  };
}

function boolValue(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  }
  return undefined;
}

function extractTrialEligibility(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const nested = [root.trial, root.data, root.result, root.eligibility].filter((value) => value && typeof value === "object");
  return boolValue(
    root.eligible, root.is_eligible, root.trial_eligible, root.eligible_for_trial,
    root.can_start_trial, root.has_trial,
    ...nested.flatMap((value) => [value.eligible, value.is_eligible, value.trial_eligible, value.eligible_for_trial, value.can_start_trial, value.has_trial])
  );
}

async function checkTrialEligibility(accessToken, accountId) {
  if (!TRIAL_UPSTREAM_URL) return { trial_eligible: undefined, trial_error: "试用接口未配置" };
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const trialUrl = TRIAL_UPSTREAM_URL.includes("{account_id}")
      ? TRIAL_UPSTREAM_URL.replaceAll("{account_id}", encodeURIComponent(accountId || ""))
      : TRIAL_UPSTREAM_URL;
    const requestOptions = {
      method: ["PATCH", "POST", "GET"].includes(TRIAL_UPSTREAM_METHOD) ? TRIAL_UPSTREAM_METHOD : "PATCH",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (requestOptions.method === "PATCH" || requestOptions.method === "POST") {
      headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify({});
    }
    const upstream = await fetch(trialUrl, requestOptions);
    let payload = {};
    try { payload = JSON.parse(await upstream.text()); }
    catch { /* upstream did not return JSON */ }
    const eligible = extractTrialEligibility(payload);
    const notEligible = upstream.status === 404;
    return {
      trial_eligible: notEligible ? false : eligible,
      trial_upstream_status: upstream.status,
      trial_error: notEligible ? "未找到试用资格" : eligible === undefined ? (payload?.error || payload?.message || `试用资格接口未返回明确结果（HTTP ${upstream.status}）`) : (payload?.error || payload?.message || null),
    };
  } catch (error) {
    return {
      trial_eligible: undefined,
      trial_error: error?.name === "TimeoutError" ? "试用资格检测超时" : "试用资格检测连接失败",
    };
  }
}

async function verifyAccountPayload(accessToken, requestedAccountId = "", includeTrial = false) {
  const normalizedToken = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!normalizedToken) return { statusCode: 400, body: { ok: false, error: "缺少 access_token" } };

  // Parse JWT to extract account info (plan_type, email, account_id)
  const payload = parseJwtPayload(normalizedToken);
  const jwtInfo = payload ? extractAccountFromJwt(payload) : { account_id: "", user_id: "", email: "", plan_type: "free" };

  // Verify the token against ChatGPT backend API
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${normalizedToken}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
    };
    if (jwtInfo.account_id) {
      headers["ChatGPT-Account-Id"] = jwtInfo.account_id;
    }

    const upstream = await fetch(VERIFY_UPSTREAM_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Try to read upstream response for additional account info
    let upstreamData = {};
    try {
      const upstreamText = await upstream.text();
      upstreamData = JSON.parse(upstreamText);
    } catch { /* upstream didn't return valid JSON, that's ok */ }

    if (upstream.ok) {
      // Token is valid — account is active. Merge upstream data with JWT info.
      const planType = upstreamData.plan_type || jwtInfo.plan_type || "free";
      const email = upstreamData.email || jwtInfo.email || null;
      const accountId = upstreamData.account_id || jwtInfo.account_id || requestedAccountId || null;
      const trial = includeTrial ? await checkTrialEligibility(normalizedToken, accountId) : {};
      return { statusCode: 200, body: {
        ok: true,
        active: true,
        plan_type: planType,
        email,
        account_id: accountId,
        user_id: upstreamData.user_id || jwtInfo.user_id || null,
        token_expires_at: jwtInfo.expires_at || null,
        message: `账号正常，套餐为 ${planType}`,
        ...trial,
      } };
    } else if (upstream.status === 401 || upstream.status === 403) {
      // Token is invalid — 403 usually means the account was deleted/banned
      const reason = upstream.status === 403 ? "账号已被删除或被禁止访问" : "AT 已失效（已过期或已注销）";
      return { statusCode: 200, body: {
        ok: true,
        active: false,
        plan_type: jwtInfo.plan_type || null,
        email: jwtInfo.email || null,
        account_id: jwtInfo.account_id || requestedAccountId || null,
        user_id: jwtInfo.user_id || null,
        token_expires_at: jwtInfo.expires_at || null,
        upstream_status: upstream.status,
        error: reason,
      } };
    } else {
      return { statusCode: 200, body: {
        ok: true,
        active: false,
        plan_type: jwtInfo.plan_type || null,
        email: jwtInfo.email || null,
        account_id: jwtInfo.account_id || requestedAccountId || null,
        upstream_status: upstream.status,
        error: `ChatGPT 返回了异常状态码 ${upstream.status}`,
      } };
    }
  } catch (error) {
    // Network error — still return JWT info as fallback
    const message = error?.name === "TimeoutError" ? "验证请求超时" : "验证请求连接失败";
    return { statusCode: 200, body: {
      ok: true,
      active: null,
      plan_type: jwtInfo.plan_type || null,
      email: jwtInfo.email || null,
      account_id: jwtInfo.account_id || requestedAccountId || null,
      user_id: jwtInfo.user_id || null,
      token_expires_at: jwtInfo.expires_at || null,
      error: message,
    } };
  }
}

async function handleAccountVerify(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "请求过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const result = await verifyAccountPayload(body?.access_token, body?.account_id, body?.include_trial === true);
  json(response, result.statusCode, result.body, origin);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

async function handleAccountVerifyBatch(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "批量请求过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
  if (accounts.length < 1 || accounts.length > MAX_ACCOUNTS) {
    json(response, 400, { ok: false, error: `accounts 数量必须在 1-${MAX_ACCOUNTS} 之间` }, origin);
    return;
  }

  const results = await mapWithConcurrency(accounts, VERIFY_BATCH_CONCURRENCY, async (account, index) => {
    const record = typeof account === "string" ? { access_token: account } : account || {};
    const result = await verifyAccountPayload(record.access_token || record.accessToken, record.account_id || record.accountId, body?.include_trial === true);
    return { index: index + 1, ...result.body, http_status: result.statusCode };
  });
  json(response, 200, { ok: results.some((item) => item.ok === true), results }, origin);
}

async function handleSubscriptionBridge(request, response, origin, action) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "订阅查询过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request, SUBSCRIPTION_MAX_BODY_BYTES);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  try {
    const result = await runSubscriptionBridge({ ...body, action }, SUBSCRIPTION_REQUEST_TIMEOUT_MS);
    json(response, 200, result, origin);
  } catch (error) {
    console.error("subscription bridge failed", error.message);
    json(response, 502, { ok: false, error: error.message || "订阅检查服务失败" }, origin);
  }
}

async function handleTrialEligibility(request, response, origin) {
  if (!clientAllowed(request)) {
    json(response, 429, { ok: false, error: "请求过于频繁，请稍后重试" }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: error.message }, origin);
    return;
  }

  const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
  if (!accessToken) {
    json(response, 400, { ok: false, error: "缺少 access_token" }, origin);
    return;
  }

  const payload = parseJwtPayload(accessToken);
  const jwtInfo = payload ? extractAccountFromJwt(payload) : { account_id: "" };
  const accountId = typeof body?.account_id === "string" && body.account_id.trim() ? body.account_id.trim() : jwtInfo.account_id;
  const trial = await checkTrialEligibility(accessToken, accountId);
  json(response, 200, { ok: true, ...trial }, origin);
}

const server = http.createServer(async (request, response) => {
  const origin = allowedOrigin(request);
  if (request.headers.origin && !origin) {
    json(response, 403, { ok: false, error: "来源未加入允许列表" });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    } : {});
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { ok: true, service: "chatgpt-session-converter-quota", upstream: new URL(UPSTREAM_USAGE_URL).hostname });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/quota/check") {
    await handleQuotaCheck(request, response, origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/register") {
    await handleAgentRegister(request, response, origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/verify") {
    await handleAccountVerify(request, response, origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/verify-batch") {
    await handleAccountVerifyBatch(request, response, origin);
    return;
  }
  if (request.method === "POST" && ["/api/parse", "/api/subscription/parse"].includes(url.pathname)) {
    await handleSubscriptionBridge(request, response, origin, "parse");
    return;
  }
  if (request.method === "POST" && ["/api/check", "/api/subscription/check"].includes(url.pathname)) {
    await handleSubscriptionBridge(request, response, origin, "check");
    return;
  }
  if (request.method === "POST" && ["/api/check-stream", "/api/subscription/check-stream"].includes(url.pathname)) {
    if (!clientAllowed(request)) {
      json(response, 429, { ok: false, error: "订阅查询过于频繁，请稍后重试" }, origin);
      return;
    }
    let body;
    try {
      body = await readBody(request, SUBSCRIPTION_MAX_BODY_BYTES);
    } catch (error) {
      json(response, 400, { ok: false, error: error.message }, origin);
      return;
    }
    streamSubscriptionBridge(body, response, origin, SUBSCRIPTION_REQUEST_TIMEOUT_MS);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/account/trial-eligibility") {
    await handleTrialEligibility(request, response, origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/visits") {
    await handleVisit(request, response, origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/downloads") {
    await handleDownloadRead(request, response, origin, url.searchParams.get("page") || "");
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/downloads") {
    await handleDownloadRecord(request, response, origin);
    return;
  }
  json(response, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, HOST, () => {
  console.log(`quota service listening on ${HOST}:${PORT}`);
});
