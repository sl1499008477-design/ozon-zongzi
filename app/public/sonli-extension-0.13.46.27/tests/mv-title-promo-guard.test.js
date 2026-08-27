// 合并卡角标标题污染防线(BR_attribute_advertising / attr 22508 事故回归):
// 1. 行为测试:vm 沙箱真跑 shared-utils.js,验证 jzStripPromo 短语剥净、
//    jzIsPromoResidualTitle 残词判定、jzPreferSourceName 污染切 sv 真名。
// 2. 接线测试:ozon-product.js MV 面板提交/渲染/源数据回填三处必须接上防线
//    (字符串断言,防止后续重构悄悄退回 DOM 优先旧逻辑)。
// 运行:node tests/mv-title-promo-guard.test.js (extension/ 目录下)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const extensionRoot = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(extensionRoot, rel), "utf8");

// ── vm 沙箱加载 shared-utils.js(content script,挂 window)──
function loadSharedUtils() {
  const loc = { hostname: "www.ozon.ru", href: "https://www.ozon.ru/", pathname: "/", search: "" };
  const doc = {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
    documentElement: {},
  };
  const chromeStub = {
    storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} }, onChanged: { addListener: () => {} } },
    runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, getURL: () => "", id: "test" },
  };
  const histStub = { pushState: () => {}, replaceState: () => {} };
  const windowObj = { location: loc, document: doc, addEventListener: () => {}, navigator: {}, isSecureContext: true, history: histStub };
  const sandbox = {
    window: windowObj, document: doc, chrome: chromeStub, navigator: {}, location: loc, history: histStub,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
    MutationObserver: function () { this.observe = () => {}; },
    CustomEvent: function () {},
    dispatchEvent: () => {},
    fetch: () => Promise.reject(new Error("no fetch in test")),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(read("content/shared-utils.js"), sandbox, { filename: "shared-utils.js" });
  return windowObj;
}

const w = loadSharedUtils();

// ── jzStripPromo:「Скидки недели」整短语必须剥净,不能留孤儿「недели」──
assert.strictEqual(w.jzStripPromo("0% до 140 днейСкидки недели"), "");
assert.strictEqual(w.jzStripPromo("0% до 140 днейНовинка"), "");
assert.strictEqual(w.jzStripPromo("Скидки недели"), "");
assert.strictEqual(w.jzStripPromo("Скидка недели"), "");
assert.strictEqual(w.jzStripPromo("Новинка Ободок-платок треугольный"), "Ободок-платок треугольный");
// 正常标题不动
assert.strictEqual(w.jzStripPromo("Футболка 100% хлопок"), "Футболка 100% хлопок");
assert.strictEqual(w.jzStripPromo("Управление новинками склада"), "Управление новинками склада");

// ── jzIsPromoResidualTitle:剥后剩空/碎词 = 整串是角标 ──
assert.strictEqual(w.jzIsPromoResidualTitle("0% до 140 днейСкидки недели", ""), true);
// 旧正则时代的残词场景(只剥掉「Скидки」剩「недели」)也要能判出来
assert.strictEqual(w.jzIsPromoResidualTitle("0% до 140 днейСкидки недели", "недели"), true);
assert.strictEqual(w.jzIsPromoResidualTitle("Ободок-платок треугольный", "Ободок-платок треугольный"), false);
assert.strictEqual(
  w.jzIsPromoResidualTitle("Новинка Ободок-платок треугольный", "Ободок-платок треугольный"),
  false,
);
assert.strictEqual(w.jzIsPromoResidualTitle("", ""), false);

// ── jzPreferSourceName:角标 DOM → sv 真名;翻译中文 DOM → sv;干净 DOM 优先 ──
assert.strictEqual(
  w.jzPreferSourceName("Кроссовки Nike Air", "0% до 140 днейСкидки недели"),
  "Кроссовки Nike Air",
);
assert.strictEqual(w.jzPreferSourceName("Кроссовки Nike Air", "耐克运动鞋"), "Кроссовки Nike Air");
assert.strictEqual(w.jzPreferSourceName("Кроссовки Nike Air", "Кеды женские белые"), "Кеды женские белые");
assert.strictEqual(w.jzPreferSourceName("Кроссовки Nike Air", ""), "Кроссовки Nike Air");

// ── MV 面板提交路径接线(handleMultiVariantFollowSell items 构造段)──
const ozonProduct = read("content/ozon-product.js");
assert(
  ozonProduct.includes("window.jzPreferSourceName(sourceName, domName)"),
  "MV submit must route un-edited titles through jzPreferSourceName (sv 4180 first on pollution)",
);
assert(
  ozonProduct.includes("window.jzIsPromoResidualTitle?.(rawName, strippedName)"),
  "MV submit must run the final jzStripPromo + residual guard on the chosen name",
);
assert(
  /const titleEdited = !!domName && !!_baseTitle && domName !== _baseTitle;/.test(ozonProduct),
  "MV submit must detect template/manual edits against the rendered baseline",
);

// ── MV 面板渲染接线:清洗后标题 + data-jz-base-title 基线 ──
assert(
  ozonProduct.includes('data-jz-base-title="${_escHtml(displayTitle)}"'),
  "MV render must stamp the rendered baseline for edit detection",
);
assert(
  ozonProduct.includes("_escHtml(displayTitle) || '-'"),
  "MV render must display the promo-stripped title, not raw v.title",
);

// ── 源数据回填接线:_fixPollutedTitle 在 _applySourcePlaceholders 里生效 ──
assert(
  ozonProduct.includes("const _fixPollutedTitle = (i, d) =>"),
  "panel must define _fixPollutedTitle to swap badge titles for sv real names",
);
assert(
  ozonProduct.includes("_fixPollutedTitle(i, d);"),
  "_applySourcePlaceholders must invoke _fixPollutedTitle per variant",
);

console.log("mv-title-promo-guard.test.js: all assertions passed");
