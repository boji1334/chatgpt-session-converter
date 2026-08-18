import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const htmlPath = process.env.AT_VERIFY_HTML
  ? path.resolve(process.env.AT_VERIFY_HTML)
  : path.resolve("at-verify.html");
const html = fs.readFileSync(htmlPath, "utf8");

test("批量检测清除旧结果并处理流式 fetch 中断", () => {
  assert.match(html, /function clearSubscriptionResults\(\)/);
  assert.match(html, /clearSubscriptionResults\(\);\s*checking = true;/);
  assert.match(html, /networkError\.code = "STREAM_CONNECTION"/);
  assert.match(html, /progressEvents === 0 && checkApiUrl/);
  assert.match(html, /data = await postJson\(checkApiUrl, requestBody/);
  assert.match(html, /检测流连接中断/);
  assert.match(html, /请重新点击“开始检测”重试/);
  assert.match(html, /检测服务连接失败，请检查 API 服务或网络/);
});
