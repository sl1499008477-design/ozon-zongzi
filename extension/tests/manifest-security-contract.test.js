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
for (const target of ['content/ozon-search.js', 'content/ozon-data-panel.js']) {
  const scripts = manifest.content_scripts.find((entry) => entry.js?.includes(target))?.js || [];
  const targetIndex = scripts.indexOf(target);
  assert.ok(targetIndex > 0, `${target} content script entry missing`);
  assert.equal(
    scripts[targetIndex - 1],
    'lib/ozon-collect-coordinator.js',
    `shared Ozon coordinator must load immediately before ${target}`,
  );
  assert.equal(
    scripts[targetIndex - 2],
    'lib/ozon-enrichment-contract.js',
    `shared Ozon enrichment contract must load before the coordinator for ${target}`,
  );
}
const productScripts = manifest.content_scripts
  .find((entry) => entry.js?.includes('content/ozon-product.js'))?.js || [];
const productIndex = productScripts.indexOf('content/ozon-product.js');
assert.equal(productScripts[productIndex - 1], 'lib/ozon-enrichment-contract.js');
assert.equal(productScripts.includes('lib/ozon-collect-coordinator.js'), false);
assert.equal(
  manifest.content_scripts.filter((entry) =>
    entry.js?.includes('lib/ozon-collect-coordinator.js')).length,
  2,
  'coordinator should only be injected on the two pages that collect through it',
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
