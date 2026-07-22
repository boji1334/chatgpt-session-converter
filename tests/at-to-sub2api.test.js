#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createFakeElement() {
  return {
    className: "",
    disabled: false,
    href: "",
    download: "",
    listeners: {},
    textContent: "",
    value: "",
    addEventListener(type, handler) { this.listeners[type] = handler; },
    click() { return this.listeners.click?.({ target: this, preventDefault() {} }); },
    focus() {},
    remove() {},
    select() {},
  };
}

function loadPage() {
  const htmlPath = path.join(__dirname, "..", "at-to-sub2api.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  assert.ok(match, "expected standalone page script");

  const elements = new Map();
  const body = createFakeElement();
  body.appendChild = () => {};
  let downloadedBlob;
  let downloadedLink;
  const document = {
    body,
    createElement() {
      downloadedLink = createFakeElement();
      return downloadedLink;
    },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createFakeElement());
      return elements.get(selector);
    },
  };
  const context = {
    Blob,
    Date,
    TextDecoder,
    TextEncoder,
    URL: { createObjectURL(blob) { downloadedBlob = blob; return "blob:test"; }, revokeObjectURL() {} },
    atob,
    btoa,
    document,
    navigator: { clipboard: { async writeText() {} } },
    setTimeout,
  };
  vm.runInNewContext(match[1], context, { filename: "at-to-sub2api.html" });
  return {
    elements,
    html,
    getDownloadedBlob() { return downloadedBlob; },
    getDownloadedLink() { return downloadedLink; },
  };
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function accessToken(accountId, email, planType = "plus") {
  return jwt({
    exp: 4102444800,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: `user-${accountId}`,
      chatgpt_plan_type: planType,
    },
    "https://api.openai.com/profile": { email },
  });
}

function generate(page, raw) {
  page.elements.get("#tokenInput").value = raw;
  page.elements.get("#downloadButton").click();
}

async function testSingleTokenProducesImportFile() {
  const page = loadPage();
  const token = accessToken("account-one", "one@example.com");
  generate(page, token);

  const result = JSON.parse(await page.getDownloadedBlob().text());
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].platform, "openai");
  assert.equal(result.accounts[0].type, "oauth");
  assert.equal(result.accounts[0].credentials.access_token, token);
  assert.equal(result.accounts[0].credentials.chatgpt_account_id, "account-one");
  assert.equal(result.accounts[0].credentials.chatgpt_user_id, "user-account-one");
  assert.equal(result.accounts[0].credentials.email, "one@example.com");
  assert.match(result.accounts[0].credentials.id_token, /\.synthetic$/);
  assert.equal(result.accounts[0].auto_pause_on_expired, true);
  assert.equal(page.getDownloadedLink().download, "sub2api-one_example.com.json");
  assert.match(page.elements.get("#status").textContent, /已生成并下载/);
  assert.match(page.elements.get("#status").className, /success/);
}

async function testBearerTokenIsAccepted() {
  const page = loadPage();
  const token = accessToken("account-bearer", "bearer@example.com", "team");
  generate(page, `Bearer ${token}`);

  const result = JSON.parse(await page.getDownloadedBlob().text());
  assert.equal(result.accounts[0].credentials.access_token, token);
  assert.equal(result.accounts[0].credentials.plan_type, "team");
}

function testInvalidTokenDoesNotEnableDownload() {
  const page = loadPage();
  generate(page, "not-a-jwt");
  assert.equal(page.getDownloadedBlob(), undefined);
  assert.match(page.elements.get("#status").textContent, /不是有效的 JWT/);
  assert.match(page.elements.get("#status").className, /error/);
}

function testStandaloneEntryIsLinkedFromMainPage() {
  const page = loadPage();
  const mainHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(mainHtml, /href="\.\/at-to-sub2api\.html"/);
  assert.match(mainHtml, />越接码下载sub2文件<\/a>/);
  assert.match(page.html, /<h1>越接码下载sub2文件<\/h1>/);
  assert.match(page.html, /不上传、不保存/);
}

async function main() {
  await testSingleTokenProducesImportFile();
  await testBearerTokenIsAccepted();
  testInvalidTokenDoesNotEnableDownload();
  testStandaloneEntryIsLinkedFromMainPage();
  console.log("at-to-sub2api tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
