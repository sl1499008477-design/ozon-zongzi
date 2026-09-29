import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const runtimeState = await readFile(new URL("../src/local-runtime-state.js", import.meta.url), "utf8");

test("Web source contains no retired selection or watermark surface", () => {
  for (const pattern of [
    /\/ozon\/products\/reshelf/,
    /function ReshelfPage\b/,
    /下架重上/,
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

test("every retained business route dispatches to a defined page component", () => {
  for (const [route, component, definition] of [
    ["/ozon/products/list", "ProductListPage", "function"],
    ["/ozon/products/collect", "CollectPage", "function"],
    ["/ozon/products/import-history", "ImportHistoryPage", "function"],
    ["/ozon/templates", "ProductTemplatesPage", "function"],
    ["/ozon/settings/stores", "StoresSettingsPage", "import"],
    ["/ozon/settings/accounts", "AccountSettingsPage", "import"],
    ["/ozon/settings/pricing", "PricingSettingsPage", "import"],
  ]) {
    assert.match(app, new RegExp(`^${definition} ${component}\\b`, "m"));
    assert.match(app, new RegExp(`if \\(route === "${route}"\\) return <${component}\\b`));
  }
  assert.match(app, /if \(route\.startsWith\("\/ozon\/products\/collect\/edit"\)\) return <CollectEditPage\b/);
  assert.match(app, /^function CollectEditPage\b/m);
});

test("legacy inventory route opens the merged product management page", () => {
  assert.match(app, /"\/ozon\/products\/stocks": "\/ozon\/products\/list"/);
  assert.doesNotMatch(app, /^function StocksPage\b/m);
  assert.doesNotMatch(app, /return <StocksPage\b/);
});
