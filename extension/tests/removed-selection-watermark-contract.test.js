const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const product = read("content/ozon-product.js");
const productCss = read("content/ozon-product.css");
const search = read("content/ozon-search.js");
const serviceWorker = read("background/service-worker.js");
const sellerBridge = read("content/ozon-seller-bridge.js");
const popupHtml = read("popup/popup.html");
const popupJs = read("popup/popup.js");
const batchHtml = read("batch-upload/index.html");
const batchJs = read("batch-upload/index.js");
const listingActions = read("background/agent/listing-actions.js");
const storePicker = read("lib/store-picker.js");
const jizhangerpBridge = read("content/jizhangerp-bridge.js");
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

assert(product.includes("一键采集"));
assert(product.includes("利润"));
assert(product.includes("OZON以图搜图"));
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
  serviceWorker,
  listingActions,
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
