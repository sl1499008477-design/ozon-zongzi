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
