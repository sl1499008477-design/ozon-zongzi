const assert = require('node:assert/strict');
const { isAllowedWebBridgeAction, isTrustedWebBridgeSender, sanitizeWebBridgeResponse } = require('../lib/web-bridge-policy.js');

assert.equal(isAllowedWebBridgeAction('syncAuthFromWeb'), true);
assert.equal(isAllowedWebBridgeAction('getOzonSellerLoginState'), true);
assert.equal(isAllowedWebBridgeAction('getAuth'), false);
assert.equal(isAllowedWebBridgeAction('savePricingSnapshot'), false);
assert.equal(isAllowedWebBridgeAction('unknown'), false);
assert.equal(isTrustedWebBridgeSender({ url: 'http://127.0.0.1:3000/' }), true);
assert.equal(isTrustedWebBridgeSender({ url: 'https://evil.example/' }), false);
assert.deepEqual(sanitizeWebBridgeResponse({ ok: true, data: { token: 'secret', storeId: 's1' } }), { ok: true, data: { storeId: 's1' } });
console.log('web bridge policy tests passed');
