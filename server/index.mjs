import http from "node:http";
import { URL } from "node:url";
import { failedQuotaResult, normalizeAccountInput, normalizeQuotaResponse } from "./quota.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 50);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const UPSTREAM_USAGE_URL = process.env.UPSTREAM_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage";
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "http://localhost:4173,http://127.0.0.1:4173").split(",").map((value) => value.trim()).filter(Boolean));
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const rateBuckets = new Map();

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

function clientAllowed(request) {
  const address = request.socket.remoteAddress || "unknown";
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
  json(response, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, HOST, () => {
  console.log(`quota service listening on ${HOST}:${PORT}`);
});
