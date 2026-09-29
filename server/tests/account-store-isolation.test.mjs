import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-store-sync-route-"));
process.env.QH_LOCAL_DATA_DIR = dataDir;

const { handle, testExports } = await import("../index.mjs");
const {
  activeStore,
  cacheItemMatchesStore,
  cacheItemsForStore,
  canAccessLocalFile,
  currentStoreIdForAccount,
  ensureAccountState,
  localStatePayload,
  setCurrentStoreForAccount,
  storesForAccount,
  upsertProductByStore,
} = testExports;

const accountA = { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" };
const accountB = { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" };
const state = ensureAccountState({
  accounts: [accountA, accountB],
  sessions: {},
  stores: [
    { id: "store_a", ownerAccountId: accountA.id, label: "A store", clientId: "1" },
    { id: "store_b", ownerAccountId: accountB.id, label: "B store", clientId: "2" },
  ],
  currentAccountId: accountA.id,
  currentStoreId: "store_a",
  currentStoreIdsByAccount: { [accountA.id]: "store_a", [accountB.id]: "store_b" },
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
  caches: {
    products: [
      {
        id: "product_a",
        storeId: "store_a",
        warehouse_stocks: [{ warehouse_id: "fbs-a", source: "fbs", present: 0 }],
      },
      {
        id: "product_b",
        storeId: "store_b",
        warehouse_stocks: [{ warehouse_id: "fbs-b", source: "fbs", present: 0 }],
      },
      {
        id: "product_b_archived",
        storeId: "store_b",
        is_archived: true,
        warehouse_stocks: [{ warehouse_id: "fbs-b-archived", source: "fbs", present: 8 }],
      },
      { id: "product_unscoped" },
    ],
    postings: [
      { id: "posting_a", accountId: accountA.id },
      { id: "posting_b", accountId: accountB.id },
    ],
    warehouses: [
      {
        id: "warehouse_a",
        localStoreId: "store_a",
        warehouse_id: "fbs-a",
        warehouse_type: "fbs",
        status: "active",
      },
      {
        id: "warehouse_b",
        localStoreId: "store_b",
        warehouse_id: "fbs-b",
        warehouse_type: "fbs",
        status: "active",
      },
      {
        id: "warehouse_b_fbo",
        localStoreId: "store_b",
        warehouse_id: "fbo-b",
        warehouse_type: "fbo",
        status: "active",
      },
      {
        id: "warehouse_b_rfbs",
        localStoreId: "store_b",
        warehouse_id: "rfbs-b",
        warehouse_type: "rfbs",
        status: "active",
      },
      {
        id: "warehouse_b_archived_only",
        localStoreId: "store_b",
        warehouse_id: "fbs-b-archived",
        warehouse_type: "fbs",
        status: "active",
      },
    ],
    favorites: [
      { id: "favorite_a", storeId: "store_a" },
      { id: "favorite_b", storeId: "store_b" },
    ],
    collectBox: [
      { id: "collect_a", accountId: accountA.id },
      { id: "collect_b", accountId: accountB.id },
    ],
    files: [
      { id: "file_a", key: "a.xlsx", createdBy: accountA.id },
      { id: "file_b", key: "b.xlsx", createdBy: accountB.id },
    ],
  },
  jobs: {
    job_a: { id: "job_a", accountId: accountA.id },
    job_b: { id: "job_b", accountId: accountB.id },
  },
  reports: [],
});

assert.deepEqual(storesForAccount(state, accountA.id).map((store) => store.id), ["store_a"]);
assert.deepEqual(storesForAccount(state, accountB.id).map((store) => store.id), ["store_b"]);
assert.equal(activeStore(state, "store_b", accountA.id), null);
assert.equal(activeStore(state, "store_b", accountB.id)?.id, "store_b");
assert.equal(currentStoreIdForAccount(state, accountB.id), "store_b");

setCurrentStoreForAccount(state, accountB.id, "store_b");
assert.equal(currentStoreIdForAccount(state, accountB.id), "store_b");
assert.equal(state.currentStoreId, "store_a", "switching another account must not mutate the active account context");

const payloadB = localStatePayload(state, { account: accountB, token: "token-b", authenticated: true });
assert.deepEqual(payloadB.stores.map((store) => store.id), ["store_b"]);
assert.equal(payloadB.binding.id, "store_b");
assert.deepEqual(payloadB.caches.collectBox.map((item) => item.id), ["collect_b"]);
assert.deepEqual(payloadB.caches.files.map((file) => file.id), ["file_b"]);
assert.deepEqual(payloadB.caches.products.map((item) => item.id), ["product_b", "product_b_archived"]);
assert.equal("postings" in payloadB.caches, false);
assert.equal("promotions" in payloadB.caches, false);
assert.equal("returns" in payloadB.caches, false);
assert.equal("refunds" in payloadB.caches, false);
assert.deepEqual(payloadB.caches.warehouses.map((item) => item.id), [
  "warehouse_b",
  "warehouse_b_fbo",
  "warehouse_b_rfbs",
  "warehouse_b_archived_only",
]);
assert.deepEqual(payloadB.caches.warehouses[0].listingEligibility, {
  eligible: true,
  code: "ELIGIBLE_ACTIVE_FBS",
  fulfillmentType: "FBS",
  evidenceRequired: false,
});
assert.deepEqual(payloadB.caches.warehouses[1].listingEligibility, {
  eligible: false,
  code: "UNSUPPORTED_FULFILLMENT_TYPE",
  fulfillmentType: "FBO",
  evidenceRequired: false,
});
assert.deepEqual(payloadB.caches.warehouses[2].listingEligibility, {
  eligible: false,
  code: "RFBS_VALIDATION_REQUIRED",
  fulfillmentType: "RFBS",
  evidenceRequired: true,
});
assert.deepEqual(payloadB.caches.warehouses[3].listingEligibility, {
  eligible: false,
  code: "NO_ACTIVE_PRODUCT_ASSOCIATION",
  fulfillmentType: "FBS",
  evidenceRequired: false,
});
assert.equal(payloadB.caches.warehouses.some((item) => item.warehouse_id === "fbs-a"), false);
assert.deepEqual(payloadB.caches.favorites.map((item) => item.id), ["favorite_b"]);
assert.equal(payloadB.summary.products, 2);
assert.equal("postings" in payloadB.summary, false);
assert.equal("totalGmv" in payloadB.summary, false);
assert.deepEqual(Object.keys(payloadB.jobs), ["job_b"]);

const noCrossStoreCurrency = localStatePayload(ensureAccountState({
  accounts: [accountA],
  sessions: {},
  stores: [
    { id: "store_unknown", ownerAccountId: accountA.id, label: "Unknown", clientId: "unknown" },
    { id: "store_cny", ownerAccountId: accountA.id, label: "CNY", clientId: "cny",
      currencyCode: "CNY", currencySource: "OZON_SELLER_INFO", currencySyncedAt: "2026-08-13T00:00:00.000Z" },
  ],
  currentAccountId: accountA.id,
  currentStoreId: "store_unknown",
  currentStoreIdsByAccount: { [accountA.id]: "store_unknown" },
  caches: {
    products: [{ id: "cny-product", storeId: "store_cny", currency_code: "CNY" }],
    postings: [{ id: "historical-cny-order", storeId: "store_cny", total_price: "8.88" }],
    warehouses: [], collectBox: [], favorites: [], promotions: [], returns: [], refunds: [],
  },
  jobs: {},
  reports: [],
  auditEvents: [],
}), { account: accountA, token: "token-a", authenticated: true });
assert.equal(noCrossStoreCurrency.binding.currencyCode, "");
assert.equal(noCrossStoreCurrency.stores.find((store) => store.id === "store_unknown").currencyCode, "");
assert.equal(noCrossStoreCurrency.stores.find((store) => store.id === "store_cny").currencyCode, "CNY");
assert.equal("postings" in noCrossStoreCurrency.caches, false);
assert.equal("currencyCode" in noCrossStoreCurrency.summary, false);
assert.equal("totalGmv" in noCrossStoreCurrency.summary, false);

assert.equal(canAccessLocalFile(state.caches.files[0], accountB), false);
assert.equal(canAccessLocalFile(state.caches.files[1], accountB), true);

const duplicateProductIdCache = [];
const firstStore = { id: "same_account_store_1", clientId: "101", label: "First", ownerAccountId: accountA.id };
const secondStore = { id: "same_account_store_2", clientId: "102", label: "Second", ownerAccountId: accountA.id };
upsertProductByStore(duplicateProductIdCache, firstStore, "shared_product", {
  id: "shared_product",
  storeId: firstStore.id,
  clientId: firstStore.clientId,
  title: "first product",
});
upsertProductByStore(duplicateProductIdCache, secondStore, "shared_product", {
  id: "shared_product",
  storeId: secondStore.id,
  clientId: secondStore.clientId,
  title: "second product",
});
assert.equal(duplicateProductIdCache.length, 2, "the same Ozon product id must remain isolated per store");
assert.equal(cacheItemsForStore(duplicateProductIdCache, firstStore)[0]?.title, "first product");
assert.equal(cacheItemsForStore(duplicateProductIdCache, secondStore)[0]?.title, "second product");
assert.equal(cacheItemMatchesStore(duplicateProductIdCache[0], secondStore), false);

async function requestJson(method, pathname, body, authorization = "", {
  beforeBodyRead,
} = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(beforeBodyRead
    ? (async function* requestBody() {
      await beforeBodyRead();
      if (payload) yield Buffer.from(payload);
    }())
    : (payload ? [Buffer.from(payload)] : []));
  req.method = method;
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
    ...(authorization ? { authorization } : {}),
  };
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  try {
    await handle(req, res);
  } catch (error) {
    return { thrown: error, status: res.status, body: {} };
  }
  return {
    status: res.status,
    body: JSON.parse(res.body || "{}"),
  };
}

const routeToken = "store-sync-route-token";
const routeTokenB = "store-sync-route-token-b";
await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify({
  token: routeToken,
  currentAccountId: accountA.id,
  sessionIssuedAt: "2026-07-29T00:00:00.000Z",
  sessions: {
    [routeToken]: {
      token: routeToken,
      accountId: accountA.id,
      issuedAt: "2026-07-29T00:00:00.000Z",
    },
    [routeTokenB]: {
      token: routeTokenB,
      accountId: accountB.id,
      issuedAt: "2026-07-29T00:00:00.000Z",
    },
  },
  accounts: [accountA, accountB],
  stores: [
    {
      id: "store_a",
      ownerAccountId: accountA.id,
      clientId: "client-a-secret",
      apiKey: "api-key-a-secret",
      status: "active",
    },
    {
      id: "store_b",
      ownerAccountId: accountB.id,
      clientId: "client-b-secret",
      apiKey: "api-key-b-secret",
      status: "active",
    },
  ],
  currentStoreId: "store_a",
  currentStoreIdsByAccount: {
    [accountA.id]: "store_a",
    [accountB.id]: "store_b",
  },
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    promotions: [],
  },
  jobs: {},
  reports: [],
  auditEvents: [],
  hashes: {},
  leases: {},
  browserAgents: {},
}), "utf8");

