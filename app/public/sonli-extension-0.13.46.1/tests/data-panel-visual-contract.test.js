const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(extensionRoot, "content", "shared-utils.js"),
  "utf8",
);

class HtmlNode {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.children = [];
  }

  hasClass(name) {
    return (this.attributes.class || "").split(/\s+/).includes(name);
  }

  get textContent() {
    return this.children
      .map((child) => (typeof child === "string" ? child : child.textContent))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function parseAttributes(input) {
  const attributes = {};
  for (const match of input.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseHtml(html) {
  const root = new HtmlNode("#document");
  const stack = [root];
  const voidTags = new Set(["img", "meta", "link", "input", "br", "hr"]);
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/[A-Za-z][^>]*>|<[A-Za-z][^>]*>|[^<]+/g) || []) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const match = token.match(/^<([A-Za-z][^\s/>]*)([\s\S]*?)\/?\s*>$/);
      if (!match) continue;
      const node = new HtmlNode(match[1].toLowerCase(), parseAttributes(match[2]));
      stack.at(-1).children.push(node);
      if (!voidTags.has(node.tagName) && !token.endsWith("/>")) stack.push(node);
      continue;
    }
    stack.at(-1).children.push(token);
  }
  return root;
}

function findAll(node, predicate, found = []) {
  if (node instanceof HtmlNode && predicate(node)) found.push(node);
  if (node instanceof HtmlNode) {
    for (const child of node.children) findAll(child, predicate, found);
  }
  return found;
}

class FakePanel {
  constructor() {
    this.innerHTML = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.logoImages = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  querySelectorAll(selector) {
    return selector === ".ozon-helper-sidebar-brand-mark img" ? this.logoImages : [];
  }
}

function loadRenderer() {
  const document = {
    readyState: "loading",
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    }),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    documentElement: {},
  };
  const window = {
    document,
    location: { hostname: "www.ozon.ru", href: "https://www.ozon.ru/", pathname: "/", search: "" },
    history: { pushState() {}, replaceState() {} },
    navigator: {},
    isSecureContext: true,
    addEventListener() {},
  };
  const sandbox = {
    window,
    document,
    location: window.location,
    history: window.history,
    navigator: window.navigator,
    chrome: {
      storage: { local: { get: (_key, callback) => callback?.({}), set() {} }, onChanged: { addListener() {} } },
      runtime: { sendMessage() {}, onMessage: { addListener() {}, }, getURL: (asset) => `chrome-extension://test/${asset}`, id: "test" },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: function MutationObserver() { this.observe = () => {}; },
    CustomEvent: function CustomEvent() {},
    dispatchEvent() {},
    fetch: () => Promise.reject(new Error("network is disabled in this test")),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "shared-utils.js" });
  return window;
}

async function renderProductPanel() {
  const window = loadRenderer();
  const panel = new FakePanel();
  const logo = {
    hidden: false,
    parentElement: { classList: { added: [], add(name) { this.added.push(name); } } },
    listener: null,
    addEventListener(type, listener, options) {
      this.listener = { type, listener, options };
    },
  };
  panel.logoImages = [logo];

  window.jzRenderProductPanelV2(panel, {
    sku: "123456789",
    initial: { sales30d: 42, followSellCount: 3, heroSizeMain: "500g" },
  });
  await Promise.resolve();
  return { panel, logo };
}

(async () => {
  const { panel, logo } = await renderProductPanel();
  const html = parseHtml(panel.innerHTML);
  const findByClass = (name) => findAll(html, (node) => node.hasClass(name));
  const findByAction = (name) => findAll(
    html,
    (node) => node.attributes["data-action"] === name,
  );

  assert.equal(findByClass("ozon-helper-sidebar-brand-mark").length, 1, "panel should render the brand mark");
  assert.equal(findByClass("ozon-helper-sidebar-brand-title")[0]?.textContent, "ozon 粽子 · 选品助手");
  assert.equal(findByClass("ozon-helper-sidebar-brand-status")[0]?.textContent, "商品数据已更新");
  assert.equal(findByClass("ozon-helper-sidebar-brand-mark")[0]?.children[0]?.tagName, "img");
  assert.equal(
    findByClass("ozon-helper-sidebar-brand-mark")[0]?.children[0]?.attributes.src,
    "chrome-extension://test/icons/ozon-zongzi-symbol.svg",
  );
  assert.equal(findByAction("open-field-settings").length, 1, "field settings should keep its action contract");
  assert.equal(findByAction("follow-sell").length, 1, "follow action should keep its action contract");
  assert.equal(findByAction("edit-list").length, 1, "edit action should keep its action contract");
  assert.equal(findByAction("collect-one").length, 1, "collect action should keep its action contract");

  for (const field of ["sales30d", "createDate", "heroFollow", "heroSize", "category", "sku", "returnRate", "rating", "dimensions", "volume", "weight"]) {
    assert.ok(
      findAll(html, (node) => node.attributes["data-field"] === field).length,
      `rendered panel should preserve ${field}`,
    );
  }

  assert.equal(logo.listener?.type, "error", "brand image should bind a load-error fallback");
  assert.equal(logo.listener?.options?.once, true, "brand image fallback should run once");
  logo.listener.listener();
  assert.equal(logo.hidden, true, "failed brand image should be hidden");
  assert.deepEqual(logo.parentElement.classList.added, ["is-logo-fallback"]);

  console.log("data panel visual render contract passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
