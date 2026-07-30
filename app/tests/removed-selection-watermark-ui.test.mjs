import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const runtimeState = await readFile(new URL("../src/local-runtime-state.js", import.meta.url), "utf8");

test("Web source contains no retired selection or watermark surface", () => {
  for (const pattern of [
    /\/ozon\/selection\//,
    /\/ozon\/tools\/watermark/,
    /function CategoryPage\b/,
    /function SelectionListPage\b/,
    /function WatermarkPage\b/,
    /label:\s*"选品"/,
    /label:\s*"类目分析"/,
    /label:\s*"榜单选品"/,
    /label:\s*"水印管理"/,
  ]) {
    assert.doesNotMatch(app, pattern);
  }
  assert.doesNotMatch(styles, /\.(?:selection|watermark)-[a-z0-9-]+/);
  assert.doesNotMatch(runtimeState, /watermarkTemplates/);
});

test("AI and non-selection business routes remain without the recommendation tag", () => {
  assert.match(app, /\/ozon\/tools\/ai-poster-records/);
  assert.match(app, /\/ozon\/ai-image/);
  assert.match(app, /\/ozon\/postings\/profit-trend/);
  assert.match(app, /label:\s*"AI 工具"/);
  assert.doesNotMatch(app, /AI 工具\s*<Tag[^>]*>\s*推荐\s*<\/Tag>/);
  assert.match(app, /\/ozon\/products\/collect/);
  assert.match(app, /\/ozon\/settings\/stores/);
});

test("every retained business route dispatches to a defined page component", () => {
  for (const [route, component, definition] of [
    ["/ozon/products/list", "ProductListPage", "function"],
    ["/ozon/products/collect", "CollectPage", "function"],
    ["/ozon/products/import-history", "ImportHistoryPage", "function"],
    ["/ozon/products/stocks", "StocksPage", "function"],
    ["/ozon/products/reshelf", "ReshelfPage", "function"],
    ["/ozon/tools/ai-poster-records", "AiPosterPage", "function"],
    ["/ozon/ai-image", "AiImagePage", "function"],
    ["/ozon/promotions/prices", "PriceDiscountPage", "function"],
    ["/ozon/promotions/campaigns", "CampaignsPage", "function"],
    ["/ozon/promotions/auto-delete", "AutoDeletePromoPage", "function"],
    ["/ozon/postings/list", "PostingsPage", "function"],
    ["/ozon/postings/returns", "ReturnsPage", "function"],
    ["/ozon/postings/profit-trend", "ProfitTrendPage", "import"],
    ["/ozon/postings/review-request", "MessageTaskPage", "function"],
    ["/ozon/postings/pickup-reminder", "MessageTaskPage", "function"],
    ["/ozon/messaging/templates", "MessageTemplatesPage", "function"],
    ["/ozon/messaging/history", "MessageHistoryPage", "function"],
    ["/ozon/templates", "ProductTemplatesPage", "function"],
    ["/ozon/settings/stores", "StoresSettingsPage", "import"],
    ["/ozon/settings/accounts", "AccountSettingsPage", "import"],
    ["/ozon/settings/pricing", "PricingSettingsPage", "import"],
    ["/datascreen", "DataScreenPage", "import"],
  ]) {
    assert.match(app, new RegExp(`^${definition} ${component}\\b`, "m"));
    assert.match(app, new RegExp(`if \\(route === "${route}"\\) return <${component}\\b`));
  }
  assert.match(app, /if \(route\.startsWith\("\/ozon\/products\/collect\/edit"\)\) return <CollectEditPage\b/);
  assert.match(app, /^function CollectEditPage\b/m);
});
