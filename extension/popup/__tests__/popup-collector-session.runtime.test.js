const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    this.options = [];
    this.selectedIndex = 0;
    this.value = "";
    this._innerHTML = "";
    this._textContent = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  appendChild(child) {
    this.children.push(child);
    if (this.tagName === "SELECT") this.options.push(child);
    return child;
  }

  querySelector() {
    if (!this._nested) this._nested = new FakeElement("span");
    return this._nested;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this.tagName === "SELECT") this.options = [];
  }

  get textContent() {
    return [
      this._textContent,
      this._innerHTML,
      ...this.children.map((child) => child.textContent),
    ].join("");
  }

  set textContent(value) {
    this._textContent = String(value || "");
    this._innerHTML = "";
    this.children = [];
  }
}

class FakeDocument {
  constructor() {
    this.title = "__BRAND_DISPLAY_NAME__";
    this.body = new FakeElement("body");
    this.elements = new Map();
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      const tagName = id === "store-select" ? "select" : "div";
      this.elements.set(id, new FakeElement(tagName, id));
    }
    return this.elements.get(id);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createTreeWalker() {
    return {
      currentNode: null,
      nextNode() {
        return false;
      },
    };
  }

  querySelectorAll() {
    return [];
  }
}

const popupSource = fs.readFileSync(
  path.resolve(__dirname, "../popup.js"),
  "utf8",
);
const sellerStatusControllerSource = fs.readFileSync(
  path.resolve(__dirname, "../../lib/seller-context-status-controller.js"),
  "utf8",
);
const document = new FakeDocument();
const actions = [];
const intervals = [];
const clearedIntervals = [];
const windowListeners = new Map();
let sellerCompanyId = "2681910";
const activeProductTab = {
  id: 73,
  url: "https://www.ozon.ru/product/collector-session-product-123/",
};

const chrome = {
  runtime: {
    getURL: (relativePath) => `chrome-extension://runtime-test/${relativePath}`,
    sendMessage(payload, callback) {
      actions.push(payload.action);
      const responses = {
        getAuth: {
          ok: true,
          data: {
            authenticated: true,
            accountId: "account-a",
            expiresAt: "2026-07-30T20:00:00.000Z",
            backendUrl: "http://127.0.0.1:3000/api",
          },
        },
        getSellerContextStatus: {
          ok: true,
          data: {
            status: "READY",
            companyId: sellerCompanyId,
            observedAt: 1785528000000,
          },
        },
        // These responses model the missing Web bearer and Seller cookie.
        // Correct popup startup must never request either capability.
        getStores: { ok: false, error: "[401] Unauthorized" },
        checkSellerCookies: {
          ok: true,
          data: { has_cookies: false, sellerCompanyIds: [] },
        },
        getCollectCount: { ok: true, data: { total: 0 } },
        getProductStatusCounts: { ok: true, data: {} },
        listFollowSellTasks: { ok: true, data: { items: [] } },
        getUpdateInfo: {
          ok: true,
          data: { hasUpdate: false, currentVersion: "0.13.46.1" },
        },
        openFrontend: {
          ok: true,
          data: { opened: true, reused: true, tabId: 17 },
        },
      };
      callback(responses[payload.action] || { ok: true, data: {} });
    },
  },
  tabs: {
    async query(query) {
      if (query?.active) return [activeProductTab];
      return [];
    },
    async sendMessage() {
      return { ok: true };
    },
    async create() {},
    async update() {},
  },
  windows: {
    async create() {},
    async update() {},
  },
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {},
    },
    onChanged: {
      addListener() {},
    },
  },
};

const runtimeContext = {
  chrome,
  console,
  document,
  Intl,
  navigator: {
    language: "zh-CN",
    hardwareConcurrency: 8,
    platform: "MacIntel",
    userAgent: "Chrome runtime test",
  },
  NodeFilter: { SHOW_TEXT: 4 },
  URL,
  alert() {},
  setTimeout,
  clearTimeout,
  setInterval(listener) {
    intervals.push(listener);
    return intervals.length;
  },
  clearInterval(id) {
    clearedIntervals.push(id);
  },
  window: {
    screen: { width: 1440, height: 900, colorDepth: 24 },
    close() {},
    confirm: () => true,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
  },
};
vm.runInNewContext(sellerStatusControllerSource, runtimeContext, {
  filename: "seller-context-status-controller.js",
});
vm.runInNewContext(popupSource, runtimeContext, { filename: "popup.js" });

setTimeout(async () => {
  const loginView = document.getElementById("login-view");
  const mainView = document.getElementById("main-view");
  const signals = document.getElementById("signals");
  const captureCard = signals.children.find((card) =>
    card.textContent.includes("采集当前商品"));
  const captureButton = captureCard?.children.find((child) =>
    child.tagName === "BUTTON");

  assert.equal(loginView.style.display, "none");
  assert.equal(mainView.classList.contains("active"), true);
  assert.ok(captureCard, "valid Collector session should render the page-capture CTA");
  assert.equal(captureButton?.disabled, false, "page-capture CTA must remain enabled");
  const sellerStatus = document.getElementById("seller-context-status");
  assert.match(sellerStatus.textContent, /Seller 已识别/);
  assert.match(sellerStatus.textContent, /2681910/);
  assert.doesNotMatch(sellerStatus.textContent, /Cookie|token|SELLER_CONTEXT_REQUIRED/);
  assert.equal(actions.includes("getSellerContextStatus"), true);
  assert.equal(intervals.length, 1, "popup must refresh Seller status on a bounded interval");
  sellerCompanyId = "7311458";
  intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actions.filter((action) => action === "getSellerContextStatus").length, 2);
  assert.match(sellerStatus.textContent, /Seller 已识别.*7311458.*Seller 店铺已切换/,
    "READY-to-READY company changes must show an explicit switch notice");
  await new Promise((resolve) => setTimeout(resolve, 3_050));
  assert.doesNotMatch(sellerStatus.textContent, /Seller 店铺已切换/,
    "Seller switch notice must clear after its three-second timer");
  await document.getElementById("logout-btn").listeners.get("click")();
  assert.deepEqual(clearedIntervals, [1], "logout must stop Seller status polling immediately");
  await document.getElementById("collector-auth-recheck-btn").listeners.get("click")();
  assert.equal(intervals.length, 2, "a restored Collector session must restart Seller polling once");
  await document.getElementById("web-login-btn").listeners.get("click")();
  assert.equal(
    document.getElementById("login-tip").textContent,
    "Web 登录页已打开，请完成登录后重新打开扩展",
    "opening the Web page must report an honest foreground result without claiming authentication",
  );
  windowListeners.get("unload")?.();
  assert.deepEqual(clearedIntervals, [1, 2], "popup unload must clear Seller status polling");
  assert.equal(actions.includes("getStores"), false, "popup must not use the Web bearer store API");
  assert.equal(
    actions.includes("checkSellerCookies"),
    false,
    "popup startup must not inspect Seller cookies",
  );
  assert.equal(
    actions.includes("syncSellerCookies"),
    false,
    "popup must not sync Seller cookies",
  );
  assert.ok(actions.includes("getAuth"), "Collector session must remain the login authority");
  console.log("popup Collector-session runtime passed");
}, 30);
