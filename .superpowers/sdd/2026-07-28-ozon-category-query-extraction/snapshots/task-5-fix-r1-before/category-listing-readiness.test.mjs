import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

async function requestJson(handle, pathname, body, token, storeId) {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.method = "POST";
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-ozon-store-id": storeId,
  };
  const res = {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(text = "") { this.body = String(text || ""); },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "ozon-category-listing-readiness-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "category-readiness-token";
const storeId = "category-readiness-store";
let externalWriteCalls = 0;

await writeFile(dataFile, JSON.stringify({
  token,
  currentAccountId: "category-readiness-account",
  sessionIssuedAt: "2026-07-28T00:00:00.000Z",
  accounts: [{ id: "category-readiness-account", username: "category-readiness", role: "admin", status: "active" }],
  currentStoreId: storeId,
  stores: [{ id: storeId, ownerAccountId: "category-readiness-account", label: "Category readiness", clientId: "local-client", apiKey: "local-key" }],
  caches: { collectBox: [] },
  hashes: {}, leases: {}, browserAgents: {}, jobs: {}, reports: [],
}), "utf8");

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.endsWith("/v1/description-category/attribute")) {
    const request = JSON.parse(String(options.body || "{}"));
    if (Number(request.type_id) === 2) {
      return new Response(JSON.stringify({ code: "UPSTREAM_FAILED" }), { status: 503 });
    }
    return new Response(JSON.stringify({ result: [
      { id: 4180 }, { id: 4191 }, { id: 4194 }, { id: 4195 }, { id: 4497 }, { id: 9454 }, { id: 9455 }, { id: 9456 },
      { id: 85, dictionary_id: 100, is_required: true, name: "品牌" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (href.endsWith("/v1/description-category/attribute/values")) {
    return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (href.endsWith("/v3/product/import")) externalWriteCalls += 1;
  throw new Error(`unexpected local test URL ${href}`);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.LISTING_PIPELINE_V3 = "0";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const item = (typeId, attributes = []) => ({
  offer_id: `readiness-${typeId}`,
  name: "Category readiness item",
  price: "100.00",
  currency_code: "RUB",
  images: ["https://cdn.example.test/item.jpg"],
  description_category_id: 1,
  type_id: typeId,
  weight: 100,
  depth: 100,
  width: 100,
  height: 100,
  attributes,
});

try {
  const { handle } = await import("../index.mjs");

  const unavailable = await requestJson(handle, "/ozon/products/import/preview", { items: [item(2)] }, token, storeId);
  assert.notEqual(unavailable.status, 200, "category failures must fail preview closed");
  assert.equal(unavailable.body.ok, false);
  assert.match(unavailable.body.code, /^OZON_CATEGORY_/);

  const unresolved = await requestJson(handle, "/ozon/products/import/preview", {
    entry: "COLLECT_EDIT_AUTO_CATEGORY",
    items: [item(3, [{ id: 85, values: [{ value: "不存在的品牌" }] }])],
  }, token, storeId);
  assert.notEqual(unresolved.status, 200, "auto-category preview must reject unresolved required dictionary values");
  assert.equal(unresolved.body.ok, false);

  const state = JSON.parse(await readFile(dataFile, "utf8"));
  assert.deepEqual(state.jobs, {}, "category readiness failure must not create a listing job");
  assert.equal(externalWriteCalls, 0, "category readiness failure must not write to Ozon");

  console.log("category listing readiness test passed");
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
