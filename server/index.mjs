import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { failedQuotaResult, normalizeAccountInput, normalizeQuotaResponse } from "./quota.mjs";
import { VisitCounter, VISIT_PAGE_IDS } from "./visits.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 50);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const UPSTREAM_USAGE_URL = process.env.UPSTREAM_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage";
const AGENT_REGISTER_URL = process.env.AGENT_REGISTER_URL || "https://auth.openai.com/api/accounts/v1/agent/register";
const AGENT_VERSION = process.env.AGENT_VERSION || "0.138.0-alpha.6";
const AGENT_HARNESS_ID = process.env.AGENT_HARNESS_ID || "codex-cli";
const AGENT_RUNNING_LOCATION = process.env.AGENT_RUNNING_LOCATION || "local";
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "http://localhost:4173,http://127.0.0.1:4173").split(",").map((value) => value.trim()).filter(Boolean));
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const rateBuckets = new Map();
const VISIT_STORE_PATH = process.env.VISIT_STORE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "visits.json");
const VISIT_TIME_ZONE = process.env.VISIT_TIME_ZONE || "Asia/Shanghai";
const visitCounter = new VisitCounter({ filePath: VISIT_STORE_PATH, timeZone: VISIT_TIME_ZONE });

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

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  if (request.method === "POST" && url.pathname === "/api/visits") {
    await handleVisit(request, response, origin);
    return;
  }
  json(response, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, HOST, () => {
  console.log(`quota service listening on ${HOST}:${PORT}`);
});
