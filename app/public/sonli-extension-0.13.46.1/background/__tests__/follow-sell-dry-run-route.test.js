'use strict';

/**
 * Guard followSell dryRun routing.
 *
 * This is intentionally a static test: the followSell helper is loaded by the
 * MV3 service worker, and its route ordering is critical because dryRun must
 * never hit the real Ozon import endpoint.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const worker = fs.readFileSync(path.resolve(__dirname, '../service-worker.js'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '../follow-sell-request.js'), 'utf8');
const start = source.indexOf('async function runFollowSellRequest');
const end = source.indexOf('\n  return { runFollowSellRequest };', start);

assert.ok(worker.includes('JzFollowSellRequest.runFollowSellRequest'), 'service worker should delegate followSell requests to its helper');
assert.ok(start > 0, 'followSell helper should contain its request handler');
assert.ok(end > start, 'followSell helper should end after its request handler');

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
