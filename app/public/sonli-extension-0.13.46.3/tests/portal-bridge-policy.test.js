const assert = require('node:assert/strict');
const {
  normalizePortalBridgeMessage,
  routePortalRuntimeMessage,
  sanitizePortalBridgeResponse,
} = require('../lib/portal-bridge-policy.js');
const fs = require('node:fs');
const senderUrl = 'https://qh.jizhangerp.com/app';
const collectorMessages = [
  {
    input: { action: 'collector.auth.begin', generationId: 'generation_A_1234' },
    expected: {
      protocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.begin',
      generationId: 'generation_A_1234',
    },
  },
  {
    input: { action: 'collector.auth.logout', generationId: 'generation_A_1234' },
    expected: {
      protocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.logout',
      generationId: 'generation_A_1234',
    },
  },
  {
    input: {
      action: 'collector.auth.exchange',
      requestId: 'request-1',
      generationId: 'generation_A_1234',
      ticket: 'ctt_ticket_secret_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    },
    expected: {
      protocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.exchange',
      requestId: 'request-1',
      generationId: 'generation_A_1234',
      ticket: 'ctt_ticket_secret_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    },
  },
];
for (const { input, expected } of collectorMessages) {
  assert.deepEqual(normalizePortalBridgeMessage({
    protocol: 'SONLI_COLLECTOR_AUTH',
    senderUrl,
    message: input,
  }), expected);
}
const nullPrototypeBegin = Object.assign(Object.create(null), collectorMessages[0].input);
assert.deepEqual(normalizePortalBridgeMessage({
  protocol: 'SONLI_COLLECTOR_AUTH',
  senderUrl,
  message: nullPrototypeBegin,
}), collectorMessages[0].expected, 'null-prototype Collector records remain valid');

const inheritedDirectExtra = Object.assign(
  Object.create({ token: 'inherited-web-bearer' }),
  collectorMessages[0].input,
);
const hiddenDirectExtra = { ...collectorMessages[0].input };
Object.defineProperty(hiddenDirectExtra, 'token', {
  value: 'hidden-web-bearer',
  enumerable: false,
});
const symbolDirectExtra = {
  ...collectorMessages[0].input,
  [Symbol('token')]: 'symbol-web-bearer',
};
const forgedObjectPrototype = Object.create(null);
function ForgedObject() {}
ForgedObject.prototype = forgedObjectPrototype;
Object.defineProperty(forgedObjectPrototype, 'constructor', {
  value: ForgedObject,
  enumerable: false,
});
const forgedPlainRecord = Object.assign(
  Object.create(forgedObjectPrototype),
  collectorMessages[0].input,
);
for (const message of [
  inheritedDirectExtra,
  hiddenDirectExtra,
  symbolDirectExtra,
  forgedPlainRecord,
]) {
  assert.throws(
    () => normalizePortalBridgeMessage({
      protocol: 'SONLI_COLLECTOR_AUTH',
      senderUrl,
      message,
    }),
    /PORTAL_BRIDGE_FORBIDDEN/,
    'Collector normalization must reject non-plain or hidden extra fields',
  );
}
assert.deepEqual(normalizePortalBridgeMessage({ protocol: 'JZ_ERP', senderUrl, message: { action: 'followSell', storeId: 's', items: [{ sku: '1' }], dryRun: true, type: 'x' } }), { protocol: 'JZ_ERP', action: 'followSell', storeId: 's', items: [{ sku: '1' }], dryRun: true });
for (const bad of [
  { protocol: 'SONLI_WEB_CONTROL', message: { action: 'syncAuthFromWeb', token: 't' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.begin', generationId: 'generation_A_1234', token: 'web-bearer' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.logout', generationId: 'generation_A_1234', storeId: 'store-1' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.exchange', requestId: 'request-1', generationId: 'generation_A_1234', ticket: 'ctt_ticket_secret_123456789', expiresAt: '2030-01-01T00:01:00.000Z', accountId: 'account-attacker' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.begin' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.begin', generationId: '123456789012345' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.begin', generationId: 'a'.repeat(129) } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.begin', generationId: 'generation/A_1234' } },
  { protocol: 'SONLI_COLLECTOR_AUTH', message: { action: 'collector.auth.unknown', generationId: 'generation_A_1234' } },
  { protocol: 'JZ_ERP', message: { type: 'jzManualSync', storeId: 's', syncType: 'PRODUCTS' } },
  { protocol: 'JZ_ERP', message: { type: 'unknown' } },
  { protocol: 'JZ_ERP', message: { action: 'syncAuthFromWeb' } },
]) assert.throws(() => normalizePortalBridgeMessage({ ...bad, senderUrl }));
assert.throws(() => normalizePortalBridgeMessage({
  protocol: 'SONLI_COLLECTOR_AUTH',
  senderUrl: 'https://evil.test',
  message: collectorMessages[0].input,
}));
assert.deepEqual(sanitizePortalBridgeResponse({ data: { token: 'secret', ok: true } }), { data: { ok: true } });

assert.equal(typeof routePortalRuntimeMessage, 'function', 'portal policy must expose executable runtime routing');
assert.deepEqual(
  routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.exchange',
      requestId: 'request-1',
      generationId: 'generation_A_1234',
      ticket: 'ctt_ticket_secret_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    },
  }),
  {
    source: 'PORTAL',
    route: 'SONLI_COLLECTOR_AUTH',
    message: {
      protocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.exchange',
      requestId: 'request-1',
      generationId: 'generation_A_1234',
      ticket: 'ctt_ticket_secret_123456789',
      expiresAt: '2030-01-01T00:01:00.000Z',
    },
  },
  'the routing-only portalProtocol discriminator must be removed before exact payload validation',
);
const nullPrototypeRouteMessage = Object.assign(Object.create(null), {
  portalProtocol: 'SONLI_COLLECTOR_AUTH',
  ...collectorMessages[0].input,
});
assert.deepEqual(routePortalRuntimeMessage({
  senderUrl,
  message: nullPrototypeRouteMessage,
}), {
  source: 'PORTAL',
  route: 'SONLI_COLLECTOR_AUTH',
  message: collectorMessages[0].expected,
}, 'null-prototype portal route records remain valid');

const inheritedPortalProtocol = Object.assign(
  Object.create({ portalProtocol: 'SONLI_COLLECTOR_AUTH' }),
  collectorMessages[0].input,
);
const inheritedRouteExtra = Object.assign(
  Object.create({ token: 'inherited-route-bearer' }),
  { portalProtocol: 'SONLI_COLLECTOR_AUTH', ...collectorMessages[0].input },
);
const hiddenRouteExtra = {
  portalProtocol: 'SONLI_COLLECTOR_AUTH',
  ...collectorMessages[0].input,
};
Object.defineProperty(hiddenRouteExtra, 'token', {
  value: 'hidden-route-bearer',
  enumerable: false,
});
const symbolRouteExtra = {
  portalProtocol: 'SONLI_COLLECTOR_AUTH',
  ...collectorMessages[0].input,
  [Symbol('token')]: 'symbol-route-bearer',
};
for (const message of [
  inheritedPortalProtocol,
  inheritedRouteExtra,
  hiddenRouteExtra,
  symbolRouteExtra,
]) {
  assert.throws(
    () => routePortalRuntimeMessage({ senderUrl, message }),
    /PORTAL_BRIDGE_FORBIDDEN/,
    'portal routing must reject inherited discriminators and hidden extra fields',
  );
}
assert.throws(
  () => routePortalRuntimeMessage({
    senderUrl,
    message: {
      portalProtocol: 'SONLI_COLLECTOR_AUTH',
      action: 'collector.auth.begin',
      generationId: 'generation_A_1234',
      token: 'web-bearer',
    },
  }),
  /PORTAL_BRIDGE_FORBIDDEN/,
  'Collector portal messages must reject rather than strip unexpected fields',
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
