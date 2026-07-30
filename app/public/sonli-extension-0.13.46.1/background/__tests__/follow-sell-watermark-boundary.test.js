'use strict';

const assert = require('node:assert/strict');
const { runFollowSellRequest } = require('../follow-sell-request.js');

const makeDeps = () => {
  const apiCalls = [];
  const portalCalls = [];
  return {
    apiCalls,
    portalCalls,
    deps: {
      deriveImportEntry: () => 'test-entry',
      apiRequest: async (...args) => {
        apiCalls.push(args);
        return { result: { task_id: 'api-task' } };
      },
      importViaPortal: async (...args) => {
        portalCalls.push(args);
        return { result: { task_id: 'portal-task' } };
      },
      aiWizardDebugMeta: () => null,
      log: { log: () => {} },
    },
  };
};

const assertCleanPayload = (payload, expected) => {
  assert.equal(payload.applyWatermark, undefined);
  assert.equal(payload.watermarkTemplateId, undefined);
  assert.equal(payload.storeId, expected.storeId);
  assert.deepEqual(payload.items, expected.items);
  assert.deepEqual(payload.stocks, expected.stocks);
  assert.equal(payload.applyPoster, true);
  assert.equal(payload.applyAiRewrite, true);
  assert.equal(payload.viaPortal, expected.viaPortal);
  assert.equal(payload.entry, 'test-entry');
};

(async () => {
  const api = makeDeps();
  const apiMessage = {
    action: 'followSell',
    storeId: 'store-api',
    items: [{ offer_id: 'api-1' }],
    stocks: [{ offer_id: 'api-1', stock: 5, warehouse_id: 'wh-api' }],
    applyWatermark: true,
    watermarkTemplateId: 'legacy-template',
    applyPoster: true,
    applyAiRewrite: true,
    viaPortal: false,
  };
  await runFollowSellRequest({ message: apiMessage, sender: {}, token: 'token', storeId: null, backendUrl: 'https://api.test' }, api.deps);
  assert.equal(api.portalCalls.length, 0);
  assert.equal(api.apiCalls.length, 1);
  assert.equal(api.apiCalls[0][1], 'https://api.test/ozon/products/import');
  assertCleanPayload(api.apiCalls[0][2], apiMessage);

  const portal = makeDeps();
  const portalMessage = {
    ...apiMessage,
    storeId: 'store-portal',
    items: [{ offer_id: 'portal-1' }],
    stocks: [{ offer_id: 'portal-1', stock: 8, warehouse_id: 'wh-portal' }],
    viaPortal: true,
  };
  await runFollowSellRequest({ message: portalMessage, sender: { tab: { id: 8 } }, token: 'token', storeId: null, backendUrl: 'https://api.test' }, portal.deps);
  assert.equal(portal.apiCalls.length, 0);
  assert.equal(portal.portalCalls.length, 1);
  assertCleanPayload(portal.portalCalls[0][0], portalMessage);
  assert.equal(portal.portalCalls[0][4], 8);

  console.log('followSell watermark boundary passed');
})();
