'use strict';

/**
 * Guard followSell dryRun routing.
 *
 * This is intentionally a static test: service-worker.js depends on a full MV3
 * runtime, but this route ordering is critical because dryRun must never hit
 * the real Ozon import endpoint.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../service-worker.js'), 'utf8');
const start = source.indexOf("case 'followSell':");
const end = source.indexOf("case 'importFromPublic':", start);

assert.ok(start > 0, "service worker should contain followSell case");
assert.ok(end > start, "service worker should keep importFromPublic after followSell");

const block = source.slice(start, end);
const dryRunIndex = block.indexOf('if (importMessage.dryRun)');
const previewIndex = block.indexOf('/ozon/products/import/preview');
const previewMetaIndex = block.indexOf("'followSellPreview'");
const importIndex = block.indexOf('/ozon/products/import`');
const realMetaIndex = block.indexOf("aiWizardDebugMeta(message, 'followSell'");

assert.ok(dryRunIndex > 0, "followSell should branch on importMessage.dryRun");
assert.ok(previewIndex > dryRunIndex, "dryRun branch should call import preview endpoint");
assert.ok(previewMetaIndex > dryRunIndex, "dryRun branch should use followSellPreview debug metadata");
assert.ok(importIndex > previewIndex, "real import endpoint should appear after preview branch");
assert.ok(realMetaIndex > importIndex, "real followSell metadata should belong to real import branch");
assert.ok(
  block.slice(dryRunIndex, importIndex).includes('return { ok: true, data: previewResult }'),
  "dryRun branch should return before the real import call",
);

console.log('followSell dryRun route guard passed');
