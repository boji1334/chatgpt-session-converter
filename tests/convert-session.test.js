#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createFakeElement(selector, options = {}) {
  const classes = new Set();

  return {
    selector,
    attributes: {},
    dataset: options.dataset || {},
    disabled: false,
    files: [],
    innerHTML: "",
    listeners: {},
    style: {},
    textContent: "",
    value: "",
    className: "",
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    appendChild() {},
    click() { return this.listeners.click?.({ target: this, preventDefault() {} }); },
    closest() { return null; },
    focus() {},
    remove() {},
    select() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
}

function loadPageScript() {
  const htmlPath = path.join(__dirname, "..", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  assert.ok(match, "expected index.html to contain one inline script");

  const elements = new Map();
  const formatButtons = ["sub2api", "cpa", "cockpit", "9router", "codex", "axonhub", "codexmanager"].map((format) =>
    createFakeElement(`[data-format="${format}"]`, { dataset: { format } })
  );
  const body = createFakeElement("body");

  const document = {
    body,
    createElement(selector) { return createFakeElement(selector); },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createFakeElement(selector));
      return elements.get(selector);
    },
    querySelectorAll(selector) { return selector === "[data-format]" ? formatButtons : []; },
  };

  const context = {
    Blob,
    TextDecoder,
    TextEncoder,
    URL: {
      createObjectURL() { return "blob:test"; },
      revokeObjectURL() {},
    },
    atob,
    btoa,
    clearTimeout,
    console,
    document,
    navigator: { clipboard: { async writeText() {} } },
    setTimeout,
  };

  vm.runInNewContext(match[1], context, { filename: "index.html" });
  return { elements, formatButtons, html };
}

function dispatch(element, type, event = {}) {
  assert.equal(typeof element.listeners[type], "function", `missing ${type} listener on ${element.selector}`);
  return element.listeners[type]({ target: element, preventDefault() {}, ...event });
}

function jwtWithPayload(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

function setInput(page, value) {
  const input = page.elements.get("#pasteInput");
  input.value = JSON.stringify(value);
  dispatch(input, "input");
}

function selectFormat(page, format) {
  const button = page.formatButtons.find((item) => item.dataset.format === format);
  assert.ok(button, `missing ${format} button`);
  dispatch(button, "click");
}

function readOutput(page) {
  return JSON.parse(page.elements.get("#output").value);
}

function authClaims(accountId, email = "mark@example.com") {
  return {
    email,
    exp: 1893456000,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "plus",
      chatgpt_user_id: `user-${accountId}`,
    },
  };
}

function testTokenOnlyAxonHubInputIsDetected() {
  const page = loadPageScript();
  const idToken = jwtWithPayload(authClaims("account-axon"));
  setInput(page, {
    auth_mode: "chatgpt",
    last_refresh: "2026-06-01T12:00:00.000Z",
    tokens: {
      access_token: "opaque-access-token",
      refresh_token: "real-refresh-token",
      id_token: idToken,
    },
  });

  const output = readOutput(page);
  assert.equal(output.accounts.length, 1);
  assert.equal(output.accounts[0].credentials.chatgpt_account_id, "account-axon");
  assert.equal(output.accounts[0].credentials.refresh_token, "real-refresh-token");
  assert.equal(output.accounts[0].credentials.id_token, idToken);
  assert.equal(output.accounts[0].extra.last_refresh, "2026-06-01T12:00:00.000Z");
}

