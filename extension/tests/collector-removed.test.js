const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");

const read = (file) => readFileSync(file, "utf8");
const manifest = JSON.parse(read("extension/manifest.json"));
const popupHtml = read("extension/popup/popup.html");
const popupJs = read("extension/popup/popup.js");
const worker = read("extension/background/service-worker.js");
const product = read("extension/content/ozon-product.js");
const search = read("extension/content/ozon-search.js");
const dataPanel = read("extension/content/ozon-data-panel.js");

const removedAssets = [
  "content/collector/db.js",
  "content/collector/auto-scroller.js",
  "content/collector/keyword-pilot.js",
  "content/collector/anti-ban.js",
  "content/collector/panel.js",
  "content/collector/panel.css",
];

for (const asset of removedAssets) {
  assert.equal(existsSync(`extension/${asset}`), false, `${asset} should be removed`);
}

const injectedAssets = manifest.content_scripts.flatMap((entry) => [
  ...(entry.js || []),
  ...(entry.css || []),
]);
for (const asset of removedAssets) {
  assert.equal(injectedAssets.includes(asset), false, `${asset} must not be injected`);
}

assert.equal(popupHtml.includes("sonli 采集器"), false);
assert.equal(popupHtml.includes("采集器实时状态"), false);
assert.equal(popupJs.includes("toggleCollector"), false);
assert.equal(popupJs.includes("collectorGetState"), false);
assert.equal(worker.includes("pushSourceCollectBatch"), false);
assert.equal(worker.includes("collectorHeartbeat"), false);
assert.equal(worker.includes("collectorGetState"), false);
assert.equal(worker.includes("/local/data-collection-stores/verify"), false);
assert.equal(worker.includes("verifiedDataCollectionStoreId"), false);
assert.equal(worker.includes("getOzonSellerLoginState"), false);

assert.match(product, /一键采集/);
assert.match(product, /collectAllVariants/);
assert.match(product, /pushSourceCollect/);
assert.equal(product.includes("JZCollectorDB"), false);

const retiredCollectorGlobals = [
  "JZCollectorDB",
  "JZCollectorPanel",
  "JZKeywordPilot",
  "JZAutoScroller",
  "JZAntiBanGuard",
];

for (const globalName of retiredCollectorGlobals) {
  assert.equal(search.includes(globalName), false, `search page must not depend on ${globalName}`);
  assert.equal(dataPanel.includes(globalName), false, `data panel must not depend on ${globalName}`);
}

console.log("collector removal and one-click collection guard passed");
