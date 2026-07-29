import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-data-store-removed-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "data-store-removed-token";

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

const fixture = {
  token,
  currentAccountId: "account-a",
  sessionIssuedAt: "2026-07-29T00:00:00.000Z",
  sessions: {
    [token]: {
      token,
      accountId: "account-a",
      issuedAt: "2026-07-29T00:00:00.000Z",
      currentDataCollectionStoreId: "data-store-a",
    },
  },
  accounts: [{
    id: "account-a",
    username: "account-a",
    role: "admin",
    status: "active",
  }],
  currentStoreId: "store-a",
  currentStoreIdsByAccount: { "account-a": "store-a" },
  stores: [{
    id: "store-a",
    ownerAccountId: "account-a",
    clientId: "client-a",
    apiKey: "secret-a",
  }],
  currentDataCollectionStoreId: "data-store-a",
  currentDataCollectionStoreIdsByAccount: { "account-a": "data-store-a" },
  dataCollectionStores: [{
    id: "data-store-a",
    ownerAccountId: "account-a",
    sellerCompanyId: "seller-company-a",
    label: "retired data store",
    status: "active",
  }],
  caches: {
    products: [],
    postings: [],
    warehouses: [],
    collectBox: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  auditEvents: [],
};

await writeFile(dataFile, JSON.stringify(fixture), "utf8");
const originalFetch = globalThis.fetch;
const externalCalls = [];
globalThis.fetch = async (...args) => {
  externalCalls.push(args);
  throw new Error("removed data-store route must not call an external service");
};
const { handle } = await import("../index.mjs");

async function requestJson(method, pathname, {
  authorization = "",
  rawBody = "{malformed-json",
} = {}) {
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
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
    res.writeHead(Number(error?.status || 500));
    res.end(JSON.stringify({
      ok: false,
      code: error?.code || "LOCAL_ERROR",
      message: error?.message || "本地服务异常",
    }));
  }
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const removedPaths = [
  "/local/data-collection-stores",
  "/local/current-data-collection-store",
  "/local/data-collection-stores/verify",
  "/local/data-collection-stores/data-store-a",
  "/local/current-data-collection-store/data-store-a",
];
const removedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

test("every retired data-store path and method returns 410 before auth, body parsing, state mutation, or external calls", async () => {
  const before = await readFile(dataFile, "utf8");
  for (const pathname of removedPaths) {
    for (const method of removedMethods) {
      const response = await requestJson(method, pathname);
      assert.equal(response.status, 410, `${method} ${pathname}`);
      assert.deepEqual(response.body, {
        ok: false,
        code: "DATA_COLLECTION_STORE_REMOVED",
        message: "数据采集店铺功能已移除，采集数据现在按 sonli 账号归属",
      }, `${method} ${pathname}`);
    }
  }
  assert.equal(externalCalls.length, 0);
  assert.equal(await readFile(dataFile, "utf8"), before);
});

test("retired data-store routing does not load local state", async () => {
  const hiddenDataFile = `${dataFile}.hidden`;
  await rename(dataFile, hiddenDataFile);
  try {
    const response = await requestJson("POST", "/local/data-collection-stores/verify");
    assert.equal(response.status, 410);
    assert.equal(response.body.code, "DATA_COLLECTION_STORE_REMOVED");
  } finally {
    await rename(hiddenDataFile, dataFile);
  }
});

test("authenticated and anonymous local-state payloads expose no retired data-store fields", async () => {
  const authenticated = await requestJson("GET", "/local/state", {
    authorization: `Bearer ${token}`,
    rawBody: "",
  });
  assert.equal(authenticated.status, 200);
  for (const field of [
    "currentDataCollectionStoreId",
    "dataCollectionStore",
    "dataCollectionStores",
  ]) {
    assert.equal(Object.hasOwn(authenticated.body, field), false, field);
  }

  const anonymous = await requestJson("GET", "/local/state", { rawBody: "" });
  assert.equal(anonymous.status, 200);
  for (const field of [
    "currentDataCollectionStoreId",
    "dataCollectionStore",
    "dataCollectionStores",
  ]) {
    assert.equal(Object.hasOwn(anonymous.body, field), false, field);
  }
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
});
