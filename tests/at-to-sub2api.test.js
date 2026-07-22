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
  let registrationRequest;
  const document = {
    body,
    createElement() {
      downloadedLink = createFakeElement();
      return downloadedLink;
    },
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
    TextDecoder,
    TextEncoder,
    crypto: webcrypto,
    fetch: async (url, options) => {
      registrationRequest = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, agent_runtime_id: "runtime-browser-fixture" }; },
      };
    },
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

function tokenWithPayload(payload) {
  return jwt(payload);
}

async function generate(page, raw) {
  page.elements.get("#tokenInput").value = raw;
  await page.elements.get("#downloadButton").click();
}

async function testSingleTokenProducesImportFile() {
  const page = loadPage();
  const token = accessToken("account-one", "one@example.com");
  await generate(page, token);

  const downloadedBlob = page.getDownloadedBlob();
  assert.ok(downloadedBlob, page.elements.get("#status").textContent);
  const result = JSON.parse(await downloadedBlob.text());
  assert.equal(result.auth_mode, "agentIdentity");
  assert.equal(result.agent_identity.agent_runtime_id, "runtime-browser-fixture");
  assert.equal(result.agent_identity.account_id, "account-one");
  assert.equal(result.agent_identity.chatgpt_user_id, "user-account-one");
  assert.equal(result.agent_identity.email, "one@example.com");
  assert.equal(result.agent_identity.plan_type, "plus");
  assert.equal("access_token" in result.agent_identity, false);
  const privateKey = createPrivateKey({ key: Buffer.from(result.agent_identity.agent_private_key, "base64"), format: "der", type: "pkcs8" });
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  const request = page.getRegistrationRequest();
  assert.equal(request.url, "https://api.cuixiaoxuan.com/api/agent/register");
  assert.equal(request.body.access_token, token);
  assert.match(request.body.agent_public_key, /^ssh-ed25519 /);
  assert.equal(page.getDownloadedLink().download, "sub2-agent-identity-one_example.com.json");
  assert.match(page.elements.get("#status").textContent, /Agent Identity 已注册并下载/);
  assert.match(page.elements.get("#status").className, /success/);
}

async function testBearerTokenIsAccepted() {
  const page = loadPage();
  const token = accessToken("account-bearer", "bearer@example.com", "team");
  await generate(page, `Bearer ${token}`);

  const result = JSON.parse(await page.getDownloadedBlob().text());
  assert.equal(result.agent_identity.plan_type, "team");
  assert.equal(page.getRegistrationRequest().body.access_token, token);
}

async function testCompleteSessionJsonIsAccepted() {
  const page = loadPage();
  const token = tokenWithPayload({ exp: 4102444800 });
  const session = {
    WARNING_BANNER: "fixture",
    user: { id: "user-session", name: "Session User", email: "session@example.com" },
    expires: "2100-01-01T00:00:00.000Z",
    account: { id: "account-session", planType: "pro" },
    accessToken: token,
    authProvider: "auth0",
    sessionToken: "session-fixture",
  };
  await generate(page, JSON.stringify(session, null, 2));

  const result = JSON.parse(await page.getDownloadedBlob().text());
  assert.equal(result.agent_identity.account_id, "account-session");
  assert.equal(result.agent_identity.chatgpt_user_id, "user-session");
  assert.equal(result.agent_identity.email, "session@example.com");
  assert.equal(result.agent_identity.plan_type, "pro");
  assert.equal(page.getRegistrationRequest().body.access_token, token);
  assert.match(page.elements.get("#status").textContent, /Agent Identity 已注册并下载/);
}

async function testInvalidTokenDoesNotEnableDownload() {
  const page = loadPage();
  await generate(page, "not-a-jwt");
  assert.equal(page.getDownloadedBlob(), undefined);
  assert.equal(page.getRegistrationRequest(), undefined);
  assert.match(page.elements.get("#status").textContent, /不是有效的 JWT/);
  assert.match(page.elements.get("#status").className, /error/);
}

function testStandaloneEntryIsLinkedFromMainPage() {
  const page = loadPage();
  const mainHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(mainHtml, /href="\.\/at-to-sub2api\.html"/);
  assert.match(mainHtml, />越接码下载sub2文件<\/a>/);
  assert.match(page.html, /<h1>越接码下载sub2文件<\/h1>/);
  assert.match(page.html, /私钥只在当前浏览器生成/);
  assert.match(page.html, /Agent Identity auth\.json/);
}

async function main() {
  await testSingleTokenProducesImportFile();
  await testBearerTokenIsAccepted();
  await testCompleteSessionJsonIsAccepted();
  await testInvalidTokenDoesNotEnableDownload();
  testStandaloneEntryIsLinkedFromMainPage();
  console.log("at-to-sub2api tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
