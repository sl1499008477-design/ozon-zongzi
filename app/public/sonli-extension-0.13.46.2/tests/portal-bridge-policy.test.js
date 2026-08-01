const assert = require('node:assert/strict');
const {
  normalizePortalBridgeMessage,
  routePortalRuntimeMessage,
  sanitizePortalBridgeResponse,
} = require('../lib/portal-bridge-policy.js');
const fs = require('node:fs');
const senderUrl = 'https://qh.jizhangerp.com/app';
const collector = normalizePortalBridgeMessage({
  protocol: 'SONLI_COLLECTOR_AUTH',
  senderUrl,
  message: {
    action: 'collector.auth.exchange',
    requestId: 'request-1',
    ticket: 'ctt_ticket_secret_123456789',
    expiresAt: '2030-01-01T00:01:00.000Z',
    token: 'web-bearer',
    storeId: 'store-1',
  },
});
assert.deepEqual(collector, {
  protocol: 'SONLI_COLLECTOR_AUTH',
  action: 'collector.auth.exchange',
  requestId: 'request-1',
  ticket: 'ctt_ticket_secret_123456789',
  expiresAt: '2030-01-01T00:01:00.000Z',
});
assert.deepEqual(normalizePortalBridgeMessage({ protocol: 'JZ_ERP', senderUrl, message: { action: 'followSell', storeId: 's', items: [{ sku: '1' }], dryRun: true, type: 'x' } }), { protocol: 'JZ_ERP', action: 'followSell', storeId: 's', items: [{ sku: '1' }], dryRun: true });
for (const bad of [
  { protocol: 'SONLI_WEB_CONTROL', message: { action: 'syncAuthFromWeb', token: 't' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.exchange', requestId: '', ticket: 't' } },
  { protocol: 'JZ_ERP', message: { type: 'jzManualSync', storeId: 's', syncType: 'PRODUCTS' } },
  { protocol: 'JZ_ERP', message: { type: 'unknown' } },
  { protocol: 'JZ_ERP', message: { action: 'syncAuthFromWeb' } },
]) assert.throws(() => normalizePortalBridgeMessage({ ...bad, senderUrl }));
assert.throws(() => normalizePortalBridgeMessage({ protocol: 'SONLI_COLLECTOR_AUTH', senderUrl: 'https://evil.test', message: collector }));
assert.deepEqual(sanitizePortalBridgeResponse({ data: { token: 'secret', ok: true } }), { data: { ok: true } });

assert.equal(typeof routePortalRuntimeMessage, 'function', 'portal policy must expose executable runtime routing');
assert.deepEqual(
  routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.exchange',
      requestId: 'request-1',
      ticket: 'ctt_ticket_secret_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
      token: 'web-bearer',
    },
  }),
  {
    source: 'PORTAL',
    route: 'SONLI_COLLECTOR_AUTH',
    message: {
      protocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.exchange',
      requestId: 'request-1',
      ticket: 'ctt_ticket_secret_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    },
  },
  'a generic page message cannot smuggle a dedicated JZ discriminator',
);
assert.throws(
  () => routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'JZ_ERP',
      type: 'jzManualSync',
      storeId: 's',
      syncType: 'PRODUCTS',
    },
  }),
  /PORTAL_BRIDGE_FORBIDDEN/,
  'the retired portal manual-sync contract must be rejected',
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
assert.doesNotMatch(worker, /portalRoute === 'JZ_MANUAL_SYNC'/);
assert.match(worker, /portalRoute !== 'SONLI_COLLECTOR_AUTH'/);
assert.doesNotMatch(worker, /SONLI_WEB_CONTROL/);
const jzBridge = fs.readFileSync('extension/content/jizhangerp-bridge.js', 'utf8');
assert.match(jzBridge, /portalProtocol: "JZ_ERP"/);
assert.doesNotMatch(jzBridge, /sync\.request|sync\.response|jzManualSync/);
console.log('portal bridge policy tests passed');
