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

  persisted = clone(basePersisted);
  persisted.caches.postings = [
    {
      id: "old_posting",
      storeId: "store_a",
      clientId: "client_a",
      accountId: "acct_a",
    },
    {
      id: "foreign_posting",
      storeId: "store_b",
      clientId: "client_b",
      accountId: "acct_b",
    },
  ];
  const capturedFbsBodies = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v4/posting/fbs/list") {
      capturedFbsBodies.push(body);
      return jsonResponse({
        result: {
          postings: [{ posting_number: "fbs_1", status: "awaiting_packaging" }],
          cursor: "",
          has_next: false,
        },
      });
    }
    if (path === "/v2/posting/fbo/list") {
      return jsonResponse({
        result: {
          postings: [{ posting_number: "fbo_1", status: "awaiting_deliver" }],
          last_id: "",
        },
      });
    }
    throw new Error(`unexpected postings sync request: ${path}`);
  };

  const postingReport = await service.runLocalSync(clone(persisted), {
    accountId: "acct_a",
    storeId: "store_a",
    type: "POSTINGS",
    jobId: "job_postings_success",
    postingsSinceDays: 1,
  });

  assert.equal(postingReport.status, "SUCCESS");
  assert.equal(postingReport.fetchedCount, 2);
  assert.equal(
    persisted.caches.postings.find((row) => row.id === "fbs_1").storeId,
    "store_a",
  );
  assert.equal(
    persisted.caches.postings.find((row) => row.id === "fbo_1").shipment_type,
    "FBO",
  );
  assert.equal(capturedFbsBodies[0].filter.to, "2026-07-28T08:00:00.000Z");
  assert.equal(
    persisted.caches.postings.some((row) => row.id === "foreign_posting" && row.storeId === "store_b"),
    true,
  );

  persisted = clone(basePersisted);
  const splitRangeFbsBodies = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v4/posting/fbs/list") {
      splitRangeFbsBodies.push(body);
      const { since, to } = body.filter;
      if (
        since === "2026-06-30T08:00:00.000Z" &&
        to === "2026-07-28T08:00:00.000Z" &&
        !body.cursor
      ) {
        throw Object.assign(new Error("PERIOD_IS_TOO_LONG"), { code: "PERIOD_IS_TOO_LONG" });
      }
      if (
        since === "2026-06-30T08:00:00.000Z" &&
        to === "2026-07-14T08:00:00.000Z" &&
        !body.cursor
      ) {
        return jsonResponse({
          result: {
            postings: [{ posting_number: "front_half_1" }],
            cursor: "front_page_2",
            has_next: true,
          },
        });
      }
      if (
        since === "2026-06-30T08:00:00.000Z" &&
        to === "2026-07-14T08:00:00.000Z" &&
        body.cursor === "front_page_2"
      ) {
        return jsonResponse({
          result: {
            postings: [{ posting_number: "front_half_2" }],
            cursor: "",
            has_next: false,
          },
        });
      }
      if (
        since === "2026-07-14T08:00:00.000Z" &&
        to === "2026-07-28T08:00:00.000Z" &&
        !body.cursor
      ) {
        return jsonResponse({
          result: {
            postings: [{ posting_number: "back_half_1" }],
            cursor: "",
            has_next: false,
          },
        });
      }
      throw new Error(`unexpected FBS range/cursor: ${JSON.stringify(body)}`);
    }
    if (path === "/v2/posting/fbo/list") {
      return jsonResponse({ result: { postings: [], last_id: "" } });
    }
    throw new Error(`unexpected shortened postings request: ${path}`);
  };

  const splitRangeReport = await service.runLocalSync(clone(persisted), {
    accountId: "acct_a",
    storeId: "store_a",
    type: "POSTINGS",
    jobId: "job_postings_shortened",
    postingsSinceDays: 28,
  });

  assert.equal(splitRangeReport.fetchedCount, 3);
  assert.deepEqual(
    splitRangeFbsBodies.map((body) => ({
      since: body.filter.since,
      to: body.filter.to,
      cursor: body.cursor || "",
    })),
    [
      {
        since: "2026-06-30T08:00:00.000Z",
        to: "2026-07-28T08:00:00.000Z",
        cursor: "",
      },
      {
        since: "2026-06-30T08:00:00.000Z",
        to: "2026-07-14T08:00:00.000Z",
        cursor: "",
      },
      {
        since: "2026-06-30T08:00:00.000Z",
        to: "2026-07-14T08:00:00.000Z",
        cursor: "front_page_2",
      },
      {
        since: "2026-07-14T08:00:00.000Z",
        to: "2026-07-28T08:00:00.000Z",
        cursor: "",
      },
    ],
  );
  assert.deepEqual(
    persisted.caches.postings
      .filter((row) => row.storeId === "store_a")
      .map((row) => row.id)
      .sort(),
    ["back_half_1", "front_half_1", "front_half_2"],
  );

  persisted = clone(basePersisted);
  persisted.caches.postings = [
    {
      id: "old_posting",
      storeId: "store_a",
      clientId: "client_a",
      accountId: "acct_a",
    },
    {
      id: "foreign_posting",
      storeId: "store_b",
      clientId: "client_b",
      accountId: "acct_b",
    },
  ];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v4/posting/fbs/list") {
      return jsonResponse({
        result: {
          postings: [{ posting_number: "partial_fbs" }],
          cursor: "",
          has_next: false,
        },
      });
    }
    if (path === "/v2/posting/fbo/list") {
      throw Object.assign(new Error("FBO unavailable"), { code: "EFBO" });
    }
    throw new Error(`unexpected failed postings request: ${path}`);
  };

  await assert.rejects(
    () => service.runLocalSync(clone(persisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "POSTINGS",
      jobId: "job_postings_failed",
      postingsSinceDays: 1,
    }),
    (error) => error.status === 502 && error.code === "EFBO",
  );
  assert.deepEqual(
    persisted.caches.postings
      .filter((row) => row.storeId === "store_a")
      .map((row) => row.id),
    ["old_posting"],
  );
  assert.equal(persisted.jobs.job_postings_failed.status, "FAILED");

  persisted = clone(basePersisted);
  persisted.caches.postings = [
    {
      id: "old_posting",
      storeId: "store_a",
      clientId: "client_a",
      accountId: "acct_a",
    },
    {
      id: "foreign_posting",
      storeId: "store_b",
      clientId: "client_b",
      accountId: "acct_b",
    },
  ];
  let stalledFboRequestCount = 0;
  globalThis.fetch = async (url) => {
    requests.push({ url });
    const path = new URL(url).pathname;
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v4/posting/fbs/list") {
      return jsonResponse({ result: { postings: [], cursor: "", has_next: false } });
    }
    if (path === "/v2/posting/fbo/list") {
      stalledFboRequestCount += 1;
      return jsonResponse({
        result: {
          postings: [{
            posting_number: stalledFboRequestCount === 1
              ? "fbo_first_page"
              : "fbo_stalled_page",
          }],
          last_id: "repeated_token",
        },
      });
    }
    throw new Error(`unexpected stalled FBO request: ${path}`);
  };

  await assert.rejects(
    () => service.runLocalSync(clone(persisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "POSTINGS",
      jobId: "job_postings_stalled",
      postingsSinceDays: 1,
    }),
    (error) => error.status === 502 && error.code === "OZON_PAGINATION_STALLED",
  );
  assert.equal(stalledFboRequestCount, 2);
  assert.deepEqual(
    persisted.caches.postings
      .filter((row) => row.storeId === "store_a")
      .map((row) => row.id),
    ["old_posting"],
  );
  assert.equal(
    persisted.caches.postings.some((row) => row.id === "fbo_stalled_page"),
    false,
  );
  assert.equal(persisted.jobs.job_postings_stalled.status, "FAILED");

  persisted = clone(basePersisted);
  persisted.caches.warehouses = [
    { id: "old_warehouse", storeId: "store_a", clientId: "client_a", accountId: "acct_a" },
    { id: "foreign_warehouse", storeId: "store_b", clientId: "client_b", accountId: "acct_b" },
  ];
  let capturedWarehouseMethod = "";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/v1/seller/info") {
      throw Object.assign(new Error("profile unavailable"), { code: "EPROFILE" });
    }
    if (path === "/v2/warehouse/list") {
      capturedWarehouseMethod = options.method;
      return jsonResponse({
        result: {
          warehouses: [{ warehouse_id: "warehouse_1", name: "Warehouse 1" }],
        },
      });
    }
    throw new Error(`unexpected warehouse sync request: ${path}`);
  };

  const warehouseReport = await service.runLocalSync(clone(persisted), {
    accountId: "acct_a",
    storeId: "store_a",
    type: "WAREHOUSES",
    jobId: "job_warehouses_success",
  });

  assert.equal(warehouseReport.status, "SUCCESS");
  assert.equal(warehouseReport.fetchedCount, 1);
  assert.equal(capturedWarehouseMethod, "POST");
  assert.deepEqual(
    persisted.caches.warehouses
      .filter((row) => row.storeId === "store_a")
      .map((row) => row.id),
    ["warehouse_1"],
  );
  assert.equal(
    persisted.caches.warehouses.some((row) => row.id === "foreign_warehouse" && row.storeId === "store_b"),
    true,
  );

  persisted = clone(basePersisted);
  persisted.caches.promotions = [
    { id: "old_promotion", storeId: "store_a", clientId: "client_a", accountId: "acct_a" },
    { id: "foreign_promotion", storeId: "store_b", clientId: "client_b", accountId: "acct_b" },
  ];
  let capturedPromotionMethod = "";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/v1/seller/info") {
      return jsonResponse({ result: { company: { name: "Seller A" } } });
    }
    if (path === "/v1/actions") {
      capturedPromotionMethod = options.method;
      return jsonResponse({ result: [{ id: "promotion_1", title: "Promotion 1" }] });
    }
    throw new Error(`unexpected promotion sync request: ${path}`);
  };

  const promotionReport = await service.runLocalSync(clone(persisted), {
    accountId: "acct_a",
    storeId: "store_a",
    type: "PROMOTIONS",
    jobId: "job_promotions_success",
  });

  assert.equal(promotionReport.status, "SUCCESS");
  assert.equal(promotionReport.fetchedCount, 1);
  assert.equal(capturedPromotionMethod, "GET");
  assert.deepEqual(
    persisted.caches.promotions
      .filter((row) => row.storeId === "store_a")
      .map((row) => row.id),
    ["promotion_1"],
  );
  assert.equal(
    persisted.caches.promotions.some((row) => row.id === "foreign_promotion" && row.storeId === "store_b"),
    true,
  );

  {
    let retryPersisted = clone(basePersisted);
    let successCommitAttempts = 0;
    const retryService = createOzonSyncService({
      loadState: async () => clone(retryPersisted),
      saveState: async (state) => {
        if (state.jobs?.job_retry_success?.status === "SUCCESS") {
          successCommitAttempts += 1;
          if (successCommitAttempts < 3) {
            throw Object.assign(new Error(`conflict ${successCommitAttempts}`), {
              code: "LOCAL_STATE_VERSION_CONFLICT",
              status: 409,
            });
          }
        }
        retryPersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/seller/info") {
        return jsonResponse({ result: { company: { name: "Seller A" } } });
      }
      if (path === "/v2/warehouse/list") {
        return jsonResponse({ result: [{ warehouse_id: "warehouse_retry" }] });
      }
      throw new Error(`unexpected retry sync request: ${path}`);
    };

    const retryReport = await retryService.runLocalSync(clone(retryPersisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "WAREHOUSES",
      jobId: "job_retry_success",
    });

    assert.equal(retryReport.status, "SUCCESS");
    assert.equal(successCommitAttempts, 3);
    assert.equal(retryPersisted.jobs.job_retry_success.status, "SUCCESS");
    assert.equal(
      retryPersisted.caches.warehouses.some((row) => row.id === "warehouse_retry"),
      true,
    );
  }

  {
    let retryPersisted = clone(basePersisted);
    let successCommitAttempts = 0;
    let finalConflict = null;
    const retryService = createOzonSyncService({
      loadState: async () => clone(retryPersisted),
      saveState: async (state) => {
        if (state.jobs?.job_retry_exhausted?.status === "SUCCESS") {
          successCommitAttempts += 1;
          finalConflict = Object.assign(new Error(`conflict ${successCommitAttempts}`), {
            code: "LOCAL_STATE_VERSION_CONFLICT",
            status: 409,
          });
          throw finalConflict;
        }
        retryPersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/seller/info") {
        return jsonResponse({ result: { company: { name: "Seller A" } } });
      }
      if (path === "/v2/warehouse/list") {
        return jsonResponse({ result: [{ warehouse_id: "warehouse_never_committed" }] });
      }
      throw new Error(`unexpected exhausted retry request: ${path}`);
    };

    await assert.rejects(
      () => retryService.runLocalSync(clone(retryPersisted), {
        accountId: "acct_a",
        storeId: "store_a",
        type: "WAREHOUSES",
        jobId: "job_retry_exhausted",
      }),
      (error) => error === finalConflict && error.code === "LOCAL_STATE_VERSION_CONFLICT",
    );
    assert.equal(successCommitAttempts, 4);
    assert.equal(retryPersisted.jobs.job_retry_exhausted.status, "FAILED");
    assert.equal(
      retryPersisted.caches.warehouses.some((row) => row.id === "warehouse_never_committed"),
      false,
    );
  }

  for (const ownershipChange of ["deleted", "transferred"]) {
    let ownershipPersisted = clone(basePersisted);
    ownershipPersisted.caches.warehouses = [
      { id: "old_owned_warehouse", storeId: "store_a", clientId: "client_a", accountId: "acct_a" },
    ];
    const ownershipService = createOzonSyncService({
      loadState: async () => clone(ownershipPersisted),
      saveState: async (state) => {
        ownershipPersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/seller/info") {
        return jsonResponse({ result: { company: { name: "Seller A" } } });
      }
      if (path === "/v2/warehouse/list") {
        if (ownershipChange === "deleted") {
          ownershipPersisted.stores = ownershipPersisted.stores
            .filter((store) => store.id !== "store_a");
        } else {
          ownershipPersisted.stores
            .find((store) => store.id === "store_a").ownerAccountId = "acct_b";
        }
        return jsonResponse({ result: [{ warehouse_id: `warehouse_${ownershipChange}` }] });
      }
      throw new Error(`unexpected ownership sync request: ${path}`);
    };

    await assert.rejects(
      () => ownershipService.runLocalSync(clone(ownershipPersisted), {
        accountId: "acct_a",
        storeId: "store_a",
        type: "WAREHOUSES",
        jobId: `job_store_${ownershipChange}`,
      }),
      (error) => error.status === 409,
    );
    assert.deepEqual(
      ownershipPersisted.caches.warehouses.map((row) => row.id),
      ["old_owned_warehouse"],
    );
    assert.equal(ownershipPersisted.jobs[`job_store_${ownershipChange}`].status, "FAILED");
  }

  {
    let mergePersisted = clone(basePersisted);
    mergePersisted.caches.postings = [
      {
        id: "old_posting",
        storeId: "store_a",
        clientId: "client_a",
        accountId: "acct_a",
        status: "before_status",
        operatorNote: "before",
      },
    ];
    const mergeService = createOzonSyncService({
      loadState: async () => clone(mergePersisted),
      saveState: async (state) => {
        mergePersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/seller/info") {
        return jsonResponse({ result: { company: { name: "Seller A" } } });
      }
      if (path === "/v4/posting/fbs/list") {
        return jsonResponse({
          result: {
            postings: [
              { posting_number: "old_posting", status: "awaiting_deliver" },
              { posting_number: "synced_posting" },
            ],
            cursor: "",
            has_next: false,
          },
        });
      }
      if (path === "/v2/posting/fbo/list") {
        mergePersisted.caches.postings
          .find((row) => row.id === "old_posting").operatorNote = "concurrent";
        mergePersisted.caches.postings.push({
          id: "concurrent_posting",
          storeId: "store_a",
          clientId: "client_a",
          accountId: "acct_a",
          syncedAt: "2026-07-28T08:00:00.001Z",
        });
        return jsonResponse({
          result: {
            postings: [{ posting_number: "old_posting", fboMetric: 7 }],
            last_id: "",
          },
        });
      }
      throw new Error(`unexpected postings merge request: ${path}`);
    };

    await mergeService.runLocalSync(clone(mergePersisted), {
      accountId: "acct_a",
      storeId: "store_a",
      type: "POSTINGS",
      jobId: "job_postings_merge",
      postingsSinceDays: 1,
    });

    assert.deepEqual(
      mergePersisted.caches.postings.map((row) => row.id).sort(),
      ["concurrent_posting", "old_posting", "synced_posting"],
    );
    assert.equal(
      mergePersisted.caches.postings.find((row) => row.id === "old_posting").status,
      "awaiting_deliver",
    );
    assert.equal(
      mergePersisted.caches.postings.find((row) => row.id === "old_posting").fboMetric,
      7,
    );
    assert.equal(
      mergePersisted.caches.postings.find((row) => row.id === "old_posting").shipment_type,
      "FBO",
    );
    assert.equal(
      mergePersisted.caches.postings.find((row) => row.id === "old_posting").operatorNote,
      "concurrent",
    );
  }

  {
    let unsupportedPersisted = clone(basePersisted);
    let unsupportedEndpointCalls = 0;
    const unsupportedService = createOzonSyncService({
      loadState: async () => clone(unsupportedPersisted),
      saveState: async (state) => {
        unsupportedPersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    globalThis.fetch = async () => {
      unsupportedEndpointCalls += 1;
      throw new Error("unsupported sync must not call Ozon");
    };

    await assert.rejects(
      () => unsupportedService.runLocalSync(clone(unsupportedPersisted), {
        accountId: "acct_a",
        storeId: "store_a",
        type: "UNKNOWN",
        jobId: "job_unknown",
      }),
      (error) => error.status === 501 && error.code === "OZON_SYNC_UNSUPPORTED",
    );
    assert.equal(unsupportedEndpointCalls, 0);
    assert.equal(unsupportedPersisted.jobs.job_unknown.status, "FAILED");
    assert.equal(
      unsupportedPersisted.auditEvents.some((event) =>
        event.entityId === "job_unknown" && event.status === "FAILED"
      ),
      true,
    );
  }

  {
    let explicitAccountPersisted = clone(basePersisted);
    let explicitAccountEndpointCalls = 0;
    const explicitAccountService = createOzonSyncService({
      loadState: async () => clone(explicitAccountPersisted),
      saveState: async (state) => {
        explicitAccountPersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    globalThis.fetch = async () => {
      explicitAccountEndpointCalls += 1;
      throw new Error("missing accountId must not call Ozon");
    };

    await assert.rejects(
      () => explicitAccountService.runLocalSync(clone(explicitAccountPersisted), {
        storeId: "store_a",
        type: "WAREHOUSES",
        jobId: "job_missing_account",
      }),
      (error) => error.status === 400 && error.code === "ACCOUNT_ID_REQUIRED",
    );
    assert.equal(explicitAccountEndpointCalls, 0);
    assert.equal(explicitAccountPersisted.jobs.job_missing_account, undefined);
  }

  {
    let warningPersisted = clone(basePersisted);
    const warnings = [];
    const warningService = createOzonSyncService({
      loadState: async () => clone(warningPersisted),
      saveState: async (state) => {
        if (state.jobs?.job_failed_report_warning?.status === "FAILED") {
          throw new Error("postgres password=super-secret");
        }
        warningPersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn(message) { warnings.push(String(message)); } },
    });
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/seller/info") {
        return jsonResponse({ result: { company: { name: "Seller A" } } });
      }
      if (path === "/v2/warehouse/list") {
        throw Object.assign(new Error("original Ozon failure"), { code: "EORIGINAL" });
      }
      throw new Error(`unexpected warning sync request: ${path}`);
    };

    await assert.rejects(
      () => warningService.runLocalSync(clone(warningPersisted), {
        accountId: "acct_a",
        storeId: "store_a",
        type: "WAREHOUSES",
        jobId: "job_failed_report_warning",
      }),
      (error) =>
        error.status === 502 &&
        error.code === "EORIGINAL" &&
        error.message.includes("original Ozon failure"),
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes("super-secret"), false);
    assert.equal(warnings[0].includes("postgres password"), false);
  }

  {
    let sensitivePersisted = clone(basePersisted);
    const sensitiveService = createOzonSyncService({
      loadState: async () => clone(sensitivePersisted),
      saveState: async (state) => {
        sensitivePersisted = clone(state);
      },
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      logger: { warn() {} },
    });
    const sensitiveValues = [
      "client_a",
      "key_a",
      "owner@example.com",
      "private-nested-payload",
    ];
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/seller/info") {
        return jsonResponse({ result: { company: { name: "Seller A" } } });
      }
      if (path === "/v2/warehouse/list") {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({
            code: "WAREHOUSE.DENIED",
            message: "client_a key_a owner@example.com",
            details: { private: "private-nested-payload" },
          }),
        };
      }
      throw new Error(`unexpected sensitive HTTP request: ${path}`);
    };

    await assert.rejects(
      () => sensitiveService.runLocalSync(clone(sensitivePersisted), {
        accountId: "acct_a",
        storeId: "store_a",
        type: "WAREHOUSES",
        jobId: "job_sensitive_http_error",
      }),
      (error) =>
        error.status === 403 &&
        error.code === "OZON_HTTP_403" &&
        error.message ===
          "Ozon 403: /v2/warehouse/list (OZON_HTTP_403)",
    );
    assert.equal(
      sensitivePersisted.jobs.job_sensitive_http_error.error,
      "Ozon 403: /v2/warehouse/list (OZON_HTTP_403)",
    );
    const sensitiveTerminalAudit = sensitivePersisted.auditEvents.find((event) =>
      event.entityId === "job_sensitive_http_error" && event.status === "FAILED"
    );
    assert.ok(sensitiveTerminalAudit);
    const persistedSensitiveText = JSON.stringify({
      job: sensitivePersisted.jobs.job_sensitive_http_error,
      audit: sensitiveTerminalAudit,
    });
    for (const value of sensitiveValues) {
      assert.equal(persistedSensitiveText.includes(value), false);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ozon sync service tests passed");
