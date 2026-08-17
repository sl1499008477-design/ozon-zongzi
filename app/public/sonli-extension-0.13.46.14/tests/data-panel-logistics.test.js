const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const sharedUtilsSource = fs.readFileSync(
  path.join(extensionRoot, "content", "shared-utils.js"),
  "utf8",
);
const productPageSource = fs.readFileSync(
  path.join(extensionRoot, "content", "ozon-product.js"),
  "utf8",
);

function loadSharedUtils() {
  const location = {
    hostname: "www.ozon.ru",
    href: "https://www.ozon.ru/",
    pathname: "/",
    search: "",
  };
  const document = {
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {} },
      setAttribute() {},
      appendChild() {},
    }),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    documentElement: {},
  };
  const chrome = {
    storage: {
      local: {
        get: (_key, callback) => callback?.({}),
        set() {},
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage() {},
      onMessage: { addListener() {} },
      getURL: () => "",
      id: "test",
    },
  };
  const history = { pushState() {}, replaceState() {} };
  const window = {
    location,
    document,
    history,
    navigator: {},
    isSecureContext: true,
    addEventListener() {},
  };
  const sandbox = {
    window,
    document,
    chrome,
    location,
    history,
    navigator: {},
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
  vm.runInNewContext(sharedUtilsSource, sandbox, { filename: "shared-utils.js" });
  return window;
}

const windowObj = loadSharedUtils();

assert.equal(windowObj.jzReturnRateFromRedemption(92), 8);
assert.equal(windowObj.jzReturnRateFromRedemption("100"), 0);
assert.equal(windowObj.jzReturnRateFromRedemption(-1), null);
assert.equal(windowObj.jzReturnRateFromRedemption(101), null);
assert.equal(windowObj.jzReturnRateFromRedemption("bad"), null);
assert.equal(windowObj.jzFormatRating(4.8, 123), "4.8 (123)");
assert.equal(windowObj.jzFormatRating(4.8, 0), "4.8");
assert.equal(windowObj.jzFormatRating("bad", 3), null);
assert.equal(
  sharedUtilsSource.includes("ozon-helper-rating-star"),
  false,
  "rating rendering must not emit a star span",
);
assert.equal(
  productPageSource.includes("ozon-helper-rating-star"),
  false,
  "product-page rating rendering must not emit a star span",
);

console.log("data panel logistics and rating formatting passed");
