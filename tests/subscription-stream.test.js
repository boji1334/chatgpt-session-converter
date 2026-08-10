import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function waitForReady(child, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("service did not start")), 5000);
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

test("subscription stream timeout resets whenever progress arrives", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "subscription-stream-"));
  const bridgePath = path.join(tempDir, "bridge.py");
  await writeFile(bridgePath, [
    "import json, sys, time",
    "json.loads(sys.stdin.read() or '{}')",
    "print(json.dumps({'type':'start','total':5}), flush=True)",
    "for i in range(1, 6):",
    "    time.sleep(0.08)",
    "    print(json.dumps({'type':'progress','completed':i,'total':5,'row':{}}), flush=True)",
    "print(json.dumps({'type':'result','data':{'count':5,'rows':[]}}), flush=True)",
  ].join("\n"), "utf8");

  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "18897",
      SUBSCRIPTION_PYTHON: process.platform === "win32" ? "python" : "python3",
      SUBSCRIPTION_BRIDGE_PATH: bridgePath,
      SUBSCRIPTION_REQUEST_TIMEOUT_MS: "150",
      ALLOWED_ORIGINS: "http://localhost:4173",
      RATE_LIMIT_MAX: "100",
    },
    stdio: "ignore",
  });

  try {
    await waitForReady(service, "http://127.0.0.1:18897/healthz");
    const response = await fetch("http://127.0.0.1:18897/api/check-stream", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "fixture" }),
    });
    const events = (await response.text()).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.equal(events.filter((event) => event.type === "progress").length, 5);
    assert.equal(events.at(-1).type, "result");
  } finally {
    service.kill();
    await rm(tempDir, { recursive: true, force: true });
  }
});
