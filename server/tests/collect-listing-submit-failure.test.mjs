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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "qh-collect-submit-failure-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "local-test-token";
const storeId = "local_submit_store";
const collectId = "collect-submit-failure";

await writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: "acct_submit_test",
  sessionIssuedAt: "2026-01-01T00:00:00.000Z",
  accounts: [{
    id: "acct_submit_test",
    username: "submit-test",
    displayName: "Submit Test",
    role: "admin",
    status: "active",
  }],
  currentStoreId: storeId,
  stores: [{
    id: storeId,
    ownerAccountId: "acct_submit_test",
    label: "submit-store",
    clientId: "submit-client",
    apiKey: "submit-key",
  }],
  caches: {
    collectBox: [{
      id: collectId,
      accountId: "acct_submit_test",
      storeId,
      localStoreId: storeId,
      sku: "4260049338",
      status: "待处理",
      listingDraft: {
        sku: "4260049338",
        title: "Collect listing submit item",
        price: "100",
        currencyCode: "CNY",
        descriptionCategoryId: 17028941,
        typeId: 91670,
        packageWeight: "799",
        packageLength: "350",
        packageWidth: "85",
        packageHeight: "50",
        listingWarehouseId: "1020003087687000",
        listingStock: "5",
        images: ["https://cdn.example.test/main.jpg"],
      },
    }],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const originalFetch = globalThis.fetch;
let externalWriteCalls = 0;
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.endsWith("/v1/description-category/attribute")) {
    return new Response(JSON.stringify({
      result: [
        { id: 4180 },
        { id: 4191 },
        { id: 4497 },
        { id: 9454 },
        { id: 9455 },
        { id: 9456 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (href.endsWith("/v3/product/import")) {
    externalWriteCalls += 1;
    const error = new TypeError("fetch failed");
    error.cause = { code: "UND_ERR_SOCKET", message: "other side closed" };
    throw error;
  }
  return originalFetch(url);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.LISTING_PIPELINE_V3 = "0";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

try {
  const { handle } = await import("../index.mjs");
  const response = await requestJson(
    handle,
    `/ozon/collect-box/${collectId}/listing/submit`,
    { storeId, strictTypeMatch: true },
    token,
    storeId,
  );

  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "LISTING_PIPELINE_REQUIRED");
  assert.match(response.body.message, /安全上架任务队列/);
  assert.equal(externalWriteCalls, 0);

  const state = JSON.parse(await readFile(dataFile, "utf8"));
  const item = state.caches.collectBox.find((row) => row.id === collectId);
  assert.equal(item.status, "失败");
  assert.equal(item.listingTaskId, "");
  assert.equal(item.listingJobId, "");
  assert.match(item.listingLastError, /安全上架任务队列/);

  console.log("collect listing fail-closed smoke passed");
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
