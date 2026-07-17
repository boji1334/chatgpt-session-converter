const WINDOW_ALIASES = {
  "5h": ["5h", "primary", "primary_window", "five_hour", "fiveHour"],
  "7d": ["7d", "secondary", "secondary_window", "seven_day", "sevenDay"],
};

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function numberOrUndefined(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function firstObject(...values) {
  return values.map(asObject).find(Boolean);
}

function collectContainers(payload) {
  const root = asObject(payload) || {};
  const containers = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    const object = asObject(value);
    if (!object || depth > 4 || seen.has(object)) return;
    seen.add(object);
    containers.push(object);
    for (const key of ["rate_limit", "rateLimit", "quota", "usage", "data", "result"]) visit(object[key], depth + 1);
  };
  visit(root);
  return containers;
}

function findWindow(containers, key) {
  const aliases = WINDOW_ALIASES[key];
  for (const container of containers) {
    for (const alias of aliases) {
      const candidate = asObject(container[alias]);
      if (candidate) return candidate;
    }
    const windows = asObject(container.windows);
    if (windows) {
      for (const alias of aliases) {
        const candidate = asObject(windows[alias]);
        if (candidate) return candidate;
      }
    }
  }
  return undefined;
}

function normalizeWindow(raw, key) {
  if (!raw) return { key, label: key, usedPercent: undefined, resetAfterSeconds: undefined, resetAt: undefined, recovered: false };
  let usedPercent = numberOrUndefined(raw.used_percent, raw.usedPercent, raw.used_percentage, raw.percent);
  const remainingPercent = numberOrUndefined(raw.remaining_percent, raw.remainingPercent);
  if (usedPercent === undefined && remainingPercent !== undefined) usedPercent = 100 - remainingPercent;
  return {
    key,
    label: key,
    usedPercent,
    resetAfterSeconds: numberOrUndefined(raw.reset_after_seconds, raw.resetAfterSeconds),
    resetAt: typeof raw.reset_at === "string" ? raw.reset_at : typeof raw.resetAt === "string" ? raw.resetAt : undefined,
    recovered: raw.recovered === true || raw.reset_expired === true,
  };
}

function hasWindowData(window) {
  return window.usedPercent !== undefined || window.resetAfterSeconds !== undefined || window.resetAt !== undefined || window.recovered;
}

export function normalizeQuotaResponse(payload, account = {}) {
  const containers = collectContainers(payload);
  const windows = {
    "5h": normalizeWindow(findWindow(containers, "5h"), "5h"),
    "7d": normalizeWindow(findWindow(containers, "7d"), "7d"),
  };
  const rateLimit = firstObject(payload?.rate_limit, payload?.rateLimit, payload?.quota);
  const usage = firstObject(payload?.usage, payload?.data?.usage);
  const used = typeof usage?.used === "boolean"
    ? usage.used
    : Object.values(windows).some((window) => typeof window.usedPercent === "number" && window.usedPercent > 0)
      ? true
      : Object.values(windows).some((window) => window.usedPercent === 0)
        ? false
        : undefined;
  const hasWindows = Object.values(windows).some(hasWindowData);
  const quotaOk = hasWindows;
  const plan = typeof payload?.plan_type === "string" ? payload.plan_type : typeof payload?.planType === "string" ? payload.planType : undefined;
  return {
    email: account.email || "",
    accountId: account.accountId || "",
    success: quotaOk,
    message: quotaOk ? "额度读取完成" : "上游未返回 5h / 7d 额度窗口",
    connectivity: { ok: true },
    auth: { ok: true, plan },
    quota: { ok: quotaOk, exhausted: rateLimit?.limit_reached === true || rateLimit?.limitReached === true, windows },
    usage: { used },
  };
}

export function failedQuotaResult(account = {}, message = "检测失败", status) {
  return {
    email: account.email || "",
    accountId: account.accountId || "",
    success: false,
    message,
    status,
    connectivity: { ok: false },
    auth: { ok: status !== 401 && status !== 403 ? undefined : false },
    quota: { ok: false, windows: { "5h": normalizeWindow(undefined, "5h"), "7d": normalizeWindow(undefined, "7d") } },
    usage: { used: undefined },
  };
}

export function normalizeAccountInput(value) {
  const account = asObject(value) || {};
  return {
    email: typeof account.email === "string" ? account.email.trim() : "",
    accountId: typeof account.accountId === "string" ? account.accountId.trim() : typeof account.account_id === "string" ? account.account_id.trim() : "",
    accessToken: typeof account.accessToken === "string" ? account.accessToken.trim() : typeof account.access_token === "string" ? account.access_token.trim() : "",
  };
}
