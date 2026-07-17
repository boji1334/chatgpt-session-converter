import test from "node:test";
import assert from "node:assert/strict";
import { failedQuotaResult, normalizeAccountInput, normalizeQuotaResponse } from "../server/quota.mjs";

test("normalizes WHAM primary and secondary windows into 5h and 7d", () => {
  const result = normalizeQuotaResponse({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 12.5, reset_after_seconds: 7200 },
      secondary_window: { used_percent: 3, reset_after_seconds: 500000 },
    },
  }, { email: "one@example.com", accountId: "acct-1" });

  assert.equal(result.success, true);
  assert.equal(result.auth.plan, "plus");
  assert.equal(result.quota.windows["5h"].usedPercent, 12.5);
  assert.equal(result.quota.windows["7d"].usedPercent, 3);
  assert.equal(result.usage.used, true);
});

test("normalizes remaining percent and zero usage", () => {
  const result = normalizeQuotaResponse({
    quota: {
      windows: {
        "5h": { remaining_percent: 100, reset_at: "2099-01-01T00:00:00Z" },
        "7d": { used_percent: 0 },
      },
    },
  });

  assert.equal(result.quota.windows["5h"].usedPercent, 0);
  assert.equal(result.quota.windows["7d"].usedPercent, 0);
  assert.equal(result.usage.used, false);
});

test("does not expose token fields in normalized failure results", () => {
  const account = normalizeAccountInput({ email: "a@example.com", account_id: "acct-1", access_token: "secret" });
  const result = failedQuotaResult(account, "账号授权已失效或被拒绝", 401);

  assert.equal(account.accessToken, "secret");
  assert.equal(result.email, "a@example.com");
  assert.equal(result.auth.ok, false);
  assert.equal("accessToken" in result, false);
  assert.equal("access_token" in result, false);
});
