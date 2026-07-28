const assert = require('node:assert/strict');
const { normalizePortalBridgeMessage, sanitizePortalBridgeResponse } = require('../lib/portal-bridge-policy.js');
const fs = require('node:fs');
const senderUrl = 'https://qh.jizhangerp.com/app';
const generic = normalizePortalBridgeMessage({ protocol: 'SONLI_WEB_CONTROL', senderUrl, message: { action: 'syncAuthFromWeb', token: 't', storeId: 's', type: 'jzManualSync', webBridge: false } });
assert.deepEqual(generic, { protocol: 'SONLI_WEB_CONTROL', action: 'syncAuthFromWeb', token: 't', storeId: 's' });
assert.deepEqual(normalizePortalBridgeMessage({ protocol: 'JZ_ERP', senderUrl, message: { type: 'jzManualSync', storeId: 's', syncType: 'PRODUCTS', token: 'x' } }), { protocol: 'JZ_ERP', type: 'jzManualSync', storeId: 's', syncType: 'PRODUCTS' });
assert.deepEqual(normalizePortalBridgeMessage({ protocol: 'JZ_ERP', senderUrl, message: { action: 'followSell', storeId: 's', items: [{ sku: '1' }], dryRun: true, type: 'x' } }), { protocol: 'JZ_ERP', action: 'followSell', storeId: 's', items: [{ sku: '1' }], dryRun: true });
for (const bad of [
  { protocol: 'SONLI_WEB_CONTROL', message: { action: 'getAuth' } },
  { protocol: 'JZ_ERP', message: { type: 'unknown' } },
  { protocol: 'JZ_ERP', message: { action: 'syncAuthFromWeb' } },
]) assert.throws(() => normalizePortalBridgeMessage({ ...bad, senderUrl }));
assert.throws(() => normalizePortalBridgeMessage({ protocol: 'SONLI_WEB_CONTROL', senderUrl: 'https://evil.test', message: { action: 'logout' } }));
assert.deepEqual(sanitizePortalBridgeResponse({ data: { token: 'secret', ok: true } }), { data: { ok: true } });
const worker = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.match(worker, /normalizePortalBridgeMessage/);
assert.match(worker, /message = globalThis\.JzPortalBridgePolicy/);
const jzBridge = fs.readFileSync('extension/content/jizhangerp-bridge.js', 'utf8');
assert.match(jzBridge, /portalProtocol: "JZ_ERP"/);
console.log('portal bridge policy tests passed');
