const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromeMatchPatternCovers } = require('./helpers/chrome-match-pattern.js');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
assert.equal(manifest.name, 'ozon 粽子');
assert.equal(manifest.description, 'ozon 粽子 · Ozon 选品采集与运营助手');
assert.equal(manifest.action?.default_title, 'ozon 粽子');
const assets = manifest.content_scripts.flatMap((entry) => entry.js || []);
assert.equal(assets.includes('content/collector/l1-diff.js'), false);
assert.deepEqual(manifest.permissions, [
  'storage',
  'contextMenus',
  'alarms',
  'cookies',
  'scripting',
  'notifications',
  'unlimitedStorage',
]);
const searchScripts = manifest.content_scripts
  .find((entry) => entry.js?.includes('content/ozon-search.js'))?.js || [];
const searchIndex = searchScripts.indexOf('content/ozon-search.js');
assert.ok(searchIndex > 0, 'content/ozon-search.js content script entry missing');
assert.equal(searchScripts[searchIndex - 1], 'lib/category-strategy-sampling.js');
assert.equal(searchScripts[searchIndex - 2], 'lib/ozon-collect-coordinator.js');
assert.equal(searchScripts[searchIndex - 3], 'lib/ozon-enrichment-contract.js');

const dataPanelScripts = manifest.content_scripts
  .find((entry) => entry.js?.includes('content/ozon-data-panel.js'))?.js || [];
const dataPanelIndex = dataPanelScripts.indexOf('content/ozon-data-panel.js');
assert.ok(dataPanelIndex > 0, 'content/ozon-data-panel.js content script entry missing');
assert.equal(dataPanelScripts[dataPanelIndex - 1], 'lib/seller-context-status-controller.js');
assert.equal(dataPanelScripts[dataPanelIndex - 2], 'lib/ozon-collect-coordinator.js');
assert.equal(dataPanelScripts[dataPanelIndex - 3], 'lib/ozon-enrichment-contract.js');
const productScripts = manifest.content_scripts
  .find((entry) => entry.js?.includes('content/ozon-product.js'))?.js || [];
const productIndex = productScripts.indexOf('content/ozon-product.js');
assert.equal(productScripts[productIndex - 1], 'lib/ozon-collect-coordinator.js');
assert.equal(productScripts[productIndex - 2], 'lib/ozon-enrichment-contract.js');
assert.equal(
  manifest.content_scripts.filter((entry) =>
    entry.js?.includes('lib/ozon-collect-coordinator.js')).length,
  3,
  'all three Ozon collection surfaces must inject the singleton coordinator',
);
assert.equal(manifest.host_permissions.includes('https://open.er-api.com/*'), false);
for (const sellerApiUrl of [
  'https://api-seller.ozon.ru/v3/product/info/list',
  'http://api-seller.ozon.ru/v2/posting/fbo/list',
]) {
  assert.equal(
    manifest.host_permissions.some((pattern) =>
      chromeMatchPatternCovers(pattern, sellerApiUrl)),
    false,
    `manifest must not cover ${sellerApiUrl}`,
  );
}
for (const visibleCaptureUrl of [
  'https://www.ozon.ru/product/example-123456789/',
  'https://ozon.ru/search/?text=example',
  'https://seller.ozon.ru/app/products',
  'https://ozon.kz/product/example-123456789/',
  'https://www.ozon.kz/search/?text=example',
]) {
  assert.equal(
    manifest.host_permissions.some((pattern) =>
      chromeMatchPatternCovers(pattern, visibleCaptureUrl)),
    true,
    `manifest must preserve visible capture access to ${visibleCaptureUrl}`,
  );
  assert.equal(
    manifest.content_scripts.some((entry) =>
      (entry.matches || []).some((pattern) =>
        chromeMatchPatternCovers(pattern, visibleCaptureUrl))),
    true,
    `content scripts must still inject into ${visibleCaptureUrl}`,
  );
}
console.log('manifest security contract passed');
