const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const product = read("content/ozon-product.js");
const productCss = read("content/ozon-product.css");
const search = read("content/ozon-search.js");
const searchCss = read("content/ozon-search.css");
const dataPanel = read("content/ozon-data-panel.js");
const serviceWorker = read("background/service-worker.js");
const sellerBridge = read("content/ozon-seller-bridge.js");
const popupHtml = read("popup/popup.html");
const popupJs = read("popup/popup.js");
const batchHtml = read("batch-upload/index.html");
const batchJs = read("batch-upload/index.js");
const storePicker = read("lib/store-picker.js");
const jizhangerpBridge = read("content/jizhangerp-bridge.js");
const categoryStrategyHandoff = read("lib/category-strategy-handoff.js");
const portalBridgePolicy = read("lib/portal-bridge-policy.js");
const aiWizard = read("content/1688-ai-wizard.js");

assert(!fs.existsSync(path.join(root, "content/ozon-bestsellers-hook.js")));
assert(!manifest.content_scripts.some((entry) =>
  entry.js?.includes("content/ozon-bestsellers-hook.js")
  || entry.matches?.some((match) => match.includes("ozon-bestsellers"))
));
for (const source of [product, productCss, serviceWorker, sellerBridge]) {
  assert(!/选品推荐|recommendation-panel|getRecommendations|fetchBestsellers|reportCategoryMapping|JZC_BESTSELLERS_REPORT/.test(source));
}
assert(!/选品模式/.test(search));
assert(!dataPanel.includes("选品模式"));
assert(manifest.content_scripts.some((entry) => entry.js?.includes("lib/category-strategy-sampling.js")
  && entry.js?.includes("content/ozon-search.js")));
assert(serviceWorker.includes("../lib/category-strategy-sampling.js"));
for (const action of [
  "CATEGORY_STRATEGY_READINESS",
  "CATEGORY_STRATEGY_BROWSER_OPEN",
  "CATEGORY_STRATEGY_SESSION_START",
  "CATEGORY_STRATEGY_SESSION_GET",
  "CATEGORY_STRATEGY_PAGE_FACTS_CAPTURE",
  "CATEGORY_STRATEGY_CARD_FACTS_CAPTURE",
  "CATEGORY_STRATEGY_SELECTIONS_GET",
  "CATEGORY_STRATEGY_SELECTION_REMOVE",
  "CATEGORY_STRATEGY_SAMPLES_CONFIRM",
  "CATEGORY_STRATEGY_SESSION_CANCEL",
]) assert(serviceWorker.includes(action));
assert(serviceWorker.includes("JzCategoryStrategyHandoff.projectBrowserUrl"));
assert(categoryStrategyHandoff.includes("zongziCategoryStrategySession"));
assert(search.includes("zongziCategoryStrategySession"));
assert(search.includes("data-zongzi-category-strategy-sampling"));
assert(search.includes("zongzi-category-strategy-sampling-bar"));
assert(searchCss.includes(".zongzi-category-strategy-sampling-control"));
assert(!searchCss.includes(".ozon-helper-checkbox"));
assert(!searchCss.includes(".ozon-helper-bottom-bar"));

assert(product.includes("一键采集"));
assert(product.includes("利润"));
assert(product.includes("OZON以图搜图"));
assert(search.includes("collect-one"));
assert(search.includes("window.jzRenderProductCardPanel"));
assert(dataPanel.includes("collect-one"));
assert(dataPanel.includes("window.jzRenderProductCardPanel"));
assert(serviceWorker.includes("getCollectCount"));
assert(serviceWorker.includes("getProductStatusCounts"));
assert(sellerBridge.includes("JZC_PREMIUM_QUERY"));

assert(!fs.existsSync(path.join(root, "lib/watermark-templates.js")));
assert(!manifest.content_scripts.some((entry) =>
  entry.js?.includes("lib/watermark-templates.js")
));
for (const source of [
  popupHtml,
  popupJs,
  batchHtml,
  batchJs,
  product,
  productCss,
  storePicker,
  jizhangerpBridge,
  portalBridgePolicy,
  aiWizard,
]) {
  assert(!/watermark|水印|边框模板|未绑水印|已绑水印/i.test(source));
}
assert(batchHtml.includes("AI 大模型改图"));
assert(batchHtml.includes("SEO"));
assert(batchJs.includes("cfg-ai-poster"));
assert(batchJs.includes("cfg-ai-rewrite"));
assert(product.includes("apply-poster"));
assert(product.includes("apply-ai-rewrite"));
