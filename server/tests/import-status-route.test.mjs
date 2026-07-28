import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

async function requestJson(handle, pathname, body, token, storeId) {
  const payload = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(payload)]);
  req.method = "POST";
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-ozon-store-id": storeId,
  };
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "qh-import-status-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "local-test-token";
const storeId = "local_status_store";
let mode = "success";

const writeState = async (jobs, caches = {}) => writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: "acct_status_test",
  sessionIssuedAt: "2026-01-01T00:00:00.000Z",
  accounts: [{
    id: "acct_status_test",
    username: "status-test",
    displayName: "Status Test",
    role: "admin",
    status: "active",
  }],
  currentStoreId: storeId,
  stores: [{ id: storeId, label: "status-store", clientId: "status-client", apiKey: "status-key" }],
  caches,
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs,
  reports: [],
}, null, 2)}\n`, "utf8");

await writeState({
  job_success: {
    id: "job_success",
    localTaskId: "job_success",
    listing: true,
    type: "PRODUCT_IMPORT",
    status: "QUEUED",
    ozonTaskId: 555,
    collectBoxId: "sku_success",
    storeId,
    itemCount: 1,
  },
}, {
  collectBox: [{
    id: "sku_success",
    sku: "sku_success",
    status: "上架中",
    listingTaskId: 555,
    listingJobId: "job_success",
  }],
});

const originalFetch = globalThis.fetch;
const fetchRequests = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  fetchRequests.push(href);
  if (href.endsWith("/v1/product/import/info")) {
    if (mode === "success") {
      return new Response(JSON.stringify({
        result: {
          items: [{ offer_id: "offer-success", product_id: 991, status: "imported", status_description: "商品已导入", errors: [] }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (mode === "skipped") {
      return new Response(JSON.stringify({
        result: {
          items: [{ offer_id: "offer-skipped", product_id: 992, status: "skipped", status_description: "", errors: [] }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "task not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected test fetch URL: ${href}`);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";

try {
  const { handle } = await import("../index.mjs");

  const success = await requestJson(
    handle,
    "/ozon/products/import/status",
    { task_id: 555 },
    token,
    storeId,
  );
  assert.equal(success.status, 200);
  assert.equal(success.body.ok, true);
  assert.equal(success.body.status, "SUCCESS");
  assert.equal(success.body.done, true);

  let state = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(state.jobs.job_success.status, "SUCCESS");
  assert.equal(state.jobs.job_success.statusResponse.result.items[0].status, "imported");
  assert.equal(state.caches.collectBox[0].status, "已上架");
  assert.equal(state.caches.collectBox[0].listingLastError, "");

  mode = "skipped";
  await writeState({
    job_skipped: {
      id: "job_skipped",
      localTaskId: "job_skipped",
      listing: true,
      type: "COLLECT_BOX_DRAFT",
      status: "QUEUED",
      ozonTaskId: 556,
      collectBoxId: "sku_skipped",
      storeId,
      itemCount: 1,
    },
  }, {
    collectBox: [{
      id: "sku_skipped",
      sku: "sku_skipped",
      status: "上架中",
      listingTaskId: 556,
      listingJobId: "job_skipped",
    }],
  });

  const skipped = await requestJson(
    handle,
    "/ozon/products/import/status",
    { task_id: 556 },
    token,
    storeId,
  );
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.status, "SKIPPED");
  assert.equal(skipped.body.done, true);

  state = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(state.jobs.job_skipped.status, "SKIPPED");
  assert.match(state.jobs.job_skipped.statusMessage, /没有创建或更新/);
  assert.equal(state.caches.collectBox[0].status, "已跳过");
  assert.equal(state.caches.collectBox[0].listingLastError, "");

  mode = "not-found";
  await writeState({
    job_missing: {
      id: "job_missing",
      localTaskId: "job_missing",
      listing: true,
      type: "PRODUCT_IMPORT",
      status: "QUEUED",
      ozonTaskId: 777,
      storeId,
      itemCount: 1,
    },
  });

  const failed = await requestJson(
    handle,
    "/ozon/products/import/status",
    { task_id: 777 },
    token,
    storeId,
  );
  assert.equal(failed.status, 404);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.status, "QUEUED");
  assert.equal(failed.body.done, false);
  assert.equal(failed.body.check_failed, true);

  state = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(state.jobs.job_missing.status, "QUEUED");
  assert.match(state.jobs.job_missing.statusCheckError, /task not found|Ozon 404/);
  assert.equal(fetchRequests.length, 3, "each status request must perform exactly one allowlisted lookup");
  assert.equal(
    fetchRequests.every((href) => href.endsWith("/v1/product/import/info")),
    true,
    "status tests may call only the import-info endpoint",
  );

  console.log("import status route smoke passed");
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
