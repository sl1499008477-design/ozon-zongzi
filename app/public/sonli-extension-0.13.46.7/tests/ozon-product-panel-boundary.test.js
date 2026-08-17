const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const dataPanelSource = fs.readFileSync(
  path.join(extensionRoot, 'content', 'ozon-data-panel.js'),
  'utf8',
);

test('product detail pages keep one PDP panel and never start recommendation-card panels', () => {
  const dataPanelGroup = manifest.content_scripts.find((group) =>
    group.js?.includes('content/ozon-data-panel.js'));
  assert.ok(dataPanelGroup);
  for (const pattern of [
    'https://www.ozon.ru/product/*',
    'https://ozon.kz/product/*',
    'https://www.ozon.kz/product/*',
  ]) {
    assert.ok(dataPanelGroup.exclude_matches?.includes(pattern), pattern);
  }

  assert.match(dataPanelSource, /function isProductDetailPage\(\)/);
  assert.match(dataPanelSource, /if \(isProductDetailPage\(\)\) \{\s*getCards\(\)\.forEach\(\(card\) => removeDataPanel\(card\)\);\s*return;/);
});
