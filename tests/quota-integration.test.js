import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function waitForExitOrReady(child, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("quota service did not start")), 5000);
    const probe = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch {
        // Retry until the service is ready or the timeout expires.
      }
      setTimeout(probe, 50);
    };
    child.once("error", reject);
    probe();
  });
}

test("quota service checks accounts without returning tokens", async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    assert.equal(request.headers["chatgpt-account-id"], "acct-fixture");
    const body = JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 4, reset_after_seconds: 7200 },
        secondary_window: { used_percent: 0, reset_after_seconds: 604800 },
      },
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(body);
  });
  await listen(upstream, 18888);

  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "18887",
      UPSTREAM_USAGE_URL: "http://127.0.0.1:18888/usage",
      ALLOWED_ORIGINS: "http://localhost:4173",
      RATE_LIMIT_MAX: "100",
    },
    stdio: "ignore",
  });

  try {
    await waitForExitOrReady(service, "http://127.0.0.1:18887/healthz");
    const response = await fetch("http://127.0.0.1:18887/api/quota/check", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ accounts: [{ email: "fixture@example.com", account_id: "acct-fixture", access_token: "fixture-token" }] }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.results[0].quota.windows["5h"].usedPercent, 4);
    assert.equal(payload.results[0].quota.windows["7d"].usedPercent, 0);
    assert.equal("accessToken" in payload.results[0], false);
    assert.equal("access_token" in payload.results[0], false);
  } finally {
    service.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
