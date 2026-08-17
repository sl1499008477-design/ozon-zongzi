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

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  hasClass(name) {
    return (this.getAttribute("class") || "").split(/\s+/).includes(name);
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
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/[A-Za-z][^>]*>|<[A-Za-z][^>]*>|[^<]+/g) || [];

  for (const token of tokens) {
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
};

const findAll = (node, predicate, found = []) => {
  if (node instanceof HtmlNode && predicate(node)) found.push(node);
  if (node instanceof HtmlNode) {
    for (const child of node.children) findAll(child, predicate, found);
  }
  return found;
};

const executeDefaultBrand = (relativePath) => {
  const context = {
    chrome: {
      runtime: {
        getURL: (asset) => `chrome-extension://brand-contract/${asset}`,
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(read(relativePath).split("\n", 1)[0], context, { filename: relativePath });
  return JSON.parse(JSON.stringify(context.__JZ_BRAND__));
};

const manifest = JSON.parse(read("manifest.json"));
assert.deepEqual(
  {
    name: manifest.name,
    description: manifest.description,
    action: manifest.action,
  },
  {
    name: "ozon 粽子",
    description: "ozon 粽子 · Ozon 选品采集与运营助手",
    action: {
      default_popup: "popup/popup.html",
      default_title: "ozon 粽子",
    },
  },
  "Chrome should present the ozon 粽子 extension identity",
);

const popup = parseHtml(read("popup/popup.html"));
assert.equal(findAll(popup, (node) => node.tagName === "title")[0]?.textContent, "ozon 粽子");
for (const containerClass of ["logo-area", "header-left"]) {
  const container = findAll(popup, (node) => node.hasClass(containerClass))[0];
  assert.ok(container, `popup should retain the ${containerClass} brand region`);
  const logos = findAll(container, (node) => node.tagName === "img" && node.hasClass("brand-lockup"));
  assert.equal(logos.length, 1, `${containerClass} should render one complete brand logo`);
  assert.equal(logos[0].getAttribute("src"), "../icons/ozon-zongzi-logo-primary.svg");
  assert.equal(logos[0].getAttribute("alt"), "ozon 粽子");
  assert.equal(
    findAll(container, (node) => node.hasClass("logo-text") || node.hasClass("header-title")).length,
    0,
    `${containerClass} should not repeat the wordmark beside the logo`,
  );
}

const pricing = findAll(
  popup,
  (node) => node.tagName === "button" && node.getAttribute("data-action") === "pricing",
)[0];
assert.equal(pricing?.textContent, "ozon 粽子算价");
const cta = findAll(popup, (node) => node.tagName === "button" && node.hasClass("cta"))[0];
assert.equal(cta?.textContent, "打开 ozon 粽子 Web 管理系统");
assert.equal(cta?.getAttribute("aria-label"), "打开 ozon 粽子 Web 管理系统");

for (const relativePath of [
  "background/service-worker.js",
  "content/shared-utils.js",
  "content/ozon-premium-hook.js",
]) {
  const brand = executeDefaultBrand(relativePath);
  assert.deepEqual(
    brand,
    {
      code: "sonli",
      displayName: "ozon 粽子",
      productName: "ozon 粽子",
      primaryColor: "#1268FF",
      apiHost: "127.0.0.1:3000/api",
      webHost: "127.0.0.1:3000",
      logoUrl: "chrome-extension://brand-contract/icons/ozon-zongzi-symbol.svg",
    },
    `${relativePath} should inject the ozon 粽子 display brand while preserving the sonli protocol code`,
  );
}

console.log("ozon zongzi extension brand contract passed");
