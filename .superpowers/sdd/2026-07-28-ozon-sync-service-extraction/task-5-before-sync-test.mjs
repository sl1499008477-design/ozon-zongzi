import assert from "node:assert/strict";
import { createOzonSyncService } from "../ozon-sync-service.mjs";

const clone = (value) => structuredClone(value);
const originalFetch = globalThis.fetch;

let persisted = {
  currentAccountId: "acct_a",
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", apiKey: "key_a" },
    { id: "store_b", ownerAccountId: "acct_b", clientId: "client_b", apiKey: "key_b" },
  ],
  caches: { products: [], postings: [], warehouses: [], promotions: [] },
  jobs: {},
  reports: [],
  auditEvents: [],
};

const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      result: {
        company: {
          name: "Seller A",
          legal_name: "Seller A LLC",
          inn: "7701234567",
        },
        subscription: {
          status: "premium",
        },
      },
    }),
  };
};

const service = createOzonSyncService({
  loadState: async () => clone(persisted),
  saveState: async (state) => {
    persisted = clone(state);
  },
  now: () => new Date("2026-07-28T08:00:00.000Z"),
  createJobId: () => "job_fixed",
  logger: { warn() {}, error() {} },
});

try {
  const state = clone(persisted);
  const result = await service.refreshStoreProfiles(state, {
    accountId: "acct_a",
    storeId: "store_a",
  });

  assert.deepEqual(result, { syncedCount: 1, errors: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(new URL(requests[0].url).pathname, "/v1/seller/info");
  assert.equal(persisted.stores[0].companyName, "Seller A");
  assert.equal(persisted.stores[0].shopName, "Seller A");
  assert.equal(persisted.stores[0].legalName, "Seller A LLC");
  assert.equal(persisted.stores[0].inn, "7701234567");
  assert.equal(persisted.stores[0].taxId, "7701234567");
  assert.equal(persisted.stores[0].isPremium, true);
  assert.equal(persisted.stores[0].profileSyncedAt, "2026-07-28T08:00:00.000Z");
  assert.equal(persisted.stores[0].updatedAt, "2026-07-28T08:00:00.000Z");
  assert.equal(persisted.stores[1].companyName, undefined);

  const requestCountBeforeForbiddenStore = requests.length;
  await assert.rejects(
    () => service.refreshStoreProfiles(clone(persisted), {
      accountId: "acct_a",
      storeId: "store_b",
    }),
    (error) => error.status === 404 && error.code === "STORE_NOT_FOUND",
  );
  assert.equal(requests.length, requestCountBeforeForbiddenStore);

  await assert.rejects(
    () => service.runLocalSync(clone(persisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "PRODUCTS",
    }),
    (error) => error.status === 501 && error.code === "OZON_SYNC_UNSUPPORTED",
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ozon sync service tests passed");
