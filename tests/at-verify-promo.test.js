import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const htmlPath = process.env.AT_VERIFY_HTML
  ? path.resolve(process.env.AT_VERIFY_HTML)
  : path.resolve("at-verify.html");
const html = fs.readFileSync(htmlPath, "utf8");

function loadPromoHelper() {
  const start = html.indexOf("      function isFirstMonthPromoCandidate(value)");
  const end = html.indexOf("      function badgeClass", start);
  assert.ok(start >= 0 && end > start, "promo candidate helper should exist");
  const context = {};
  vm.runInNewContext(`${html.slice(start, end)}\nthis.isFirstMonthPromoCandidate = isFirstMonthPromoCandidate;`, context);
  return context.isFirstMonthPromoCandidate;
}

test("优惠 AT 包含首月免费确认和候选，排除明确不是优惠的账号", () => {
  assert.match(html, /<div class="name">Free 首月优惠候选<\/div>/);
  assert.match(html, /导出优惠 AT TXT/);
  assert.match(html, /首月免费候选（计入优惠 AT）/);
  assert.match(html, /function isFirstMonthPromoCandidate\(value\)/);
  assert.match(
    html,
    /subscription === "free" && isFirstMonthPromoCandidate\(rowData\.first_month_free_promo\)\) promo \+= 1;/,
  );
  assert.match(
    html,
    /effectiveSubscription\(row\) === "free" && isFirstMonthPromoCandidate\(row\.first_month_free_promo\) && row\.account_usable === "yes"/,
  );
  assert.match(html, /\["yes", "likely"\]\.includes\(String\(value \|\| ""\)\.trim\(\)\.toLowerCase\(\)\)/);
  assert.doesNotMatch(html, /first_month_free_promo === "yes" && row\.account_usable/);
  assert.doesNotMatch(html, /free_first_month_free_confirmed_usable_full_with_at\.txt/);
  assert.match(html, /free_first_month_promo_candidates_usable_full_with_at\.txt/);
  assert.match(html, /Free首月优惠候选=\$\{data\.extra_summary\?\.free_first_month_promo_candidate \|\| 0\}/);

  const isFirstMonthPromoCandidate = loadPromoHelper();
  assert.equal(isFirstMonthPromoCandidate("yes"), true);
  assert.equal(isFirstMonthPromoCandidate("likely"), true);
  assert.equal(isFirstMonthPromoCandidate("no"), false);
  assert.equal(isFirstMonthPromoCandidate("unknown"), false);
});
