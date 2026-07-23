import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DownloadCounter, summarizeDownloads } from "../server/downloads.mjs";

function waitForReady(child, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("download service did not start")), 5000);
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

test("download summary keeps total equal to success plus failed", () => {
  assert.deepEqual(summarizeDownloads({ success: 12, failed: 3 }), {
    total: 15,
    success: 12,
    failed: 3,
  });
  assert.deepEqual(summarizeDownloads({ success: -1, failed: "3" }), {
    total: 0,
    success: 0,
    failed: 0,
  });
});

test("download counter persists separate totals for CPA and sub2", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-converter-downloads-"));
  const filePath = path.join(directory, "downloads.json");
  const counter = new DownloadCounter({ filePath });

  await Promise.all(Array.from({ length: 5 }, () => counter.record("at-to-sub2api", "success")));
  await counter.record("at-to-sub2api", "failed");
  await counter.record("at-to-cpa", "success");

  assert.deepEqual(await counter.get("at-to-sub2api"), {
    page: "at-to-sub2api",
    total: 6,
    success: 5,
    failed: 1,
  });
  assert.deepEqual(await counter.get("at-to-cpa"), {
    page: "at-to-cpa",
    total: 1,
    success: 1,
    failed: 0,
  });

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.pages["at-to-sub2api"].success, 5);
  assert.equal(persisted.pages["at-to-sub2api"].failed, 1);
  assert.equal(persisted.pages["at-to-cpa"].success, 1);
});

test("download API reads totals and records outcomes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-converter-download-api-"));
  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "18896",
      ALLOWED_ORIGINS: "http://localhost:4173",
      RATE_LIMIT_MAX: "100",
      DOWNLOAD_STORE_PATH: path.join(directory, "downloads.json"),
    },
    stdio: "ignore",
  });

  try {
    await waitForReady(service, "http://127.0.0.1:18896/healthz");
    const initialResponse = await fetch("http://127.0.0.1:18896/api/downloads?page=at-to-cpa", {
      headers: { Origin: "http://localhost:4173" },
    });
    assert.deepEqual((await initialResponse.json()).stats, {
      page: "at-to-cpa",
      total: 0,
      success: 0,
      failed: 0,
    });

    const recordResponse = await fetch("http://127.0.0.1:18896/api/downloads", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ page: "at-to-cpa", outcome: "success" }),
    });
    const recordPayload = await recordResponse.json();
    assert.equal(recordResponse.status, 200);
    assert.equal(recordResponse.headers.get("access-control-allow-origin"), "http://localhost:4173");
    assert.deepEqual(recordPayload.stats, {
      page: "at-to-cpa",
      total: 1,
      success: 1,
      failed: 0,
    });

    const invalidResponse = await fetch("http://127.0.0.1:18896/api/downloads", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ page: "at-to-cpa", outcome: "unknown" }),
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    service.kill();
  }
});