function testRefreshableInputPreservesExpiryAcrossFormats() {
  const page = loadPageScript();
  const idToken = jwtWithPayload(authClaims("account-expiry"));
  setInput(page, {
    email: "expiry@example.com",
    account_id: "account-expiry",
    accessToken: "opaque-access-token",
    refreshToken: "real-refresh-token",
    idToken,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });

  const sub2api = readOutput(page).accounts[0];
  assert.equal(sub2api.expires_at, undefined);
  assert.equal(sub2api.auto_pause_on_expired, undefined);
  assert.equal(sub2api.credentials.expires_at, "2030-01-01T00:00:00.000Z");
  assert.equal(sub2api.credentials.refresh_token, "real-refresh-token");

  selectFormat(page, "9router");
  const nineRouter = readOutput(page);
  assert.equal(nineRouter.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.equal(nineRouter.refreshToken, "real-refresh-token");

  selectFormat(page, "cockpit");
  assert.equal(readOutput(page).expired, "2030-01-01T00:00:00.000Z");
}

function testLastRefreshIsPreserved() {
  const page = loadPageScript();
  const idToken = jwtWithPayload(authClaims("account-refresh"));
  setInput(page, {
    auth_mode: "chatgpt",
    last_refresh: "2026-05-20T03:04:05.000Z",
    tokens: {
      access_token: "opaque-access-token",
      refresh_token: "real-refresh-token",
      id_token: idToken,
      account_id: "account-refresh",
    },
  });
  selectFormat(page, "codex");
  assert.equal(readOutput(page).last_refresh, "2026-05-20T03:04:05.000Z");
}

function testBatchConversionPreservesAllSub2apiAccounts() {
  const page = loadPageScript();
  const sharedAccountId = "shared-workspace-account";
  const accounts = Array.from({ length: 100 }, (_, index) => {
    const email = `batch-${String(index + 1).padStart(3, "0")}@example.com`;
    return {
      name: email,
      platform: "openai",
      type: "oauth",
      credentials: {
        access_token: `access-token-${index + 1}`,
        refresh_token: `refresh-token-${index + 1}`,
        id_token: jwtWithPayload(authClaims(sharedAccountId, email)),
        chatgpt_account_id: sharedAccountId,
        email,
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    };
  });

  setInput(page, { exported_at: "2026-07-14T00:00:00.000Z", proxies: [], accounts });
  selectFormat(page, "cpa");
  const output = readOutput(page);
  assert.ok(Array.isArray(output));
  assert.equal(output.length, 100);
  assert.equal(output[0].email, "batch-001@example.com");
  assert.equal(output[0].access_token, "access-token-1");
  assert.equal(output[99].email, "batch-100@example.com");
  assert.equal(output[99].access_token, "access-token-100");
  assert.equal(page.elements.get("#recordCount").textContent, 100);
  assert.equal(page.elements.get("#invalidCount").textContent, 0);
  assert.match(page.elements.get("#inputStatus").textContent, /已生成 100 个账号/);
  assert.match(page.elements.get("#formatNotice").textContent, /CPA 合并 JSON 是数组/);
  assert.match(page.elements.get("#formatNotice").textContent, /独立 JSON ZIP/);
  assert.match(page.elements.get("#outputDescription").textContent, /批量导入请下载独立 JSON ZIP/);
}

function testFormatValidationReportsMissingFields() {
  const page = loadPageScript();
  setInput(page, { name: "temporary", access_token: "opaque-access-token" });
  selectFormat(page, "codex");

  assert.equal(page.elements.get("#warningCount").textContent, 1);
  assert.match(page.elements.get("#formatNotice").className, /error/);
  assert.match(page.elements.get("#formatNotice").textContent, /id_token/);
  assert.match(page.elements.get("#formatNotice").textContent, /account_id/);
}

function testAllFormatsProduceJson() {
  const page = loadPageScript();
  const idToken = jwtWithPayload(authClaims("account-all"));
  setInput(page, {
    email: "all@example.com",
    account_id: "account-all",
    access_token: jwtWithPayload(authClaims("account-all", "all@example.com")),
    refresh_token: "real-refresh-token",
    id_token: idToken,
    expired: "2030-01-01T00:00:00.000Z",
  });

  for (const format of ["sub2api", "cpa", "cockpit", "9router", "codex", "axonhub", "codexmanager"]) {
    selectFormat(page, format);
    assert.doesNotThrow(() => readOutput(page), `${format} should produce valid JSON`);
  }
}

async function testFileInputCanSelectTheSameFileAgain() {
  const page = loadPageScript();
  const fileInput = page.elements.get("#fileInput");
  const content = JSON.stringify({ email: "file@example.com", access_token: "file-access-token" });
  fileInput.value = "C:\\fakepath\\account.json";
  fileInput.files = [{ name: "account.json", type: "application/json", size: content.length, async text() { return content; } }];
  dispatch(fileInput, "change");

  assert.equal(fileInput.value, "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.elements.get("#recordCount").textContent, 1);
}

function testNetworkIsBlockedByCsp() {
  const page = loadPageScript();
  assert.match(page.html, /Content-Security-Policy/);
  assert.match(page.html, /connect-src 'none'/);
  assert.match(page.html, /name="referrer" content="no-referrer"/);
}

function testDropzoneDoesNotNestButtonSemantics() {
  const page = loadPageScript();
  assert.match(page.html, /class="dropzone" id="dropzone" role="group"/);
  assert.doesNotMatch(page.html, /dropzone\.addEventListener\("keydown"/);
}

async function main() {
  testTokenOnlyAxonHubInputIsDetected();
  testRefreshableInputPreservesExpiryAcrossFormats();
  testLastRefreshIsPreserved();
  testBatchConversionPreservesAllSub2apiAccounts();
  testFormatValidationReportsMissingFields();
  testAllFormatsProduceJson();
  await testFileInputCanSelectTheSameFileAgain();
  testNetworkIsBlockedByCsp();
  testDropzoneDoesNotNestButtonSemantics();
  console.log("convert-session tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
