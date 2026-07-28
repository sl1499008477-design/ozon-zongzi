const assert = require('node:assert/strict');
const { isAllowedWebBridgeAction, isTrustedWebBridgeSender, sanitizeWebBridgeResponse } = require('../lib/web-bridge-policy.js');
const fs = require('node:fs');
const syncAuthSource = fs.readFileSync('extension/content/sync-auth.js', 'utf8');

assert.equal(isAllowedWebBridgeAction('syncAuthFromWeb'), true);
assert.equal(isAllowedWebBridgeAction('setMachineFingerprint'), true);
assert.equal(isAllowedWebBridgeAction('getOzonSellerLoginState'), true);
assert.equal(isAllowedWebBridgeAction('getAuth'), false);
assert.equal(isAllowedWebBridgeAction('savePricingSnapshot'), false);
assert.equal(isAllowedWebBridgeAction('unknown'), false);
assert.equal(isTrustedWebBridgeSender({ url: 'http://127.0.0.1:3000/' }), true);
assert.equal(isTrustedWebBridgeSender({ url: 'https://evil.example/' }), false);
assert.deepEqual(sanitizeWebBridgeResponse({ ok: true, data: { token: 'secret', storeId: 's1' } }), { ok: true, data: { storeId: 's1' } });
assert.match(syncAuthSource, /\{ \.\.\.\(data\.payload \|\| \{\}\), action: data\.action, webBridge: true, portalProtocol: 'SONLI_WEB_CONTROL' \}/);
assert.match(syncAuthSource, /sanitizeWebBridgeResponse\(resp\)/);
const workerSource = fs.readFileSync('extension/background/service-worker.js', 'utf8');
assert.match(workerSource, /message\?\.webBridge \|\| portalRoute === 'SONLI_WEB_CONTROL'/);
console.log('web bridge policy tests passed');
