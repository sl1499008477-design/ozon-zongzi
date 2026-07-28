const assert = require('node:assert/strict');
const {
  normalizePortalBridgeMessage,
  routePortalRuntimeMessage,
  sanitizePortalBridgeResponse,
} = require('../lib/portal-bridge-policy.js');
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

assert.equal(typeof routePortalRuntimeMessage, 'function', 'portal policy must expose executable runtime routing');
assert.deepEqual(
  routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'SONLI_WEB_CONTROL',
      action: 'syncAuthFromWeb',
      token: 't',
      storeId: 's',
      type: 'jzManualSync',
    },
  }),
  {
    source: 'PORTAL',
    route: 'SONLI_WEB_CONTROL',
    message: {
      protocol: 'SONLI_WEB_CONTROL',
      action: 'syncAuthFromWeb',
      token: 't',
      storeId: 's',
    },
  },
  'a generic page message cannot smuggle a dedicated JZ discriminator',
);
assert.equal(
  routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'JZ_ERP',
      type: 'jzManualSync',
      storeId: 's',
      syncType: 'PRODUCTS',
    },
  }).route,
  'JZ_MANUAL_SYNC',
  'a legal JZ manual sync must reach its dedicated route',
);
assert.equal(
  routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'JZ_ERP',
      action: 'followSell',
      storeId: 's',
      items: [{ sku: '1' }],
    },
  }).route,
  'JZ_FOLLOW_SELL',
  'a legal JZ follow-sell must reach its dedicated route',
);
assert.deepEqual(
  routePortalRuntimeMessage({
    senderUrl,
    message: { action: 'searchVariants', sku: '1' },
  }),
  {
    source: 'EXTENSION_CONTENT',
    route: 'INTERNAL',
    message: { action: 'searchVariants', sku: '1' },
  },
  'JZSkuCollect internal extension traffic must not be mistaken for a page bridge message',
);
assert.throws(
  () => routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'JZ_ERP',
      action: 'searchVariants',
      sku: '1',
    },
  }),
  /PORTAL_BRIDGE_FORBIDDEN/,
  'a page bridge protocol cannot claim an internal privileged action',
);
const worker = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.match(worker, /routePortalRuntimeMessage/);
assert.match(worker, /portalRoute === 'JZ_MANUAL_SYNC'/);
const jzBridge = fs.readFileSync('extension/content/jizhangerp-bridge.js', 'utf8');
assert.match(jzBridge, /portalProtocol: "JZ_ERP"/);
console.log('portal bridge policy tests passed');
