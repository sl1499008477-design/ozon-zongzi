import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingCategoryAccessPostgres } from "../auto-listing-category-access-postgres.mjs";

test("loads one account-scoped active store credential through the decrypt port", async () => {
  const calls = [];
  const load = createAutoListingCategoryAccessPostgres({
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{
          id: "store-a", owner_account_id: "account-a", client_id: "client-a",
          currency_code: "CNY", currency_source: "OZON_SELLER_INFO",
          currency_synced_at: "2026-08-13T00:00:00.000Z",
          encrypted_api_key: "cipher", iv: "iv", auth_tag: "tag",
        }] };
      },
    },
    decryptSecret: (value) => {
      assert.deepEqual(value, { encrypted_api_key: "cipher", iv: "iv", auth_tag: "tag" });
      return "plain-secret";
    },
  });
  assert.deepEqual(await load({ accountId: "account-a", targetStoreId: "store-a" }), {
    id: "store-a", ownerAccountId: "account-a", clientId: "client-a",
    currencyCode: "CNY", apiKey: "plain-secret",
  });
  assert.deepEqual(calls[0].params, ["store-a", "account-a"]);
  assert.match(calls[0].sql, /s\.owner_account_id=\$2[\s\S]*s\.status <> 'disabled'/i);
  assert.match(calls[0].sql, /s\.currency_source='OZON_SELLER_INFO'[\s\S]*s\.currency_synced_at IS NOT NULL/i);
});

test("does not decrypt or reveal a foreign or missing store", async () => {
  let decrypted = false;
  const load = createAutoListingCategoryAccessPostgres({
    pool: { async query() { return { rows: [] }; } },
    decryptSecret: () => { decrypted = true; return "secret"; },
  });
  assert.equal(await load({ accountId: "account-a", targetStoreId: "store-b" }), null);
  assert.equal(decrypted, false);
});

test("rejects malformed scope before querying", async () => {
  let queried = false;
  const load = createAutoListingCategoryAccessPostgres({
    pool: { async query() { queried = true; return { rows: [] }; } },
    decryptSecret: () => "secret",
  });
  await assert.rejects(load({ accountId: "", targetStoreId: "store-a" }), {
    code: "AUTO_LISTING_CATEGORY_ACCESS_INVALID",
  });
  assert.equal(queried, false);
});
