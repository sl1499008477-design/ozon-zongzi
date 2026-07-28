import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "qh-import-currency-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "local-test-token";
const storeId = "local_currency_store";

await writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: "acct_currency_test",
  sessionIssuedAt: "2026-01-01T00:00:00.000Z",
  accounts: [{
    id: "acct_currency_test",
    username: "currency-test",
    displayName: "Currency Test",
    role: "admin",
    status: "active",
  }],
  currentStoreId: storeId,
  stores: [{ id: storeId, label: "currency-store", clientId: "currency-client", apiKey: "currency-key" }],
  caches: {
    products: [
      { id: "p1", storeId, currency_code: "CNY", price: "100.00" },
      { id: "p2", storeId, currency_code: "CNY", price: "120.00" },
    ],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
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
  return originalFetch(url, options);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";

try {
  const { handle } = await import("../index.mjs");

  const item = {
    offer_id: "currency-contract-test",
    name: "Currency contract item",
    price: "469.03",
    old_price: "586.29",
    currency_code: "RUB",
    images: ["https://cdn.example.test/main.jpg"],
    description_category_id: 17031664,
    type_id: 971001,
    scraped_sku: "1424490696",
    scraped_description: "Currency contract description",
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
  assert.equal(response.body.items?.[0]?.currency_code, "CNY");
  assert.equal(response.body.items?.[0]?.currencyCode, undefined, "Ozon payload should only keep currency_code after normalization");

  console.log("import currency contract smoke passed");
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
