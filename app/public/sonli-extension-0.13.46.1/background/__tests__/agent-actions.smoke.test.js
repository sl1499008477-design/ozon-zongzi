'use strict';

/**
 * Browser Agent action registry smoke.
 *
 * Run with:
 *   node extension/background/__tests__/agent-actions.smoke.test.js
 */

const assert = require('assert');
const path = require('path');

globalThis.JzBackendClient = {
  collectSource: async () => {
    throw new Error('collectSource should not be called by registry smoke');
  },
  createAiListingDraft: async () => {
    throw new Error('createAiListingDraft should not be called by registry smoke');
  },
  publishAiListingDraft: async () => {
    throw new Error('publishAiListingDraft should not be called by registry smoke');
  },
};

require(path.resolve(__dirname, '../agent/actions.js'));
require(path.resolve(__dirname, '../agent/collect-actions.js'));
require(path.resolve(__dirname, '../agent/listing-actions.js'));

const capabilities = globalThis.JzBrowserAgentActions.capabilities().sort();

assert.deepStrictEqual(
  capabilities,
  [
    'agent.ping',
    'collect.hot_products',
    'collect.product_detail',
    'ozon.collect_variant',
    'ozon.market_data',
    'listing.create_draft',
    'listing.publish_draft',
  ].sort(),
);

globalThis.JzBrowserAgentActions
  .run({ type: 'agent.ping', params: { ok: true } })
  .then((result) => {
    assert.strictEqual(result.pong, true);
    assert.deepStrictEqual(result.params, { ok: true });
    console.log('agent action registry smoke passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

// 动态能力位 ozon.seller_collect:仅当 seller.ozon.ru 有 sc_company_id cookie 时上报。
(async () => {
  globalThis.chrome = { cookies: { getAll: async () => [] } };
  const loggedOut = await globalThis.JzBrowserAgentActions.capabilitiesAsync();
  assert.ok(
    !loggedOut.includes('ozon.seller_collect'),
    'seller_collect must not be advertised when logged out',
  );

  globalThis.chrome = {
    cookies: { getAll: async () => [{ name: 'sc_company_id', value: '123' }] },
  };
  const loggedIn = await globalThis.JzBrowserAgentActions.capabilitiesAsync();
  assert.ok(
    loggedIn.includes('ozon.seller_collect'),
    'seller_collect must be advertised when logged into seller.ozon.ru',
  );
  console.log('dynamic capability smoke passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
