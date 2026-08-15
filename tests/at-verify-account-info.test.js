import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const htmlPath = process.env.AT_VERIFY_HTML
  ? path.resolve(process.env.AT_VERIFY_HTML)
  : path.resolve("at-verify.html");
const html = fs.readFileSync(htmlPath, "utf8");

function loadExtractors() {
  const start = html.indexOf("      function extractAccountInfoLine(raw)");
  const end = html.indexOf("      function exportAccountInfoTxt()", start);
  assert.ok(start >= 0 && end > start, "account info extractor functions should exist");
  const context = {};
  vm.runInNewContext(`${html.slice(start, end)}\nthis.extractAccountInfoLine = extractAccountInfoLine; this.extractAccountInfoLines = extractAccountInfoLines;`, context);
  return context;
}

test("提取账号信息 TXT 会删除 AT 并保留邮箱、密码、2FA", () => {
  assert.match(html, /id="exportAccountInfoButton"[^>]*>提取账号信息 TXT<\/button>/);
  assert.match(html, /account_info_email_password_2fa\.txt/);
  assert.match(html, /intercept\(exportAccountInfoButton, exportAccountInfoTxt\)/);

  const { extractAccountInfoLine, extractAccountInfoLines } = loadExtractors();
  const input = "user+134@example.com----P@ss$word%----QZJZLJAEDJ6MQTKI----eyJheader.eyJpayload.signature";
  assert.equal(
    extractAccountInfoLine(input),
    "user+134@example.com----P@ss$word%----QZJZLJAEDJ6MQTKI",
  );
  assert.deepEqual(
    Array.from(extractAccountInfoLines(`${input}\ninvalid\n${input}`)),
    [
      "user+134@example.com----P@ss$word%----QZJZLJAEDJ6MQTKI",
      "user+134@example.com----P@ss$word%----QZJZLJAEDJ6MQTKI",
    ],
    "输入顺序与重复项必须保留",
  );
});
