import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-retired-secondary-operations-"));

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, method, pathname, token = "token_a") {
  const req = Readable.from([]);
  req.method = method;
  req.url = pathname;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = String(body || ""); },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const historicalState = {
  sessions: {
    token_a: { token: "token_a", accountId: "acct_a", issuedAt: "2026-09-06T00:00:00.000Z" },
  },
  accounts: [
    { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" },
  ],
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", apiKey: "key_a" },
  ],
  currentStoreIdsByAccount: { acct_a: "store_a" },
  caches: {
    products: [{ id: "product_a", accountId: "acct_a", storeId: "store_a" }],
    warehouses: [{ id: "warehouse_a", accountId: "acct_a", storeId: "store_a" }],
    collectBox: [],
    favorites: [],
    productTemplates: [],
    files: [],
    announcements: [],
    postings: [{ id: "posting_a", accountId: "acct_a", storeId: "store_a" }],
    promotions: [{ id: "promotion_a", accountId: "acct_a", storeId: "store_a" }],
    returns: [{ id: "return_a", accountId: "acct_a", storeId: "store_a" }],
    refunds: [{ id: "refund_a", accountId: "acct_a", storeId: "store_a" }],
    messageTemplates: [{ id: "message_template_a", accountId: "acct_a", storeId: "store_a" }],
    messageHistory: [{ id: "message_history_a", accountId: "acct_a", storeId: "store_a" }],
  },
  jobs: {
    product_job: { id: "product_job", accountId: "acct_a", type: "PRODUCT_IMPORT" },
    posting_job: { id: "posting_job", accountId: "acct_a", jobKind: "STORE_SYNC", type: "POSTINGS" },
    promotion_job: { id: "promotion_job", accountId: "acct_a", jobKind: "STORE_SYNC", type: "PROMOTIONS" },
  },
  reports: [
    { id: "posting_report", accountId: "acct_a", jobKind: "STORE_SYNC", type: "POSTINGS" },
  ],
  auditEvents: [],
};

const retiredCacheKeys = [
  "postings",
  "promotions",
  "returns",
  "refunds",
  "messageTemplates",
  "messageHistory",
];
const retiredSummaryKeys = [
  "postings",
  "postingsTotal",
  "todayPostings",
  "weekPostings",
  "awaitingPackaging",
  "awaitingDeliver",
  "pendingPostings",
  "statusCounts",
  "grossRevenue",
  "settledRevenue",
  "promotions",
  "returns",
  "refunds",
  "messageTemplates",
  "messageHistory",
];

try {
  await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(historicalState), "utf8");
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = async () => {
    externalRequests += 1;
    throw new Error("retired operations must not call external services");
  };
  try {
    const { handle } = await import("../index.mjs");

    const state = await requestJson(handle, "GET", "/local/state");
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.caches.products.map((item) => item.id), ["product_a"]);
    assert.deepEqual(state.body.caches.warehouses.map((item) => item.id), ["warehouse_a"]);
    for (const key of retiredCacheKeys) assert.equal(key in state.body.caches, false, `${key} must not be public`);
    for (const key of retiredSummaryKeys) assert.equal(key in state.body.summary, false, `${key} must not be summarized`);
    assert.deepEqual(Object.keys(state.body.jobs), ["product_job"]);

    const retiredRoutes = [
      ["POST", "/local/sync/POSTINGS"],
      ["POST", "/local/sync/PROMOTIONS"],
      ["POST", "/ozon/postings/cache/import"],
      ["GET", "/ozon/returns"],
      ["POST", "/ozon/returns/batch"],
      ["GET", "/ozon/message-templates"],
      ["POST", "/ozon/message-templates"],
      ["PUT", "/ozon/message-templates/message_template_a"],
      ["DELETE", "/ozon/message-templates/message_template_a"],
      ["GET", "/ozon/message-history"],
      ["POST", "/ozon/message-history/batch"],
    ];
    for (const [method, pathname] of retiredRoutes) {
      const response = await requestJson(handle, method, pathname);
      assert.equal(response.status, 410, `${method} ${pathname} must be retired`);
      assert.equal(response.body.code, "FEATURE_RETIRED");
    }
    assert.equal(externalRequests, 0);

    const persisted = JSON.parse(await readFile(path.join(dataDir, "local-state.json"), "utf8"));
    for (const key of retiredCacheKeys) {
      assert.deepEqual(persisted.caches[key], historicalState.caches[key], `${key} history must be preserved`);
    }
    assert.deepEqual(persisted.jobs, historicalState.jobs);
    assert.deepEqual(persisted.reports, historicalState.reports);
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("retired secondary operations test passed");
