const assert = require("assert");
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "../..");
const read = (relativePath) =>
  fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");

const html = read("popup/popup.html");
const js = read("popup/popup.js");
const manifest = JSON.parse(read("manifest.json"));

const actionLabels = {
  dashboard: "打开 sonli ERP",
  products: "商品列表",
  "collect-box": "采集箱",
  "batch-upload": "批量上架",
  "import-history": "上架记录",
  reshelf: "下架重上",
  pricing: "sonli 算价",
  watermark: "水印管理",
  stores: "店铺管理",
  "premium-pivot": "数据透视眼",
  "data-panel": "数据面板",
};

for (const [action, label] of Object.entries(actionLabels)) {
  assert(html.includes(`data-action="${action}"`), `popup should expose data-action=${action}`);
  assert(html.includes(label), `popup should render label: ${label}`);
}

const routeContracts = {
  dashboard: "/ozon/dashboard",
  products: "/ozon/products/list",
  "collect-box": "/ozon/products/collect",
  "import-history": "/ozon/products/import-history",
  reshelf: "/ozon/products/reshelf",
  watermark: "/ozon/tools/watermark",
  stores: "/ozon/settings/stores",
};

for (const [action, route] of Object.entries(routeContracts)) {
  assert(
    js.includes(`${action.includes("-") ? `"${action}"` : action}: "${route}"`),
    `popup ACTION_PATHS must map ${action} to ${route}`,
  );
}

for (const route of Object.values(routeContracts)) {
  assert(
    js.includes(`sendMessage({ action: "openFrontend", path })`),
    `popup should route frontend actions through openFrontend (${route})`,
  );
}

assert(
  js.includes("chrome.windows.create({") &&
    js.includes('url: chrome.runtime.getURL("batch-upload/index.html")'),
  "batch upload should open the packaged extension page",
);
assert(js.includes("await togglePremiumPivot();"), "premium-pivot should toggle the Ozon premium hook");
assert(js.includes("await toggleDataPanel();"), "data-panel should toggle the Ozon data panel");
assert(!html.includes("sonli 采集器"), "popup must not expose the removed collector");
assert(!js.includes("toggleCollector"), "popup must not retain the removed collector toggle");
assert(js.includes("await openJzcCalc();"), "pricing should open the Ozon calculator on product pages");
assert(
  js.includes("chrome.tabs.create({ url: `${FRONTEND_BASE_URL}/ozon/dashboard/` });"),
  "web-login button should open the local dashboard after auth sync",
);

const bridgeScript = manifest.content_scripts.find((script) =>
  script.matches?.includes("http://127.0.0.1:3000/*") &&
  script.js?.includes("content/jizhangerp-bridge.js"),
);
assert(bridgeScript, "manifest should inject bridge into the local frontend");
assert(bridgeScript.js.includes("lib/sku-collect.js"), "bridge should include SKU collection helper");
assert(bridgeScript.js.includes("lib/v3-payload.js"), "bridge should include V3 payload helper");
assert(bridgeScript.js.includes("lib/follow-sell-content-copy.js"), "bridge should include follow-sell copy helper");

console.log("popup routing smoke passed");
