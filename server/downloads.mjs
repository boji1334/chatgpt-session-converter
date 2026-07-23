import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DOWNLOAD_PAGE_IDS = new Set(["at-to-sub2api", "at-to-cpa"]);
export const DOWNLOAD_OUTCOMES = new Set(["success", "failed"]);

function emptyStore() {
  return { version: 1, pages: {} };
}

function emptyPageStats() {
  return { success: 0, failed: 0 };
}

function normalizeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeStore(value) {
  const store = emptyStore();
  if (!value || typeof value !== "object" || Array.isArray(value)) return store;

  for (const page of DOWNLOAD_PAGE_IDS) {
    const source = value.pages?.[page];
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    store.pages[page] = {
      success: normalizeCount(source.success),
      failed: normalizeCount(source.failed),
    };
  }
  return store;
}

export function summarizeDownloads(value) {
  const success = normalizeCount(value?.success);
  const failed = normalizeCount(value?.failed);
  return { total: success + failed, success, failed };
}

export class DownloadCounter {
  constructor({ filePath }) {
    if (!filePath) throw new Error("DownloadCounter requires a file path");
    this.filePath = filePath;
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

  async get(page) {
    if (!DOWNLOAD_PAGE_IDS.has(page)) throw new Error("Unknown download page");
    const store = await this.load();
    return { page, ...summarizeDownloads(store.pages[page]) };
  }

  record(page, outcome) {
    if (!DOWNLOAD_PAGE_IDS.has(page)) return Promise.reject(new Error("Unknown download page"));
    if (!DOWNLOAD_OUTCOMES.has(outcome)) return Promise.reject(new Error("Unknown download outcome"));

    const operation = this.queue.then(async () => {
      const store = await this.load();
      const pageStats = store.pages[page] || (store.pages[page] = emptyPageStats());
      pageStats[outcome] = normalizeCount(pageStats[outcome]) + 1;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      return { page, ...summarizeDownloads(pageStats) };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
