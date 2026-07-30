const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromeMatchPatternCovers } = require('./helpers/chrome-match-pattern.js');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
assert.equal(manifest.name, 'ozon 粽子');
assert.equal(manifest.description, 'ozon 粽子 · Ozon 选品采集与运营助手');
assert.equal(manifest.action?.default_title, 'ozon 粽子');
const assets = manifest.content_scripts.flatMap((entry) => entry.js || []);
assert.equal(assets.includes('content/collector/l1-diff.js'), false);
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
