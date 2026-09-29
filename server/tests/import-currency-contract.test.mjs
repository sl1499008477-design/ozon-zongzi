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
  stores: [{
    id: storeId, label: "currency-store", clientId: "currency-client", apiKey: "currency-key",
    ownerAccountId: "acct_currency_test",
    currencyCode: "CNY", currencySource: "OZON_SELLER_INFO",
    currencySyncedAt: "2026-07-28T00:00:00.000Z",
  }],
  caches: {
    products: [
      { id: "p1", storeId, currency_code: "RUB", price: "100.00" },
      { id: "p2", storeId, currency_code: "RUB", price: "120.00" },
    ],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const originalFetch = globalThis.fetch;
const fetchRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  fetchRequests.push(href);
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
  throw new Error(`Unexpected test fetch URL: ${href}`);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

try {
  const { handle, testExports } = await import("../index.mjs");

  const multiVariantDraft = {
    id: "multi-price-draft", sku: "price-a", price: "555.35", currency_code: "RUB",
    listingDraft: {
      price: "50.00", currencyCode: "CNY",
      variants: [
        { sku: "price-a", sellPrice: "50.00", priceCurrency: "CNY" },
        { sku: "price-b", sellPrice: "", priceCurrency: "CNY" },
      ],
    },
  };
  const multiItems = testExports.buildCollectBoxListingItems(multiVariantDraft);
  assert.equal(multiItems[0].price, "50.00");
  assert.equal(multiItems[1].price, "", "a missing variant price must not borrow a sibling or source amount");
  assert.ok(testExports.validateCollectBoxListingDraft(multiVariantDraft, multiItems, [])
    .includes("第 2 个变体 缺少有效售价"));
  const singleItem = testExports.buildCollectBoxListingItems({
    ...multiVariantDraft,
    listingDraft: { ...multiVariantDraft.listingDraft, variants: [{ sku: "price-a" }] },
  });
  assert.equal(singleItem[0].price, "50.00", "a single variant can reuse its saved target-currency quote");
  const clearedQuote = testExports.buildCollectBoxListingItems({
    ...multiVariantDraft,
    listingDraft: {
      price: "", currencyCode: "CNY",
      variants: [{ sku: "price-a", sellPrice: "", price: "555.35", priceCurrency: "CNY" }],
    },
  });
  assert.equal(clearedQuote[0].price, "", "clearing a quote must not restore an embedded source price");
  assert.equal(testExports.buildCollectBoxListingItems({
    ...multiVariantDraft, listingDraft: { price: "", currencyCode: "CNY" },
  })[0].price, "", "a source amount with a different currency is not a target quote");

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

  const mismatch = await requestJson(
    handle,
    "/ozon/products/import/preview",
    { items: [item], strictTypeMatch: true },
    token,
    storeId,
  );

  assert.equal(mismatch.status, 422, "RUB amounts cannot be relabeled as CNY");
  assert.equal(mismatch.body.code, "IMPORT_CURRENCY_MISMATCH");
  assert.match(mismatch.body.message, /RUB.*CNY/);
  assert.equal(fetchRequests.length, 0, "currency mismatch is rejected before Ozon requests");
  const fixtureState = JSON.parse(await readFile(dataFile, "utf8"));
  await assert.rejects(
    () => testExports.queueCollectSubmissionV3(
      fixtureState,
      { headers: { authorization: `Bearer ${token}`, "x-ozon-store-id": storeId } },
      { items: [item], storeId },
      null,
    ),
    (error) => error.status === 422 && error.code === "IMPORT_CURRENCY_MISMATCH",
    "the submission boundary also rejects mismatched amounts before creating a job",
  );
  assert.equal(fetchRequests.length, 0);

  const response = await requestJson(
    handle,
    "/ozon/products/import/preview",
    { items: [{ ...item, currency_code: "CNY" }], strictTypeMatch: true },
    token,
    storeId,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.items?.[0]?.currency_code, "CNY");
  assert.equal(response.body.items?.[0]?.currencyCode, undefined, "Ozon payload should only keep currency_code after normalization");
  assert.equal(response.body.items?.[0]?.price, item.price, "explicit target-currency prices are preserved");
  assert.equal(fetchRequests.length, 1, "preview validation must perform exactly one allowlisted attribute lookup");
  assert.equal(fetchRequests[0].endsWith("/v1/description-category/attribute"), true);

  const implicitTarget = await requestJson(
    handle,
    "/ozon/products/import/preview",
    { items: [{ ...item, currency_code: undefined }], strictTypeMatch: true },
    token,
    storeId,
  );
  assert.equal(implicitTarget.status, 200);
  assert.equal(implicitTarget.body.items?.[0]?.currency_code, "CNY");
  assert.equal(implicitTarget.body.items?.[0]?.price, item.price);

  console.log("import currency contract smoke passed");
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
