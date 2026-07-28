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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "qh-preview-route-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "local-test-token";
const storeId = "local_test_store";
let importCalls = 0;
let attributeCalls = 0;
const fetchRequests = [];

await writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: "acct_preview_test",
  sessionIssuedAt: "2026-01-01T00:00:00.000Z",
  accounts: [{
    id: "acct_preview_test",
    username: "preview-test",
    displayName: "Preview Test",
    role: "admin",
    status: "active",
  }],
  currentStoreId: storeId,
  stores: [{ id: storeId, label: "preview-store", clientId: "preview-client", apiKey: "preview-key" }],
  caches: {},
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  fetchRequests.push(href);
  if (href.endsWith("/v3/product/import")) {
    importCalls += 1;
    throw new Error("preview route must not call real product import");
  }
  if (href.endsWith("/v1/description-category/attribute")) {
    attributeCalls += 1;
    return new Response(JSON.stringify({
      result: [
        { id: 4180 },
        { id: 4191 },
        { id: 4194 },
        { id: 4195 },
        { id: 4497 },
        { id: 9454 },
        { id: 9455 },
        { id: 9456 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`Unexpected test fetch URL: ${href}`);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";

try {
  const { handle } = await import("../index.mjs");

  const item = {
    offer_id: "preview-1424490696",
    name: "Preview item",
    price: "469.03",
    currency_code: "RUB",
    images: [{ file_name: "https://cdn.example.test/main.jpg", default: true }],
    description_category_id: 17031664,
    type_id: 971001,
    scraped_sku: "1424490696",
    scraped_description: "Preview description",
    weight: 333,
    depth: 10,
    width: 20,
    height: 30,
  };

  const response = await requestJson(
    handle,
    "/ozon/products/import/preview",
    { items: [item], strictTypeMatch: true },
    token,
    storeId,
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.dryRun, true);
  assert.equal(response.body.itemCount, 1);
  assert.equal(response.body.items[0].offer_id, "preview-1424490696");
  assert.equal(response.body.items[0].description_category_id, 17031664);
  assert.equal(response.body.items[0].type_id, 971001);
  assert.equal(response.body.items[0].attributeCount > 0, true);
  assert.equal(importCalls, 0, "preview route must not call Ozon product import");
  assert.equal(attributeCalls, 1, "preview route should validate attributes once");
  assert.equal(fetchRequests.length, 1, "preview route must make only the allowlisted attribute request");
  assert.equal(fetchRequests[0].endsWith("/v1/description-category/attribute"), true);

  const state = JSON.parse(await readFile(dataFile, "utf8"));
  assert.deepEqual(state.jobs, {}, "preview route must not create import jobs");

  console.log("import preview route smoke passed");
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
