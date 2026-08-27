const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");

class HtmlNode {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.children = [];
  }

  get textContent() {
    return this.children
      .map((child) => (typeof child === "string" ? child : child.textContent))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }
}

const parseAttributes = (input) => {
  const attributes = {};
  for (const match of input.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
};

const parseHtml = (html) => {
  const root = new HtmlNode("#document");
  const stack = [root];
  const voidTags = new Set(["img", "meta", "link", "input", "br", "hr"]);
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/[A-Za-z][^>]*>|<[A-Za-z][^>]*>|[^<]+/g) || []) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      stack.pop();
    } else if (token.startsWith("<")) {
      const match = token.match(/^<([A-Za-z][^\s/>]*)([\s\S]*?)\/?\s*>$/);
      if (!match) continue;
      const node = new HtmlNode(match[1].toLowerCase(), parseAttributes(match[2]));
      stack.at(-1).children.push(node);
      if (!voidTags.has(node.tagName) && !token.endsWith("/>")) stack.push(node);
    } else {
      stack.at(-1).children.push(token);
    }
  }
  return root;
};

const findAll = (node, predicate, found = []) => {
  if (node instanceof HtmlNode && predicate(node)) found.push(node);
  if (node instanceof HtmlNode) {
    for (const child of node.children) findAll(child, predicate, found);
  }
  return found;
};

class FakeElement {
  constructor(document, tagName) {
    this.document = document;
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.listeners = new Map();
    this._id = "";
    this._innerHTML = "";
  }

  set id(value) {
    this._id = value;
    if (value) this.document.nodes.set(value, this);
  }

  get id() {
    return this._id;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    if (child.id) this.document.nodes.set(child.id, child);
    return child;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  setAttribute() {}
  remove() {}
}

const createDocument = ({ title = "", ids = [] } = {}) => {
  const document = {
    title,
    readyState: "complete",
    nodes: new Map(),
    listeners: new Map(),
    createElement(tagName) {
      return new FakeElement(document, tagName);
    },
    getElementById(id) {
      return document.nodes.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, listener) {
      document.listeners.set(type, listener);
    },
  };
  document.head = new FakeElement(document, "head");
  document.body = new FakeElement(document, "body");
  for (const id of ids) {
    const element = new FakeElement(document, "div");
    element.id = id;
  }
  return document;
};

const runScript = (relativePath, context) => {
  context.globalThis = context;
  context.window = context;
  context.console = { log() {}, warn() {}, error() {} };
  context.addEventListener ||= () => {};
  context.postMessage ||= () => {};
  context.setTimeout = () => 0;
  context.clearTimeout = () => {};
  vm.createContext(context);
  vm.runInContext(read(relativePath), context, { filename: relativePath });
  return context;
};

const runAlibabaWithoutRuntimeBrand = () => {
  const document = createDocument();
  const context = runScript("content/alibaba-1688.js", {
    document,
    location: {
      href: "https://detail.1688.com/offer/123456789.html",
      protocol: "https:",
      origin: "https://detail.1688.com",
    },
    navigator: {},
    chrome: { runtime: { sendMessage(_message, callback) { callback({ ok: false }); } } },
    localStorage: { getItem() { return null; }, setItem() {} },
  });
  const panel = document.getElementById("jzc-1688-panel");
  assert.ok(panel, "1688 detail injection should mount its product panel");
  return { context, panel };
};

const runCnSourceWithoutRuntimeBrand = () => {
  const document = createDocument();
  const context = runScript("lib/cn-source-panel.js", {
    document,
    location: { href: "https://item.taobao.com/item.htm?id=1" },
    navigator: {},
    chrome: { runtime: { getURL: () => "chrome-extension://test/lib/cn-source-debug-page.js" } },
    localStorage: { getItem() { return null; }, setItem() {} },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    postMessage() {},
    open() {},
  });
  context.JZCnSourcePanel.mount({
    platform: { sourceId: "taobao", displayName: "淘宝" },
    buildPayload: () => ({ sku: "1", title: "测试商品" }),
  });
  const panel = document.getElementById("jzc-cn-source-panel");
  assert.ok(panel, "CN source injection should mount its product panel");
  return { context, panel };
};

const runBatchUploadWithoutRuntimeBrand = async () => {
  const document = createDocument({
    title: "ozon 粽子 批量上架",
    ids: ["tb-icon", "hdr-version", "auth-notice", "auth-notice-text"],
  });
  const context = runScript("batch-upload/index.js", {
    document,
    chrome: {
      runtime: {
        lastError: null,
        getManifest: () => ({ version: "0.13.46.1" }),
        sendMessage(_message, callback) { callback({ authenticated: false }); },
      },
      storage: { local: { get(_keys, callback) { callback({}); } } },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { context, document };
};

(async () => {
  const alibaba = runAlibabaWithoutRuntimeBrand();
  assert.match(alibaba.panel.innerHTML, /ozon 粽子/, "1688 fallback panel should display ozon 粽子");

  const cnSource = runCnSourceWithoutRuntimeBrand();
  assert.match(cnSource.panel.innerHTML, /ozon 粽子/, "CN-source fallback panel should display ozon 粽子");

  const batchDocument = parseHtml(read("batch-upload/index.html"));
  assert.equal(
    findAll(batchDocument, (node) => node.tagName === "title")[0]?.textContent,
    "ozon 粽子 批量上架",
    "batch-upload tab title should identify ozon 粽子",
  );
  assert.match(
    batchDocument.textContent,
    /未登录 ozon 粽子[\s\S]*ozon 粽子 Web 管理系统[\s\S]*ozon 粽子 Web 管理系统/,
    "batch-upload help should use the ozon 粽子 product name",
  );

  const batch = await runBatchUploadWithoutRuntimeBrand();
  assert.equal(batch.document.title, "ozon 粽子 批量上架");
  assert.equal(
    batch.document.getElementById("auth-notice-text").textContent,
    "未登录ozon 粽子。请先在扩展弹窗里登录。",
    "batch-upload auth fallback should display ozon 粽子",
  );

  const collectorContext = runScript("background/collector-client.js", {});
  collectorContext.JzCollectorClient.setContext({
    sessionManager: {},
    getDeviceFingerprint: () => "brand-contract-device",
  });
  const authResult = await collectorContext.JzCollectorClient.upload({
    sourceId: "1688",
    collectorOperation: "",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(authResult)),
    {
      ok: false,
      code: "COLLECTOR_AUTH_REQUIRED",
      error: "请先在 ozon 粽子 Web 管理系统登录",
    },
    "collector authentication errors shown by source panels should use ozon 粽子",
  );

  console.log("ozon zongzi fallback brand runtime contract passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
