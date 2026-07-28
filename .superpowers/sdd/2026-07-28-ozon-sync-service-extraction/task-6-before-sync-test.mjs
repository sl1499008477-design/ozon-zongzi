import assert from "node:assert/strict";
import { createOzonSyncService } from "../ozon-sync-service.mjs";

const clone = (value) => structuredClone(value);
const originalFetch = globalThis.fetch;

const basePersisted = {
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
let persisted = clone(basePersisted);
const savedSnapshots = [];

const requests = [];
const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});

const service = createOzonSyncService({
  loadState: async () => clone(persisted),
  saveState: async (state) => {
    persisted = clone(state);
    savedSnapshots.push(clone(state));
  },
  now: () => new Date("2026-07-28T08:00:00.000Z"),
  createJobId: () => "job_fixed",
  logger: { warn() {}, error() {} },
});

try {
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({
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
    });
  };

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

  persisted = clone(basePersisted);
  persisted.caches.products = [
    {
      id: "foreign",
      product_id: "foreign",
      storeId: "store_b",
      clientId: "client_b",
      accountId: "acct_b",
    },
  ];
  const successSaveStart = savedSnapshots.length;
  const productListBodies = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v2/analytics/stock_on_warehouses") {
      return jsonResponse({
        result: {
          rows: [
            { product_id: "product_1", warehouse_id: "fbo_1", warehouse_name: "FBO 1", present: 3 },
          ],
        },
      });
    }
    if (path === "/v3/product/list") {
      productListBodies.push(body);
      if (body.filter?.visibility === "ARCHIVED") {
        return jsonResponse({ result: { items: [], last_id: "" } });
      }
      if (!body.last_id) {
        return jsonResponse({
          result: {
            items: [{ product_id: "product_1", offer_id: "offer_1", visibility: "ALL" }],
            last_id: "page_2",
          },
        });
      }
      return jsonResponse({
        result: {
          items: [{ product_id: "product_2", offer_id: "offer_2", visibility: "ALL" }],
          last_id: "",
        },
      });
    }
    if (path === "/v3/product/info/list") {
      const productId = String(body.product_id?.[0] || "");
      const suffix = productId.endsWith("_1") ? "1" : "2";
      return jsonResponse({
        result: {
          items: [{
            id: productId,
            product_id: productId,
            offer_id: `offer_${suffix}`,
            sku: Number(`10${suffix}`),
            name: `Product ${suffix}`,
          }],
        },
      });
    }
    if (path === "/v5/product/info/prices") {
      const productId = String(body.filter?.product_id?.[0] || "");
      return jsonResponse({
        items: [{
          product_id: productId,
          price: productId === "product_1" ? "99.00" : "199.00",
        }],
      });
    }
    if (path === "/v2/product/info/stocks-by-warehouse/fbs") {
      const offerId = String(body.offer_id?.[0] || "");
      const suffix = offerId.endsWith("_1") ? "1" : "2";
      return jsonResponse({
        result: {
          items: [{
            product_id: `product_${suffix}`,
            offer_id: offerId,
            sku: Number(`10${suffix}`),
            warehouse_id: `fbs_${suffix}`,
            warehouse_name: `FBS ${suffix}`,
            present: 7,
          }],
          has_next: false,
          cursor: "",
        },
      });
    }
    throw new Error(`unexpected product sync request: ${path}`);
  };

  const successReport = await service.runLocalSync(clone(persisted), {
    accountId: "acct_a",
    storeId: "store_a",
    type: "PRODUCTS",
    jobId: "job_products_success",
    deviceId: "device_a",
    source: "extension",
  });

  assert.equal(successReport.status, "SUCCESS");
  assert.equal(successReport.fetchedCount, 2);
  assert.equal(persisted.caches.products.filter((row) => row.storeId === "store_a").length, 2);
  assert.equal(
    persisted.caches.products.find((row) => row.storeId === "store_a" && row.id === "product_1").price_info.price,
    "99.00",
  );
  assert.equal(
    persisted.caches.products.find((row) => row.storeId === "store_a" && row.id === "product_1").warehouse_stocks.length,
    2,
  );
  assert.equal(
    persisted.caches.products.some((row) => row.storeId === "store_b" && row.id === "foreign"),
    true,
  );
  assert.deepEqual(
    productListBodies
      .filter((body) => body.filter?.visibility === "ALL")
      .map((body) => body.last_id || ""),
    ["", "page_2"],
  );
  assert.deepEqual(
    savedSnapshots
      .slice(successSaveStart)
      .map((snapshot) => snapshot.jobs?.job_products_success?.status)
      .filter(Boolean),
    ["RUNNING", "SUCCESS"],
  );
  assert.equal(
    persisted.auditEvents.some((event) =>
      event.action === "SYNC_PRODUCTS" &&
      event.status === "SUCCESS" &&
      event.entityId === "job_products_success"
    ),
    true,
  );

  persisted = clone(basePersisted);
  persisted.caches.products = [
    {
      id: "old_product",
      product_id: "old_product",
      storeId: "store_a",
      clientId: "client_a",
      accountId: "acct_a",
    },
    {
      id: "foreign",
      product_id: "foreign",
      storeId: "store_b",
      clientId: "client_b",
      accountId: "acct_b",
    },
  ];
  const failureSaveStart = savedSnapshots.length;
  let productListPage = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v2/analytics/stock_on_warehouses") {
      return jsonResponse({ result: { rows: [] } });
    }
    if (path === "/v3/product/list") {
      productListPage += 1;
      if (productListPage === 2) {
        throw Object.assign(new Error("offline during page 2"), { code: "ENETDOWN" });
      }
      return jsonResponse({
        result: {
          items: [{ product_id: "partial_product", offer_id: "partial_offer", visibility: "ALL" }],
          last_id: "page_2",
        },
      });
    }
    if (path === "/v3/product/info/list") {
      return jsonResponse({
        result: {
          items: [{
            id: "partial_product",
            product_id: "partial_product",
            offer_id: "partial_offer",
            sku: 999,
          }],
        },
      });
    }
    if (path === "/v5/product/info/prices") {
      return jsonResponse({ items: [{ product_id: "partial_product", price: "1.00" }] });
    }
    if (path === "/v2/product/info/stocks-by-warehouse/fbs") {
      return jsonResponse({ result: { items: [], has_next: false, cursor: "" } });
    }
    throw new Error(`unexpected failed product sync request: ${path} ${JSON.stringify(body)}`);
  };

  await assert.rejects(
    () => service.runLocalSync(clone(persisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "PRODUCTS",
      jobId: "job_products_failed",
    }),
    (error) => error.status === 502 && error.code === "ENETDOWN",
  );
  assert.equal(persisted.caches.products.some((row) => row.id === "old_product"), true);
  assert.equal(persisted.caches.products.some((row) => row.id === "partial_product"), false);
  assert.equal(persisted.caches.products.some((row) => row.id === "foreign"), true);
  assert.equal(persisted.jobs.job_products_failed.status, "FAILED");
  assert.equal(
    persisted.auditEvents.some((event) =>
      event.action === "SYNC_PRODUCTS" &&
      event.status === "FAILED" &&
      event.entityId === "job_products_failed"
    ),
    true,
  );
  assert.deepEqual(
    savedSnapshots
      .slice(failureSaveStart)
      .map((snapshot) => snapshot.jobs?.job_products_failed?.status)
      .filter(Boolean),
    ["RUNNING", "FAILED"],
  );

  await assert.rejects(
    () => service.runLocalSync(clone(persisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "POSTINGS",
    }),
    (error) => error.status === 501 && error.code === "OZON_SYNC_UNSUPPORTED",
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ozon sync service tests passed");
