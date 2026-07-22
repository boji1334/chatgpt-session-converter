import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function waitForReady(child, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent registration service did not start")), 5000);
    const probe = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          clearTimeout(timer);
          resolve();
          return;
        }
      } catch {
        // Retry until ready.
      }
      setTimeout(probe, 50);
    };
    child.once("error", reject);
    probe();
  });
}

function sshPublicKeyFixture() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(jwk.x, "base64url");
  const type = Buffer.from("ssh-ed25519", "ascii");
  const blob = Buffer.alloc(4 + type.length + 4 + raw.length);
  blob.writeUInt32BE(type.length, 0);
  type.copy(blob, 4);
  blob.writeUInt32BE(raw.length, 4 + type.length);
  raw.copy(blob, 8 + type.length);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

test("agent registration proxy forwards only token and public key and returns runtime id", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamCalls += 1;
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer fixture-access-token");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.abom.agent_harness_id, "codex-cli");
      assert.equal(body.abom.running_location, "local");
      assert.match(body.agent_public_key, /^ssh-ed25519 /);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ agent_runtime_id: "runtime-server-fixture" }));
    });
  });
  await listen(upstream, 18892);

  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "18891",
      AGENT_REGISTER_URL: "http://127.0.0.1:18892/register",
      ALLOWED_ORIGINS: "http://localhost:4173",
      RATE_LIMIT_MAX: "100",
    },
    stdio: "ignore",
  });

  try {
    await waitForReady(service, "http://127.0.0.1:18891/healthz");
    const publicKey = sshPublicKeyFixture();
    const response = await fetch("http://127.0.0.1:18891/api/agent/register", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "fixture-access-token", agent_public_key: publicKey }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.agent_runtime_id, "runtime-server-fixture");
    assert.equal("access_token" in payload, false);
    assert.equal(upstreamCalls, 1);

    const invalidResponse = await fetch("http://127.0.0.1:18891/api/agent/register", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "fixture-access-token", agent_public_key: "invalid" }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal(upstreamCalls, 1);
  } finally {
    service.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
