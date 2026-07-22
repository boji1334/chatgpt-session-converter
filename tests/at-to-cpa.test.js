#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createPrivateKey, webcrypto } = require("node:crypto");

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
  };
}

function loadPage(config = {}) {
  const htmlPath = path.join(__dirname, "..", "at-to-cpa.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  assert.ok(match, "expected standalone CPA page script");

  const elements = new Map();
  const body = createFakeElement();
  body.appendChild = () => {};
  let downloadedBlob;
  let downloadedLink;
  let registrationRequest;
  const document = {
    body,
    createElement() { downloadedLink = createFakeElement(); return downloadedLink; },
    querySelector(selector) {
      if (!elements.has(selector)) {
        const element = createFakeElement();
        if (selector === 'meta[name="agent-api-url"]') element.content = "https://api.cuixiaoxuan.com/api/agent/register";
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
  };
  const context = {
    Blob,
    Date,
    DataView,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    fetch: async (url, requestOptions) => {
      registrationRequest = { url, options: requestOptions, body: JSON.parse(requestOptions.body) };
      return {
        ok: config.responseStatus ? config.responseStatus >= 200 && config.responseStatus < 300 : true,
        status: config.responseStatus || 200,
        async json() { return config.responsePayload || { ok: true, agent_runtime_id: "runtime-cpa-fixture" }; },
      };
    },
    URL: { createObjectURL(blob) { downloadedBlob = blob; return "blob:test"; }, revokeObjectURL() {} },
    atob,
    btoa,
    document,
    setTimeout,
  };
  vm.runInNewContext(match[1], context, { filename: "at-to-cpa.html" });
  return {
    elements,
    html,
    getDownloadedBlob() { return downloadedBlob; },
    getDownloadedLink() { return downloadedLink; },
    getRegistrationRequest() { return registrationRequest; },
  };
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function accessToken(accountId, email, exp = 4102444800) {
  return jwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: `user-${accountId}`,
      chatgpt_plan_type: "plus",
    },
    "https://api.openai.com/profile": { email },
  });
}

async function generate(page, raw) {
  page.elements.get("#tokenInput").value = raw;
  await page.elements.get("#downloadButton").click();
}

async function testRawTokenProducesAgentIdentityCpaFile() {
  const page = loadPage();
  const token = accessToken("account-cpa", "cpa@example.com");
  await generate(page, token);
  const result = JSON.parse(await page.getDownloadedBlob().text());
  assert.equal(result.type, "codex");
  assert.equal(result.auth_mode, "agentIdentity");
  assert.equal(result.agent_runtime_id, "runtime-cpa-fixture");
  assert.equal(result.account_id, "account-cpa");
  assert.equal(result.chatgpt_user_id, "user-account-cpa");
  assert.equal(result.email, "cpa@example.com");
  assert.equal(result.plan_type, "plus");
  assert.equal(result.disabled, false);
  assert.equal("access_token" in result, false);
  assert.equal("refresh_token" in result, false);
  const privateKey = createPrivateKey({ key: Buffer.from(result.agent_private_key, "base64"), format: "der", type: "pkcs8" });
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  const request = page.getRegistrationRequest();
  assert.equal(request.url, "https://api.cuixiaoxuan.com/api/agent/register");
  assert.equal(request.body.access_token, token);
  assert.match(request.body.agent_public_key, /^ssh-ed25519 /);
  assert.equal(page.getDownloadedLink().download, "codex-agent-identity-cpa_example.com.json");
  assert.match(page.elements.get("#status").textContent, /CPA Agent Identity/);
  assert.match(page.elements.get("#status").className, /success/);
}

async function testCompleteSessionJsonIsAccepted() {
  const page = loadPage();
  const token = jwt({ exp: 4102444800 });
  await generate(page, JSON.stringify({
    WARNING_BANNER: "fixture",
    accessToken: token,
    user: { id: "session-user", email: "session@example.com" },
    account: { id: "account-session", planType: "pro", isFedrampCompliantWorkspace: true },
  }));
  const result = JSON.parse(await page.getDownloadedBlob().text());
  assert.equal(result.account_id, "account-session");
  assert.equal(result.chatgpt_user_id, "session-user");
  assert.equal(result.plan_type, "pro");
  assert.equal(result.chatgpt_account_is_fedramp, true);
  assert.equal(page.getRegistrationRequest().body.access_token, token);
}

async function testExpiredTokenIsRejected() {
  const page = loadPage();
  await generate(page, accessToken("expired", "expired@example.com", 1));
  assert.equal(page.getDownloadedBlob(), undefined);
  assert.equal(page.getRegistrationRequest(), undefined);
  assert.match(page.elements.get("#status").textContent, /已经过期/);
  assert.match(page.elements.get("#status").className, /error/);
}

async function testMissingBackendExplainsFailure() {
  const page = loadPage({ responseStatus: 404, responsePayload: { error: "Not found" } });
  await generate(page, accessToken("backend", "backend@example.com"));
  assert.equal(page.getDownloadedBlob(), undefined);
  assert.match(page.elements.get("#status").textContent, /Agent 注册后端尚未部署/);
}

function testEntryIsLinkedFromMainPage() {
  const page = loadPage();
  const mainHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(mainHtml, /href="\.\/at-to-cpa\.html"/);
  assert.match(mainHtml, />越接码下载CPA文件<\/a>/);
  assert.match(page.html, /<h1>越接码下载CPA文件<\/h1>/);
  assert.match(page.html, /私钥只在当前浏览器生成/);
  assert.match(page.html, /auth_mode: "agentIdentity"/);
}

async function main() {
  await testRawTokenProducesAgentIdentityCpaFile();
  await testCompleteSessionJsonIsAccepted();
  await testExpiredTokenIsRejected();
  await testMissingBackendExplainsFailure();
  testEntryIsLinkedFromMainPage();
  console.log("at-to-cpa tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
