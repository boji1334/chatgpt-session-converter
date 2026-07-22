import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { VisitCounter, shiftDateKey, summarizeVisits, visitDateKey } from "../server/visits.mjs";

function waitForReady(child, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("visit service did not start")), 5000);
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

test("visit date helpers use the configured time zone and rolling seven days", () => {
  assert.equal(visitDateKey(new Date("2026-07-22T16:30:00.000Z"), "Asia/Shanghai"), "2026-07-23");
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28");
  assert.deepEqual(summarizeVisits({
    "2026-07-22": 4,
    "2026-07-21": 3,
    "2026-07-16": 2,
    "2026-07-15": 9,
  }, "2026-07-22"), {
    today: 4,
    yesterday: 3,
    last7Days: 9,
    total: 18,
  });
});

test("visit counter serializes concurrent writes and persists per-page totals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-converter-visits-"));
  const filePath = path.join(directory, "visits.json");
  const counter = new VisitCounter({ filePath, timeZone: "Asia/Shanghai" });
  const instant = new Date("2026-07-22T09:00:00.000Z");

  const homeResults = await Promise.all(Array.from({ length: 8 }, () => counter.record("home", instant)));
  const subResult = await counter.record("at-to-sub2api", instant);
  assert.equal(homeResults.at(-1).today, 8);
  assert.equal(homeResults.at(-1).total, 8);
  assert.equal(subResult.today, 1);

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.pages.home["2026-07-22"], 8);
  assert.equal(persisted.pages["at-to-sub2api"]["2026-07-22"], 1);

  const reloaded = new VisitCounter({ filePath, timeZone: "Asia/Shanghai" });
  const next = await reloaded.record("home", instant);
  assert.equal(next.today, 9);
});

test("visit API increments allowed pages and returns CORS headers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "session-converter-visit-api-"));
  const service = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "18895",
      ALLOWED_ORIGINS: "http://localhost:4173",
      RATE_LIMIT_MAX: "100",
      VISIT_STORE_PATH: path.join(directory, "visits.json"),
      VISIT_TIME_ZONE: "Asia/Shanghai",
    },
    stdio: "ignore",
  });

  try {
    await waitForReady(service, "http://127.0.0.1:18895/healthz");
    const response = await fetch("http://127.0.0.1:18895/api/visits", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ page: "home" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:4173");
    assert.equal(payload.stats.page, "home");
    assert.equal(payload.stats.today, 1);
    assert.equal(payload.stats.total, 1);

    const invalidResponse = await fetch("http://127.0.0.1:18895/api/visits", {
      method: "POST",
      headers: { Origin: "http://localhost:4173", "Content-Type": "application/json" },
      body: JSON.stringify({ page: "unknown" }),
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    service.kill();
  }
});
