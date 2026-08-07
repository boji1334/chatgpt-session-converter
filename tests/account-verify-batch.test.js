import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function waitForReady(child, url) {
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
      } catch { /* retry */ }
      setTimeout(probe, 50);
    };
    child.once("error", reject);
    probe();
  });
}

test("batch account verification uses one inbound request and returns trial eligibility", async () => {
  const upstream = http.createServer((request, response) => {
    const auth = request.headers.authorization || "";
    if (request.url?.startsWith("/me") && auth === "Bearer fixture-active") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ plan_type: "free", email: "active@example.com", account_id: "acct-active" }));
      return;
    }
    if (request.url?.startsWith("/me")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid" }));
      return;
    }
    if (request.method === "PATCH" && request.url === "/trial/acct-active") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ eligible: true }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await listen(upstream, 18886);

  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "18885",
      VERIFY_UPSTREAM_URL: "http://127.0.0.1:18886/me",
      TRIAL_UPSTREAM_URL: "http://127.0.0.1:18886/trial/{account_id}",
      TRIAL_UPSTREAM_METHOD: "PATCH",
      ALLOWED_ORIGINS: "http://localhost:4173",
      RATE_LIMIT_MAX: "1",
      VERIFY_BATCH_CONCURRENCY: "2",
    },
    stdio: "ignore",
  });

  try {
    await waitForReady(service, "http://127.0.0.1:18885/healthz");
    const response = await fetch("http://127.0.0.1:18885/api/account/verify-batch", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({
        include_trial: true,
        accounts: [
          { access_token: "fixture-active", account_id: "acct-active" },
          { access_token: "fixture-invalid", account_id: "acct-invalid" },
        ],
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.results.length, 2);
    assert.equal(payload.results[0].active, true);
    assert.equal(payload.results[0].trial_eligible, true);
    assert.equal(payload.results[1].active, false);
    assert.equal("access_token" in payload.results[0], false);
    assert.equal("access_token" in payload.results[1], false);
  } finally {
    service.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
