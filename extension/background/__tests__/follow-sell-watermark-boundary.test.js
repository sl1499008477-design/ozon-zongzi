'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../service-worker.js'), 'utf8');
const start = source.indexOf('function stripInternalMessageFields(message) {');
const end = source.indexOf('\n  }', start) + 4;
assert.ok(start >= 0 && end > start, 'service worker should expose followSell boundary cleanup');

const stripInternalMessageFields = Function(`${source.slice(start, end)}\nreturn stripInternalMessageFields;`)();

for (const message of [
  {
    action: 'followSell',
    storeId: 'store-api',
    items: [{ offer_id: 'api-1' }],
    applyWatermark: true,
    watermarkTemplateId: 'legacy-template',
    applyPoster: true,
  },
  {
    action: 'followSell',
    storeId: 'store-portal',
    items: [{ offer_id: 'portal-1' }],
    viaPortal: true,
    applyWatermark: false,
    watermarkTemplateId: 'legacy-template',
    stocks: [{ offer_id: 'portal-1', stock: 5, warehouse_id: 'wh-1' }],
  },
]) {
  const sanitized = stripInternalMessageFields(message);
  assert.equal(sanitized.applyWatermark, undefined, 'followSell import payload must not include applyWatermark');
  assert.equal(sanitized.watermarkTemplateId, undefined, 'followSell import payload must not include watermarkTemplateId');
  assert.equal(sanitized.storeId, message.storeId, 'store boundary must be preserved');
  assert.deepEqual(sanitized.items, message.items, 'items must be preserved');
  if (message.viaPortal) {
    assert.equal(sanitized.viaPortal, true, 'portal route flag must be preserved');
    assert.deepEqual(sanitized.stocks, message.stocks, 'portal stocks must be preserved');
  } else {
    assert.equal(sanitized.applyPoster, true, 'API AI image option must be preserved');
  }
}

const followSellStart = source.indexOf("case 'followSell':");
const followSellEnd = source.indexOf("case 'importFromPublic':", followSellStart);
const followSell = source.slice(followSellStart, followSellEnd);
assert.ok(followSell.includes('importViaPortal(importMessage,'), 'portal import must receive the sanitized payload');
assert.ok(followSell.includes("`${backendUrl}/ozon/products/import`,\n            importMessage,"), 'API import must receive the sanitized payload');

console.log('followSell watermark boundary passed');
