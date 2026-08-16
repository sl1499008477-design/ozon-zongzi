const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
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
    this.attributes = new Map();
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

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
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
      const tagName = id === "store-select"
        ? "select"
        : id.endsWith("-btn")
          ? "button"
          : "div";
      const element = new FakeElement(tagName, id);
      this.elements.set(id, element);
      if (id === "web-login-btn" || id === "collector-auth-recheck-btn") {
        const svg = new FakeElement("svg");
        const labelId = id === "web-login-btn"
          ? "web-login-label"
          : "collector-auth-recheck-label";
        const label = new FakeElement("span", labelId);
        label.textContent = id === "web-login-btn" ? "前往登录" : "重新检查";
        this.elements.set(labelId, label);
        element.appendChild(svg);
        element.appendChild(label);
      }
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

const popupSource = fs.readFileSync(path.resolve(__dirname, "../popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.resolve(__dirname, "../popup.html"), "utf8");
const sellerStatusControllerSource = fs.readFileSync(
  path.resolve(__dirname, "../../lib/seller-context-status-controller.js"),
  "utf8",
);

const status = (phase, publicCode = "", overrides = {}) => ({
  version: 1,
  phase,
  generationId: "collector-generation-1234",
  startedAt: new Date(Date.now() - 4_500).toISOString(),
  updatedAt: new Date().toISOString(),
  attemptNumber: 0,
  nextRetryAt: "",
  publicCode,
  account: null,
  expiresAt: "",
  ...overrides,
});

const authenticatedStatus = (accountId, generationId = `generation-${accountId}-1234`) => status(
  "AUTHENTICATED",
  "",
  {
    generationId,
    account: { id: accountId, displayName: `账号 ${accountId}` },
    expiresAt: "2026-09-30T20:00:00.000Z",
  },
);

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createHarness = ({
  initialStatus = status("WAITING_FOR_WEB", "WEB_LOGIN_REQUIRED"),
  authenticated = false,
  delayOpen = false,
  delayStatus = false,
  delayedActions = [],
} = {}) => {
  const document = new FakeDocument();
  const messages = [];
  const intervals = [];
  const clearedIntervals = [];
  const storageListeners = [];
  const removedStorageListeners = [];
  const windowListeners = new Map();
  const delayedActionSet = new Set(delayedActions);
  const delayedCallbacks = new Map();
  const createdTabs = [];
  let sellerCompanyId = "2681910";
  let openCallback = null;
  let statusCallback = null;

  const chrome = {
    runtime: {
      getURL: (relativePath) => `chrome-extension://runtime-test/${relativePath}`,
      sendMessage(payload, callback) {
        messages.push(payload);
        if (payload.action === "openFrontend" && delayOpen) {
          openCallback = callback;
          return;
        }
        if (payload.action === "getCollectorAuthStatus" && delayStatus) {
          statusCallback = callback;
          return;
        }
        if (delayedActionSet.has(payload.action)) {
          const callbacks = delayedCallbacks.get(payload.action) || [];
          callbacks.push(callback);
          delayedCallbacks.set(payload.action, callbacks);
          return;
        }
        const responses = {
          getCollectorAuthStatus: { ok: true, data: initialStatus },
          retryCollectorAuth: { ok: true, data: { requested: 1 } },
          getAuth: {
            ok: true,
            data: {
              authenticated,
              account: authenticated ? { id: "account-a", displayName: "账号 A" } : null,
              expiresAt: authenticated ? "2026-09-30T20:00:00.000Z" : "",
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
        if (query?.active) {
          return [{
            id: 73,
            url: "https://www.ozon.ru/product/collector-session-product-123/",
          }];
        }
        return [];
      },
      async sendMessage() {
        return { ok: true };
      },
      async create(input) {
        createdTabs.push(input);
      },
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
      session: {
        async get() {
          return { sonliCollectorAuthStatus: initialStatus };
        },
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
        removeListener(listener) {
          removedStorageListeners.push(listener);
        },
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

  return {
    document,
    intervals,
    clearedIntervals,
    createdTabs,
    messages,
    removedStorageListeners,
    storageListeners,
    setSellerCompanyId(value) {
      sellerCompanyId = value;
    },
    emitStatus(nextStatus) {
      for (const listener of storageListeners) {
        listener({
          sonliCollectorAuthStatus: { oldValue: initialStatus, newValue: nextStatus },
        }, "session");
      }
      initialStatus = nextStatus;
    },
    resolveOpen(response = { ok: true, data: { opened: true } }) {
      assert.ok(openCallback, "openFrontend must be pending");
      const callback = openCallback;
      openCallback = null;
      callback(response);
    },
    resolveStatus(response = { ok: true, data: initialStatus }) {
      assert.ok(statusCallback, "getCollectorAuthStatus must be pending");
      const callback = statusCallback;
      statusCallback = null;
      callback(response);
    },
    delayedCount(action) {
      return delayedCallbacks.get(action)?.length || 0;
    },
    resolveAction(action, response) {
      const callbacks = delayedCallbacks.get(action) || [];
      assert.ok(callbacks.length > 0, `${action} must be pending`);
      callbacks.shift()(response);
    },
    unload() {
      windowListeners.get("unload")?.();
    },
  };
};

test("login progress is a polite live region", () => {
  assert.match(
    popupHtml,
    /<div class="login-tip" id="login-tip" aria-live="polite"><\/div>/,
  );
  assert.match(popupHtml, /<span id="web-login-label">前往登录<\/span>/);
  assert.match(popupHtml, /<span id="collector-auth-recheck-label">重新检查<\/span>/);
});

test("popup initializes from the privileged status and subscribes once", async (t) => {
  const harness = createHarness();
  t.after(() => harness.unload());
  await settle();

  assert.equal(
    harness.messages.filter(({ action }) => action === "getCollectorAuthStatus").length,
    1,
  );
  assert.equal(harness.storageListeners.length, 1);
  assert.equal(harness.document.getElementById("login-tip").textContent, "等待 Web 端登录");
  assert.equal(harness.document.getElementById("web-login-btn").textContent, "前往登录");
  assert.equal(harness.document.getElementById("collector-auth-recheck-btn").textContent, "重新检查");
  assert.equal(
    harness.document.getElementById("web-login-btn").children.some(({ tagName }) => tagName === "SVG"),
    true,
  );
  assert.equal(
    harness.messages.some(({ action }) => action === "requestCollectorAuth"),
    false,
  );
});

test("all in-progress phases render exact closed copy and button states", async (t) => {
  const harness = createHarness();
  t.after(() => harness.unload());
  await settle();
  const tip = harness.document.getElementById("login-tip");
  const loginButton = harness.document.getElementById("web-login-btn");
  const retryButton = harness.document.getElementById("collector-auth-recheck-btn");

  const cases = [
    [status("DISCOVERING_WEB"), "正在检测 Web 登录状态", true],
    [status("REQUESTING_TICKET"), "正在获取登录授权", true],
    [status("EXCHANGING"), "正在连接采集服务 · 已等待 4 秒", true],
  ];
  for (const [nextStatus, expectedCopy, buttonsDisabled] of cases) {
    harness.emitStatus(nextStatus);
    assert.equal(tip.textContent, expectedCopy);
    assert.equal(loginButton.disabled, buttonsDisabled);
    assert.equal(retryButton.disabled, buttonsDisabled);
  }

  harness.emitStatus(status("WAITING_FOR_WEB", "WEB_TAB_UNAVAILABLE"));
  assert.equal(tip.textContent, "未检测到 Web 管理后台，请先打开登录页");
});

test("retry wait counts down and immediate retry dispatches only the privileged action", async (t) => {
  const harness = createHarness();
  t.after(() => harness.unload());
  await settle();
  harness.emitStatus(status("RETRY_WAIT", "LOCAL_SERVICE_UNAVAILABLE", {
    attemptNumber: 2,
    nextRetryAt: new Date(Date.now() + 4_500).toISOString(),
  }));

  const tip = harness.document.getElementById("login-tip");
  const retryButton = harness.document.getElementById("collector-auth-recheck-btn");
  assert.equal(tip.textContent, "连接暂时不稳定，将在 5 秒后自动重试");
  assert.equal(retryButton.textContent, "立即重试");
  assert.equal(retryButton.disabled, false);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(tip.textContent, "连接暂时不稳定，将在 4 秒后自动重试");

  await retryButton.listeners.get("click")();
  assert.equal(
    harness.messages.filter(({ action }) => action === "retryCollectorAuth").length,
    1,
  );
  assert.equal(
    harness.messages.some(({ action }) => action === "requestCollectorAuth"),
    false,
  );
});

test("action-required public codes map to Chinese copy without raw-field leakage", async (t) => {
  const harness = createHarness();
  t.after(() => harness.unload());
  await settle();
  const tip = harness.document.getElementById("login-tip");
  const cases = [
    ["ACCOUNT_DISABLED", "当前账号已停用，请联系管理员"],
    ["ACCOUNT_EXPIRED", "当前账号已过期，请在 Web 管理后台续期或切换账号"],
    ["PERMISSION_DENIED", "当前账号无采集权限，请联系管理员"],
    ["TRUST_BOUNDARY_REJECTED", "登录校验未通过，请重新打开 Web 登录页"],
    ["SERVER_UPGRADE_REQUIRED", "当前版本暂不兼容，请更新本地服务和扩展"],
  ];
  for (const [publicCode, expectedCopy] of cases) {
    harness.emitStatus(status("ACTION_REQUIRED", publicCode));
    assert.equal(tip.textContent, expectedCopy);
    assert.doesNotMatch(
      harness.document.body.textContent + tip.textContent,
      /Bearer|secret|INTERNAL_DATABASE_FAILURE|private name|ACCOUNT_|PERMISSION_|TRUST_|SERVER_/,
    );
  }

  harness.emitStatus(status("UNKNOWN_PHASE", "RAW_SERVER_FAILURE", {
    message: "database password leaked",
  }));
  assert.equal(tip.textContent, "本地服务暂时不可用，请稍后重试");
  assert.doesNotMatch(tip.textContent, /RAW_SERVER_FAILURE|database|password/);
});

test("malformed tuples in every phase family fail closed and never authenticate", async (t) => {
  const harness = createHarness({ authenticated: true });
  t.after(() => harness.unload());
  await settle();
  const tip = harness.document.getElementById("login-tip");
  const authCallsBefore = harness.messages.filter(({ action }) => action === "getAuth").length;
  const malformed = [
    status("WAITING_FOR_WEB", "LOCAL_SERVICE_UNAVAILABLE"),
    status("DISCOVERING_WEB", "WEB_LOGIN_REQUIRED"),
    status("REQUESTING_TICKET", "", { generationId: "short" }),
    status("EXCHANGING", "", { startedAt: "not-a-date" }),
    status("RETRY_WAIT", "LOCAL_SERVICE_UNAVAILABLE", {
      attemptNumber: 0,
      nextRetryAt: new Date(Date.now() + 4_500).toISOString(),
    }),
    status("RETRY_WAIT", "LOCAL_SERVICE_UNAVAILABLE", {
      attemptNumber: 1,
      nextRetryAt: "invalid-countdown",
    }),
    status("RETRY_WAIT", "LOCAL_SERVICE_UNAVAILABLE", {
      attemptNumber: 1,
      updatedAt: new Date(Date.now() - 2_000).toISOString(),
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
    }),
    status("ACTION_REQUIRED", ""),
    authenticatedStatus("account-a", "short"),
    status("AUTHENTICATED", "SERVER_UPGRADE_REQUIRED", {
      account: { id: "account-a", displayName: "账号 A" },
      expiresAt: "2026-09-30T20:00:00.000Z",
    }),
    status("AUTHENTICATED", "", {
      account: { id: "account-a", displayName: "账号 A", role: "owner" },
      expiresAt: "2026-09-30T20:00:00.000Z",
    }),
    status("AUTHENTICATED", "", {
      account: { id: "account-a", displayName: "账号 A" },
      expiresAt: "2020-01-01T00:00:00.000Z",
    }),
    { ...status("DISCOVERING_WEB"), rawError: "Bearer secret" },
  ];

  for (const malformedStatus of malformed) {
    harness.emitStatus(malformedStatus);
    assert.equal(tip.textContent, "本地服务暂时不可用，请稍后重试");
    assert.equal(harness.document.getElementById("main-view").classList.contains("active"), false);
  }
  assert.equal(
    harness.messages.filter(({ action }) => action === "getAuth").length,
    authCallsBefore,
  );
});

test("a malformed authenticated initial snapshot never initializes the main view", async (t) => {
  const malformedAuth = {
    ...authenticatedStatus("account-a"),
    expiresAt: "not-an-expiry",
    token: "collector-secret",
  };
  const harness = createHarness({ initialStatus: malformedAuth, authenticated: true });
  t.after(() => harness.unload());
  await settle();

  assert.equal(harness.document.getElementById("login-tip").textContent, "本地服务暂时不可用，请稍后重试");
  assert.equal(harness.document.getElementById("main-view").classList.contains("active"), false);
  assert.equal(harness.messages.some(({ action }) => action === "getAuth"), false);
});

test("opening login disables the primary button and never asks to reopen the extension", async (t) => {
  const harness = createHarness({ delayOpen: true });
  t.after(() => harness.unload());
  await settle();
  const button = harness.document.getElementById("web-login-btn");
  const click = button.listeners.get("click")();

  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "正在打开 Web 登录页…");
  assert.equal(button.children.some(({ tagName }) => tagName === "SVG"), true);
  assert.equal(harness.document.getElementById("login-tip").textContent, "正在打开 Web 登录页…");
  harness.resolveOpen();
  await click;

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "前往登录");
  assert.equal(button.children.some(({ tagName }) => tagName === "SVG"), true);
  assert.equal(harness.document.getElementById("login-tip").textContent, "等待 Web 端登录");
  assert.doesNotMatch(harness.document.getElementById("login-tip").textContent, /重新打开扩展/);
});

test("a newer storage status wins over a late open failure", async (t) => {
  const harness = createHarness({ delayOpen: true });
  t.after(() => harness.unload());
  await settle();
  const button = harness.document.getElementById("web-login-btn");
  const click = button.listeners.get("click")();
  harness.emitStatus(status("REQUESTING_TICKET"));
  harness.resolveOpen({ ok: false });
  await click;

  assert.equal(harness.document.getElementById("login-tip").textContent, "正在获取登录授权");
  assert.equal(button.disabled, true);
  assert.equal(button.children.some(({ tagName }) => tagName === "SVG"), true);
  assert.doesNotMatch(harness.document.getElementById("login-tip").textContent, /无法打开/);
});

test("an open failure after unload cannot mutate DOM or restart lifecycle work", async () => {
  const harness = createHarness({ delayOpen: true });
  await settle();
  const click = harness.document.getElementById("web-login-btn").listeners.get("click")();
  harness.unload();
  const copyAtUnload = harness.document.getElementById("login-tip").textContent;
  const labelAtUnload = harness.document.getElementById("web-login-label").textContent;
  harness.resolveOpen({ ok: false });
  await click;

  assert.equal(harness.document.getElementById("login-tip").textContent, copyAtUnload);
  assert.equal(harness.document.getElementById("web-login-label").textContent, labelAtUnload);
  assert.equal(harness.intervals.length, 0);
});

test("authenticated storage transition switches immediately and preserves the main view", async (t) => {
  const harness = createHarness({ authenticated: true });
  t.after(() => harness.unload());
  await settle();
  harness.emitStatus(status("AUTHENTICATED", "", {
    account: { id: "account-a", displayName: "测试账号" },
    expiresAt: "2026-09-30T20:00:00.000Z",
  }));

  assert.equal(harness.document.getElementById("login-view").style.display, "none");
  assert.equal(harness.document.getElementById("main-view").classList.contains("active"), true);
  await settle();

  const signals = harness.document.getElementById("signals");
  const captureCard = signals.children.find((card) => card.textContent.includes("采集当前商品"));
  const captureButton = captureCard?.children.find((child) => child.tagName === "BUTTON");
  assert.ok(captureCard, "valid Collector session should render the page-capture CTA");
  assert.equal(captureButton?.disabled, false, "page-capture CTA must remain enabled");
  const sellerStatus = harness.document.getElementById("seller-context-status");
  assert.match(sellerStatus.textContent, /Seller 已识别/);
  assert.match(sellerStatus.textContent, /2681910/);
  assert.doesNotMatch(sellerStatus.textContent, /Cookie|token|SELLER_CONTEXT_REQUIRED/);
  assert.equal(harness.intervals.length, 1, "Seller status keeps its bounded refresh interval");

  harness.setSellerCompanyId("7311458");
  harness.intervals[0]();
  await settle();
  assert.match(sellerStatus.textContent, /Seller 已识别.*7311458.*Seller 店铺已切换/);
  await new Promise((resolve) => setTimeout(resolve, 3_050));
  assert.doesNotMatch(sellerStatus.textContent, /Seller 店铺已切换/);

  await harness.document.getElementById("logout-btn").listeners.get("click")();
  assert.deepEqual(harness.clearedIntervals, [1]);
  assert.equal(harness.messages.some(({ action }) => action === "getStores"), false);
  assert.equal(harness.messages.some(({ action }) => action === "checkSellerCookies"), false);
  assert.equal(harness.messages.some(({ action }) => action === "syncSellerCookies"), false);
  assert.equal(harness.messages.some(({ action }) => action === "getAuth"), true);
});

test("a late initialization snapshot cannot overwrite a newer live status", async (t) => {
  const harness = createHarness({ authenticated: true, delayStatus: true });
  t.after(() => harness.unload());
  const authenticatedStatus = status("AUTHENTICATED", "", {
    account: { id: "account-a", displayName: "测试账号" },
    expiresAt: "2026-09-30T20:00:00.000Z",
  });

  harness.emitStatus(authenticatedStatus);
  assert.equal(harness.document.getElementById("main-view").classList.contains("active"), true);
  harness.resolveStatus({
    ok: true,
    data: status("WAITING_FOR_WEB", "WEB_LOGIN_REQUIRED"),
  });
  await settle();

  assert.equal(harness.document.getElementById("main-view").classList.contains("active"), true);
  assert.equal(harness.document.getElementById("login-view").style.display, "none");
});

test("AUTH A stale async work cannot block or mutate AUTH B initialization", async (t) => {
  const harness = createHarness({
    delayedActions: ["getAuth", "getCollectCount", "getProductStatusCounts"],
  });
  t.after(() => harness.unload());
  await settle();

  harness.emitStatus(authenticatedStatus("account-a", "generation-account-a"));
  assert.equal(harness.delayedCount("getAuth"), 1);
  harness.resolveAction("getAuth", {
    ok: true,
    data: {
      authenticated: true,
      account: { id: "account-a", displayName: "账号 A" },
      expiresAt: "2026-09-30T20:00:00.000Z",
      backendUrl: "https://qh.jizhangerp.com/api",
    },
  });
  await settle();
  assert.equal(harness.delayedCount("getCollectCount"), 1);
  assert.equal(harness.delayedCount("getProductStatusCounts"), 1);

  harness.emitStatus(status("WAITING_FOR_WEB", "WEB_LOGIN_REQUIRED"));
  harness.emitStatus(authenticatedStatus("account-b", "generation-account-b"));
  assert.equal(harness.delayedCount("getAuth"), 1, "AUTH B must start without waiting for AUTH A");
  harness.resolveAction("getAuth", {
    ok: true,
    data: {
      authenticated: true,
      account: { id: "account-b", displayName: "账号 B" },
      expiresAt: "2026-09-30T20:00:00.000Z",
      backendUrl: "http://127.0.0.1:3000/api",
    },
  });
  await settle();
  assert.equal(harness.delayedCount("getCollectCount"), 2);
  assert.equal(harness.delayedCount("getProductStatusCounts"), 2);

  harness.resolveAction("getCollectCount", { ok: true, data: { total: 99 } });
  harness.resolveAction("getProductStatusCounts", { ok: true, data: { ALL: 99 } });
  await settle();
  assert.notEqual(harness.document.getElementById("nav-badge-collect").textContent, "99");
  assert.notEqual(harness.document.getElementById("nav-badge-products").textContent, "99");

  harness.resolveAction("getCollectCount", { ok: true, data: { total: 0 } });
  harness.resolveAction("getProductStatusCounts", { ok: true, data: {} });
  await settle();
  assert.equal(harness.intervals.length, 1, "only AUTH B may start Seller polling");
  assert.equal(
    harness.messages.filter(({ action }) => action === "getSellerContextStatus").length,
    1,
  );

  harness.document.getElementById("download-update-btn").listeners.get("click")();
  assert.equal(harness.createdTabs.at(-1)?.url, "http://127.0.0.1:3000/extension");
});

test("unload removes the one storage listener and clears authentication display timers", async () => {
  const harness = createHarness();
  await settle();
  harness.emitStatus(status("RETRY_WAIT", "LOCAL_SERVICE_UNAVAILABLE", {
    attemptNumber: 1,
    nextRetryAt: new Date(Date.now() + 4_500).toISOString(),
  }));
  harness.unload();

  assert.equal(harness.removedStorageListeners.length, 1);
  const copyAtUnload = harness.document.getElementById("login-tip").textContent;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(harness.document.getElementById("login-tip").textContent, copyAtUnload);
});
