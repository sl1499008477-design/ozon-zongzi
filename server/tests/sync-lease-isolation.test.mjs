import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-sync-lease-isolation-"));

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, pathname, body, token) {
  const payload = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(payload)]);
  req.method = "POST";
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
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

const fixture = {
  token: "",
  currentAccountId: "",
  sessionIssuedAt: "",
  sessions: {
    token_a: { token: "token_a", accountId: "acct_a", issuedAt: "2026-07-27T00:00:00.000Z" },
    token_b: { token: "token_b", accountId: "acct_b", issuedAt: "2026-07-27T00:00:00.000Z" },
  },
  accounts: [
    { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" },
    { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" },
  ],
  currentStoreId: "",
  currentStoreIdsByAccount: { acct_a: "store_a", acct_b: "store_b" },
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", label: "A store" },
    { id: "store_b", ownerAccountId: "acct_b", clientId: "client_b", label: "B store" },
  ],
  currentDataCollectionStoreId: "",
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
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
    watermarkTemplates: [],
    files: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
};

try {
  await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(fixture), "utf8");
  const { handle } = await import("../index.mjs");

  const foreignStore = await requestJson(
    handle,
    "/ozon/sync/lease/acquire",
    { storeId: "store_b", type: "PRODUCTS", deviceId: "device_a" },
    "token_a",
  );
  assert.equal(foreignStore.status, 403, "an account must not lock another account's store");

  const acquired = await requestJson(
    handle,
    "/ozon/sync/lease/acquire",
    { storeId: "store_a", type: "PRODUCTS", deviceId: "device_a", ttlSeconds: 300 },
    "token_a",
  );
  assert.equal(acquired.status, 200);
  assert.equal(acquired.body.acquired, true);
  assert.ok(acquired.body.leaseId);

  const reacquired = await requestJson(
    handle,
    "/ozon/sync/lease/acquire",
    { storeId: "store_a", type: "PRODUCTS", deviceId: "device_a", ttlSeconds: 300 },
    "token_a",
  );
  assert.equal(reacquired.status, 200);
  assert.equal(reacquired.body.leaseId, acquired.body.leaseId, "same holder retry must be idempotent");

  const crossHeartbeat = await requestJson(
    handle,
    "/ozon/sync/lease/heartbeat",
    { leaseId: acquired.body.leaseId, deviceId: "device_b", ttlSeconds: 300 },
    "token_b",
  );
  assert.equal(crossHeartbeat.status, 404, "another account must not discover or renew the lease");

  const wrongDeviceHeartbeat = await requestJson(
    handle,
    "/ozon/sync/lease/heartbeat",
    { leaseId: acquired.body.leaseId, deviceId: "device_a2", ttlSeconds: 300 },
    "token_a",
  );
  assert.equal(wrongDeviceHeartbeat.status, 409, "another device must not renew the lease");

  const missingLeaseImport = await requestJson(
    handle,
    "/ozon/cache/import-with-hash",
    { storeId: "store_a", type: "PRODUCTS", deviceId: "device_a", items: [] },
    "token_a",
  );
  assert.equal(missingLeaseImport.status, 409, "sync imports must require the active lease");

  const validImport = await requestJson(
    handle,
    "/ozon/cache/import-with-hash",
    {
      storeId: "store_a",
      type: "PRODUCTS",
      leaseId: acquired.body.leaseId,
      deviceId: "device_a",
      items: [],
    },
    "token_a",
  );
  assert.equal(validImport.status, 200);

  const crossRelease = await requestJson(
    handle,
    "/ozon/sync/lease/release",
    { leaseId: acquired.body.leaseId, deviceId: "device_b" },
    "token_b",
  );
  assert.equal(crossRelease.status, 404, "another account must not release the lease");

  const ownerHeartbeat = await requestJson(
    handle,
    "/ozon/sync/lease/heartbeat",
    { leaseId: acquired.body.leaseId, deviceId: "device_a", ttlSeconds: 300 },
    "token_a",
  );
  assert.equal(ownerHeartbeat.status, 200);
  assert.equal(ownerHeartbeat.body.refreshed, true);

  const released = await requestJson(
    handle,
    "/ozon/sync/lease/release",
    { leaseId: acquired.body.leaseId, deviceId: "device_a" },
    "token_a",
  );
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);

  console.log("sync lease account/device isolation test passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
