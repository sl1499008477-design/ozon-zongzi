import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-multivariant-ingest-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "multivariant-ingest-token";
const accountId = "acct_multivariant_ingest";
const storeId = "store_multivariant_ingest";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

await writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: accountId,
  accounts: [{ id: accountId, username: "multi-ingest", role: "admin", status: "active" }],
  sessions: {
    [token]: { token, accountId, issuedAt: new Date().toISOString() },
  },
  currentStoreId: storeId,
  stores: [{ id: storeId, label: "multi-ingest-store", clientId: "multi-ingest-client", apiKey: "test-key" }],
  caches: { collectBox: [] },
  jobs: {},
  hashes: {},
  leases: {},
  browserAgents: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const { handle } = await import("../index.mjs");

const firstSource = {
  description_category_id: 17000001,
  type_id: 910001,
  attributes: [{ key: "500", value: "Красный" }],
};
const secondSource = {
  description_category_id: 17000002,
  type_id: 910002,
  attributes: [{ key: "500", value: "Синий" }],
};
const raw = {
  sku: "sku-red",
  name: "Multi variant product",
  variantData: {
    variants: [
      { sku: "sku-red", name: "Red", sourceVariant: firstSource },
      { sku: "sku-blue", name: "Blue", sourceVariant: secondSource },
    ],
  },
};

const payload = JSON.stringify({ raw, storeId });
const req = Readable.from([Buffer.from(payload)]);
req.method = "POST";
req.url = "/sources/ozon/collect";
req.headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-ozon-store-id": storeId,
};
const res = {
  status: 0,
  body: "",
  writeHead(status) { this.status = status; },
  end(text = "") { this.body = String(text || ""); },
};

try {
  await handle(req, res);
  assert.equal(res.status, 200);
  const response = JSON.parse(res.body);
  assert.equal(response.data.variantData.variants.length, 2);
  assert.deepEqual(response.data.variantData.variants[0].sourceVariant, firstSource);
  assert.deepEqual(response.data.variantData.variants[1].sourceVariant, secondSource);

  const state = JSON.parse(await readFile(dataFile, "utf8"));
  const saved = state.caches.collectBox[0];
  assert.equal(saved.variantData.variants.length, 2);
  assert.deepEqual(saved.variantData.variants[0].sourceVariant, firstSource);
  assert.deepEqual(saved.variantData.variants[1].sourceVariant, secondSource);
  console.log("collect multivariant ingest persistence passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
