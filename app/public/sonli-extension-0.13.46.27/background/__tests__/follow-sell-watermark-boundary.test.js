'use strict';

const assert = require('node:assert/strict');
const { runFollowSellRequest } = require('../follow-sell-request.js');

const makeDeps = ({
  apiResult = { result: { task_id: 'api-task' } },
  portalResult = { result: { task_id: 'portal-task' } },
} = {}) => {
  const apiCalls = [];
  const portalCalls = [];
  return {
    apiCalls,
    portalCalls,
    deps: {
      deriveImportEntry: () => 'test-entry',
      apiRequest: async (...args) => {
        apiCalls.push(args);
        return apiResult;
      },
      importViaPortal: async (...args) => {
        portalCalls.push(args);
        return portalResult;
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

  const previewResponse = {
    preview: {
      accepted: 1,
      warnings: ['preview-only'],
    },
  };
  const preview = makeDeps({ apiResult: previewResponse });
  const previewMessage = {
    ...apiMessage,
    storeId: 'store-preview',
    items: [{ offer_id: 'preview-1', name: 'Preserved item' }],
    stocks: [{ offer_id: 'preview-1', stock: 3, warehouse_id: 'wh-preview' }],
    dryRun: true,
    viaPortal: true,
    strictTypeMatch: true,
    _aiwDebug: { traceId: 'internal-only' },
  };
  const previewResult = await runFollowSellRequest(
    {
      message: previewMessage,
      sender: { tab: { id: 13 } },
      token: 'preview-token',
      storeId: null,
      backendUrl: 'https://api.test',
    },
    preview.deps,
  );
  assert.equal(preview.portalCalls.length, 0, 'dryRun must not call the portal import pipeline');
  assert.equal(preview.apiCalls.length, 1, 'dryRun must call the preview endpoint exactly once');
  assert.deepEqual(preview.apiCalls[0].slice(0, 6), [
    'POST',
    'https://api.test/ozon/products/import/preview',
    {
      action: 'followSell',
      storeId: 'store-preview',
      items: [{ offer_id: 'preview-1', name: 'Preserved item' }],
      stocks: [{ offer_id: 'preview-1', stock: 3, warehouse_id: 'wh-preview' }],
      applyPoster: true,
      applyAiRewrite: true,
      viaPortal: true,
      dryRun: true,
      strictTypeMatch: true,
      entry: 'test-entry',
    },
    'preview-token',
    'store-preview',
    120_000,
  ]);
  assert.deepEqual(previewResult, { ok: true, data: previewResponse });

  console.log('followSell watermark boundary passed');
})();