const originalFetch = globalThis.fetch;
try {
  let routeFetchCalls = 0;
  let failWarehouse = true;
  globalThis.fetch = async (url) => {
    routeFetchCalls += 1;
    const apiPath = new URL(url).pathname;
    if (apiPath === "/v1/seller/info") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: { company: { name: "Route Seller" } } }),
      };
    }
    if (apiPath === "/v2/warehouse/list") {
      if (!failWarehouse) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ result: [{ warehouse_id: "warehouse-route" }] }),
        };
      }
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({
          code: "WAREHOUSE.DENIED",
          message: "client-a-secret api-key-a-secret must not escape",
          details: { token: "nested-secret" },
        }),
      };
    }
    if (apiPath === "/v1/actions") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          result: [{ id: "promotion-route", title: "Route promotion" }],
        }),
      };
    }
    throw new Error(`unexpected route request: ${apiPath}`);
  };

  const forbiddenStoreSync = await requestJson(
    "POST",
    "/local/sync/WAREHOUSES",
    {
      storeId: "store_b",
      jobId: "task_forbidden_store",
      requestId: "request_forbidden_store",
    },
    `Bearer ${routeToken}`,
  );
  assert.equal(forbiddenStoreSync.thrown, undefined);
  assert.equal(forbiddenStoreSync.status, 400);
  assert.deepEqual(forbiddenStoreSync.body, {
    ok: false,
    accountId: "acct_a",
    storeId: "store_b",
    type: "WAREHOUSES",
    timestamp: forbiddenStoreSync.body.timestamp,
    taskId: forbiddenStoreSync.body.taskId,
    requestId: "request_forbidden_store",
    code: "STORE_NOT_FOUND",
    message: "未找到已绑定门店",
    details: {},
  });
  assert.equal(Number.isNaN(Date.parse(forbiddenStoreSync.body.timestamp)), false);
  assert.match(forbiddenStoreSync.body.taskId, /^store_sync_[0-9a-f]{40}$/);
  assert.notEqual(forbiddenStoreSync.body.taskId, "task_forbidden_store");
  assert.equal(routeFetchCalls, 0);

  const failedSync = await requestJson(
    "POST",
    "/local/sync/WAREHOUSES",
    {
      storeId: "store_a",
      jobId: "task_route_failure",
      requestId: "request_route_failure",
    },
    `Bearer ${routeToken}`,
  );
  assert.equal(failedSync.thrown, undefined);
  assert.equal(failedSync.status, 403);
  assert.deepEqual(failedSync.body, {
    ok: false,
    accountId: "acct_a",
    storeId: "store_a",
    type: "WAREHOUSES",
    timestamp: failedSync.body.timestamp,
    taskId: failedSync.body.taskId,
    requestId: "request_route_failure",
    code: "ZONGZI_HTTP_403",
    message: "Ozon 403: /v2/warehouse/list (ZONGZI_HTTP_403)",
    details: {
      status: 403,
      apiPath: "/v2/warehouse/list",
      responseFormat: "json",
    },
  });
  assert.equal(Number.isNaN(Date.parse(failedSync.body.timestamp)), false);
  assert.match(failedSync.body.taskId, /^store_sync_[0-9a-f]{40}$/);
  assert.equal(JSON.stringify(failedSync.body).includes("client-a-secret"), false);
  assert.equal(JSON.stringify(failedSync.body).includes("api-key-a-secret"), false);
  assert.equal(JSON.stringify(failedSync.body).includes("nested-secret"), false);
  failWarehouse = false;

  const sharedRouteBody = {
    storeId: "store_a",
    jobId: "shared-route-client-key",
    requestId: "shared-route-request",
  };
  const accountAFirst = await requestJson(
    "POST",
    "/local/sync/WAREHOUSES",
    sharedRouteBody,
    `Bearer ${routeToken}`,
  );
  assert.equal(accountAFirst.status, 200);
  const callsAfterAccountAFirst = routeFetchCalls;
  const accountAReplay = await requestJson(
    "POST",
    "/local/sync/WAREHOUSES",
    sharedRouteBody,
    `Bearer ${routeToken}`,
  );
  assert.equal(accountAReplay.status, 200);
  assert.deepEqual(accountAReplay.body.job, accountAFirst.body.job);
  assert.equal(routeFetchCalls, callsAfterAccountAFirst);

  const changedRequest = await requestJson(
    "POST",
    "/local/sync/WAREHOUSES",
    { ...sharedRouteBody, requestId: "changed-route-request" },
    `Bearer ${routeToken}`,
  );
  assert.equal(changedRequest.status, 409);
  assert.equal(changedRequest.body.code, "SYNC_IDEMPOTENCY_CONFLICT");
  const changedScope = await requestJson(
    "POST",
    "/local/sync/PRODUCTS",
    sharedRouteBody,
    `Bearer ${routeToken}`,
  );
  assert.equal(changedScope.status, 409);
  assert.equal(changedScope.body.code, "SYNC_IDEMPOTENCY_CONFLICT");

  const accountBFirst = await requestJson(
    "POST",
    "/local/sync/WAREHOUSES",
    {
      ...sharedRouteBody,
      storeId: "store_b",
    },
    `Bearer ${routeTokenB}`,
  );
  assert.equal(accountBFirst.status, 200);
  assert.notEqual(accountAFirst.body.job.taskId, accountBFirst.body.job.taskId);

  const persistedRoute = JSON.parse(
    await readFile(path.join(dataDir, "local-state.json"), "utf8"),
  );
  assert.equal(persistedRoute.jobs[accountAFirst.body.job.taskId].accountId, "acct_a");
  assert.equal(persistedRoute.jobs[accountBFirst.body.job.taskId].accountId, "acct_b");
  assert.deepEqual(
    persistedRoute.reports
      .filter((report) => report.clientJobId === "shared-route-client-key")
      .map((report) => report.accountId)
      .sort(),
    ["acct_a", "acct_b"],
  );
  assert.equal(new Set(
    persistedRoute.auditEvents
      .filter((event) => event.action === "SYNC_WAREHOUSES" && event.status === "SUCCESS")
      .map((event) => event.eventId),
  ).size, 2);

  const callsBeforePersistenceFailure = routeFetchCalls;
  let persistenceFailure;
  try {
    persistenceFailure = await requestJson(
      "POST",
      "/local/sync/WAREHOUSES",
      {
        storeId: "store_a",
        jobId: "persist-failure-client-key",
        requestId: "persist-failure-request",
      },
      `Bearer ${routeToken}`,
      {
        beforeBodyRead: () => chmod(dataDir, 0o500),
      },
    );
  } finally {
    await chmod(dataDir, 0o700);
  }
  assert.equal(persistenceFailure.thrown, undefined);
  assert.equal(persistenceFailure.status, 503);
  assert.deepEqual(persistenceFailure.body, {
    ok: false,
    accountId: "acct_a",
    storeId: "store_a",
    type: "WAREHOUSES",
    timestamp: persistenceFailure.body.timestamp,
    taskId: persistenceFailure.body.taskId,
    requestId: "persist-failure-request",
    code: "SYNC_STATE_UNAVAILABLE",
    message: "同步状态暂时不可用",
    details: {},
  });
  assert.equal(Number.isNaN(Date.parse(persistenceFailure.body.timestamp)), false);
  assert.match(persistenceFailure.body.taskId, /^store_sync_[0-9a-f]{40}$/);
  assert.equal(routeFetchCalls, callsBeforePersistenceFailure);
  for (const secret of [
    "client-a-secret",
    "api-key-a-secret",
    "persist-failure-client-key",
  ]) {
    assert.equal(JSON.stringify(persistenceFailure.body).includes(secret), false);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}

console.log("account store isolation smoke passed");
