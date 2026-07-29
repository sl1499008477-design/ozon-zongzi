import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-extension-sync-removed-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "extension-sync-removed-token";

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
const ozonCalls = [];
globalThis.fetch = async (...args) => {
  ozonCalls.push(args);
  throw new Error("retired extension route must not call Ozon");
};
const { handle } = await import("../index.mjs");

async function requestJson(method, pathname, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-device-fingerprint": "retired-extension",
    "x-ozon-store-id": "store-a",
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

const retiredRoutes = [
  ["PUT", "/auth/device/heartbeat", {}],
  ["GET", "/ozon/sync/client-intervals"],
  ["GET", "/ozon/stores/store-a/sync-credentials"],
  ["POST", "/ozon/sync/lease/acquire", {
    storeId: "store-a",
    type: "PRODUCTS",
    deviceId: "retired-extension",
  }],
  ["POST", "/ozon/sync/lease/heartbeat", {
    leaseId: "lease-old",
    deviceId: "retired-extension",
  }],
  ["POST", "/ozon/sync/lease/release", {
    leaseId: "lease-old",
    deviceId: "retired-extension",
  }],
  ["POST", "/ozon/sync/client-report", {
    clientJobId: "job-old",
    storeId: "store-a",
    type: "PRODUCTS",
    status: "SUCCESS",
  }],
  ["POST", "/ozon/cache/import-with-hash", {
    storeId: "store-a",
    leaseId: "lease-old",
    deviceId: "retired-extension",
    items: [{ id: "product-old", contentHash: "hash-old" }],
  }],
  ["POST", "/ozon/postings/cache/import", {
    storeId: "store-a",
    leaseId: "lease-old",
    deviceId: "retired-extension",
    items: [{ posting_number: "posting-old" }],
  }],
  ["POST", "/ozon/warehouses/cache/import", {
    storeId: "store-a",
    leaseId: "lease-old",
    deviceId: "retired-extension",
    items: [{ warehouse_id: "warehouse-old" }],
  }],
];

test("every retired extension sync contract returns stable 410 without side effects", async () => {
  const before = await readFile(dataFile, "utf8");
  for (const [method, pathname, body] of retiredRoutes) {
    const response = await requestJson(method, pathname, body);
    assert.equal(response.status, 410, `${method} ${pathname}`);
    assert.deepEqual(response.body, {
      ok: false,
      code: "EXTENSION_SYNC_REMOVED",
      message: "插件同步已移除，请更新插件并在 Web 端执行同步",
    }, `${method} ${pathname}`);
  }
  assert.equal(ozonCalls.length, 0);
  assert.equal(await readFile(dataFile, "utf8"), before);
});

test("Web local sync route is not captured by the extension retirement allowlist", async () => {
  const response = await requestJson("POST", "/local/sync/NOT_A_SYNC_TYPE", {
    storeId: "store-a",
    requestId: "web-sync-routing-control",
  });
  assert.notEqual(response.status, 410);
  assert.notEqual(response.body.code, "EXTENSION_SYNC_REMOVED");
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
});
