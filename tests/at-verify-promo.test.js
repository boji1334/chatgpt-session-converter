import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const htmlPath = process.env.AT_VERIFY_HTML
  ? path.resolve(process.env.AT_VERIFY_HTML)
  : path.resolve("at-verify.html");
const html = fs.readFileSync(htmlPath, "utf8");

test("优惠 AT 只统计并导出首月免费已确认账号", () => {
  assert.match(html, /<div class="name">Free 首月免费已确认<\/div>/);
  assert.match(html, /导出已确认优惠 AT TXT/);
  assert.match(
    html,
    /subscription === "free" && rowData\.first_month_free_promo === "yes"\) promo \+= 1;/,
  );
  assert.match(
    html,
    /effectiveSubscription\(row\) === "free" && row\.first_month_free_promo === "yes" && row\.account_usable === "yes"/,
  );
  assert.doesNotMatch(
    html,
    /\["yes",\s*"likely"\]\.includes\((?:rowData|row)\.first_month_free_promo\)/,
  );
  assert.doesNotMatch(html, /free_trial_eligible_with_at\.txt/);
  assert.match(html, /free_first_month_free_confirmed_usable_full_with_at\.txt/);
  assert.match(html, /Free首月免费已确认=\$\{data\.extra_summary\?\.free_first_month_promo_yes \|\| 0\}/);
});
