import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-external-write-safety-"));
const token = "safe-write-token";
const storeId = "safe-write-store";

const serverDir = new URL("../", import.meta.url);
for (const file of (await readdir(serverDir)).filter((name) => name.startsWith("auto-listing") && name.endsWith(".mjs"))) {
  const source = await readFile(new URL(file, serverDir), "utf8");
  assert.doesNotMatch(source, /callOzonSellerApi|from\s+["']\.\/ozon-client\.mjs["']/u,
    `${file} must delegate external writes to the durable listing pipeline`);
}

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.LISTING_PIPELINE_V3 = "0";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, pathname, body) {
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
    writeHead(status) {
      this.status = status;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  try {
    await handle(req, res);
  } catch (error) {
    res.writeHead(Number(error?.status || 500));
    res.end(JSON.stringify({
      ok: false,
      code: error?.code || "LOCAL_ERROR",
      message: error?.message || "本地服务异常",
    }));
  }
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify({
  token,
  currentAccountId: "safe-write-account",
  sessionIssuedAt: "2026-07-27T00:00:00.000Z",
  accounts: [{
    id: "safe-write-account",
    username: "safe-write",
    displayName: "Safe Write",
    role: "admin",
    status: "active",
  }],
  currentStoreId: storeId,
  stores: [{
    id: storeId,
    ownerAccountId: "safe-write-account",
    label: "Safe Write Store",
    clientId: "client",
    apiKey: "secret",
  }],
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
    favorites: [],
    promotions: [],
    returns: [],
    refunds: [],
    announcements: [],
    messageTemplates: [],
    messageHistory: [],
    productTemplates: [],
    files: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
}), "utf8");

const originalFetch = globalThis.fetch;
let externalWriteCalls = 0;
globalThis.fetch = async (url, options = {}) => {
  if (
    String(url).includes("api-seller.ozon.ru")
    && ["POST", "PUT", "PATCH", "DELETE"].includes(String(options.method || "GET").toUpperCase())
  ) {
    externalWriteCalls += 1;
  }
  return new Response(JSON.stringify({ result: { task_id: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const { handle } = await import("../index.mjs");
  const item = {
    offer_id: "offer-1",
    name: "Safe item",
    price: "100.00",
    currency_code: "RUB",
    images: ["https://example.invalid/1.jpg"],
    description_category_id: 1,
    type_id: 2,
  };

  for (const pathname of ["/ozon/products/import", "/ozon/products/import-by-sku"]) {
    const response = await requestJson(handle, pathname, { items: [item] });
    assert.equal(response.status, 503, `${pathname} must fail closed when the durable queue is unavailable`);
    assert.equal(response.body.code, "LISTING_PIPELINE_REQUIRED");
  }

  const stockResponse = await requestJson(handle, "/ozon/stocks/import", {
    stocks: [{ offer_id: "offer-1", warehouse_id: 1, stock: 5 }],
  });
  assert.equal(stockResponse.status, 409, "standalone inventory writes must remain disabled without reconciliation");
  assert.equal(stockResponse.body.code, "LOCAL_OZON_WRITE_DISABLED");
  assert.equal(externalWriteCalls, 0, "a rejected request must never call a real Ozon write endpoint");

  console.log("external write safety test passed");
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
