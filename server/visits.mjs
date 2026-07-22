import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const VISIT_PAGE_IDS = new Set(["home", "at-to-sub2api"]);

function emptyStore() {
  return { version: 1, pages: {} };
}

function normalizeStore(value) {
  const store = emptyStore();
  if (!value || typeof value !== "object" || Array.isArray(value)) return store;

  for (const page of VISIT_PAGE_IDS) {
    const sourceDays = value.pages?.[page];
    if (!sourceDays || typeof sourceDays !== "object" || Array.isArray(sourceDays)) continue;
    const days = {};
    for (const [date, count] of Object.entries(sourceDays)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isSafeInteger(count) && count >= 0) days[date] = count;
    }
    store.pages[page] = days;
  }
  return store;
}

export function visitDateKey(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [shifted.getUTCFullYear(), String(shifted.getUTCMonth() + 1).padStart(2, "0"), String(shifted.getUTCDate()).padStart(2, "0")].join("-");
}

export function summarizeVisits(days, todayKey) {
  const countFor = (dateKey) => Number.isSafeInteger(days?.[dateKey]) ? days[dateKey] : 0;
  let last7Days = 0;
  for (let offset = 0; offset > -7; offset -= 1) last7Days += countFor(shiftDateKey(todayKey, offset));
  return {
    today: countFor(todayKey),
    yesterday: countFor(shiftDateKey(todayKey, -1)),
    last7Days,
    total: Object.values(days || {}).reduce((sum, count) => sum + (Number.isSafeInteger(count) && count >= 0 ? count : 0), 0),
  };
}

export class VisitCounter {
  constructor({ filePath, timeZone = "Asia/Shanghai" }) {
    if (!filePath) throw new Error("VisitCounter requires a file path");
    this.filePath = filePath;
    this.timeZone = timeZone;
    this.store = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.store) return this.store;
    try {
      this.store = normalizeStore(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.store = emptyStore();
    }
    return this.store;
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.store, null, 2)}\n`, "utf8");
  }

  record(page, date = new Date()) {
    if (!VISIT_PAGE_IDS.has(page)) return Promise.reject(new Error("Unknown visit page"));
    const operation = this.queue.then(async () => {
      const store = await this.load();
      const todayKey = visitDateKey(date, this.timeZone);
      const days = store.pages[page] || (store.pages[page] = {});
      days[todayKey] = (Number.isSafeInteger(days[todayKey]) ? days[todayKey] : 0) + 1;
      await this.save();
      return { page, date: todayKey, ...summarizeVisits(days, todayKey) };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
