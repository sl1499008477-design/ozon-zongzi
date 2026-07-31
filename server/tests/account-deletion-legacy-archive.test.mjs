import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-account-delete-archive-"));
const dataFile = path.join(dataDir, "local-state.json");
const adminToken = "account-delete-archive-admin-token";
const keepB = {
  archiveKey: "account-b:data-store-b",
  accountId: "account-b",
  dataCollectionStoreId: "data-store-b",
  sourceTimestamp: "2026-07-18T08:00:00.000Z",
  archivedAt: "2026-07-19T08:00:00.000Z",
  wasCurrent: true,
  sourceFields: ["dataCollectionStores"],
  legacySnapshot: {
    id: "data-store-b",
    ownerAccountId: "account-b",
    sellerCompanyId: "seller-b-on-disk",
    label: "B must stay unchanged",
  },
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

await writeFile(dataFile, JSON.stringify({
  token: adminToken,
  currentAccountId: "account-admin",
  sessionIssuedAt: "2026-07-30T08:00:00.000Z",
  sessions: {
    [adminToken]: {
      token: adminToken,
      accountId: "account-admin",
      issuedAt: "2026-07-30T08:00:00.000Z",
    },
    "account-a-session": {
      token: "account-a-session",
      accountId: "account-a",
      issuedAt: "2026-07-30T08:00:00.000Z",
      currentDataCollectionStoreId: "data-store-a",
    },
    "account-b-session": {
      token: "account-b-session",
      accountId: "account-b",
      issuedAt: "2026-07-30T08:00:00.000Z",
    },
  },
  collectorAuthTickets: [{
    id: "account-a-ticket",
    ticketHash: "a".repeat(64),
    accountId: "account-a",
    parentSessionToken: "account-a-session",
    permissions: ["collector.upload"],
    expiresAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T08:00:00.000Z",
  }, {
    id: "account-b-ticket",
    ticketHash: "b".repeat(64),
    accountId: "account-b",
    parentSessionToken: "account-b-session",
    permissions: ["collector.upload"],
    expiresAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T08:00:00.000Z",
  }],
  collectorSessions: [{
    id: "account-a-collector-session",
    tokenHash: "c".repeat(64),
    accountId: "account-a",
    parentSessionToken: "account-a-session",
    deviceFingerprint: "account-a-private-device",
    extensionVersion: "3.0.0",
    permissions: ["collector.upload"],
    expiresAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T08:00:00.000Z",
    lastSeenAt: "2026-07-30T08:00:00.000Z",
  }, {
    id: "account-b-collector-session",
    tokenHash: "d".repeat(64),
    accountId: "account-b",
    parentSessionToken: "account-b-session",
    deviceFingerprint: "account-b-device",
    extensionVersion: "3.0.0",
    permissions: ["collector.upload"],
    expiresAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T08:00:00.000Z",
    lastSeenAt: "2026-07-30T08:00:00.000Z",
  }],
  collectorOzonEnrichmentCache: [{
    accountId: "account-a",
    source: "ozon",
    sku: "shared-sku",
    contractVersion: "ozon-enrichment-v1",
  }, {
    accountId: "account-b",
    source: "ozon",
    sku: "shared-sku",
    contractVersion: "ozon-enrichment-v1",
  }],
  collectorOzonEnrichmentJobs: [{
    id: "enrichment-job-a",
    accountId: "account-a",
    requestId: "request-a",
    sku: "shared-sku",
  }, {
    id: "enrichment-job-b",
    accountId: "account-b",
    requestId: "request-b",
    sku: "shared-sku",
  }],
  accounts: [{
    id: "account-admin",
    username: "admin",
    role: "admin",
    status: "active",
  }, {
    id: "account-a",
    username: "account-a",
    role: "user",
    status: "active",
  }, {
    id: "account-b",
    username: "account-b",
    role: "user",
    status: "active",
  }],
  currentStoreId: "",
  currentStoreIdsByAccount: {},
  stores: [],
  currentDataCollectionStoreIdsByAccount: {
    "account-a": "data-store-a",
  },
  dataCollectionStore: {
    id: "data-store-a",
    ownerAccountId: "account-a",
    sellerCompanyId: "seller-a-retired-on-disk",
    label: "A must be erased",
    updatedAt: "2026-07-17T08:00:00.000Z",
  },
  legacyDataCollectionStoreAuditArchive: {
    schemaVersion: 1,
    readOnly: true,
    records: [keepB],
    accountRecordCounts: { "account-b": 1 },
  },
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
  pendingObjectDeletions: [],
  updatedAt: "2026-07-30T08:00:00.000Z",
}), "utf8");

const { handle, testExports } = await import("../index.mjs");

async function requestJson(method, pathname, authorization = "") {
  const req = Readable.from([]);
  req.method = method;
  req.url = pathname;
  req.headers = authorization ? { authorization } : {};
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
  return {
    status: res.status,
    body: JSON.parse(res.body || "{}"),
  };
}

test("real JSON account deletion persists no A archive or Collector auth artifacts and preserves B", async () => {
  const response = await requestJson(
    "DELETE",
    "/local/accounts/account-a",
    `Bearer ${adminToken}`,
  );
  assert.equal(response.status, 200);

  const saved = JSON.parse(await readFile(dataFile, "utf8"));
  assert.deepEqual(saved.legacyDataCollectionStoreAuditArchive, {
    schemaVersion: 1,
    readOnly: true,
    records: [keepB],
    accountRecordCounts: { "account-b": 1 },
  });
  assert.doesNotMatch(
    JSON.stringify(saved.legacyDataCollectionStoreAuditArchive),
    /account-a|seller-a-retired-on-disk/,
  );
  assert.deepEqual(
    saved.collectorAuthTickets.map((ticket) => ticket.id),
    ["account-b-ticket"],
  );
  assert.deepEqual(
    saved.collectorSessions.map((session) => session.id),
    ["account-b-collector-session"],
  );
  assert.deepEqual(
    saved.collectorOzonEnrichmentCache.map((record) => record.accountId),
    ["account-b"],
  );
  assert.deepEqual(
    saved.collectorOzonEnrichmentJobs.map((job) => job.id),
    ["enrichment-job-b"],
  );
  assert.doesNotMatch(
    JSON.stringify({
      tickets: saved.collectorAuthTickets,
      sessions: saved.collectorSessions,
    }),
    /account-a|account-a-session|account-a-private-device/,
  );
  for (const retiredField of [
    "currentDataCollectionStoreIdsByAccount",
    "dataCollectionStore",
    "dataCollectionStores",
  ]) {
    assert.equal(Object.hasOwn(saved, retiredField), false, retiredField);
  }
  const deletionAudit = saved.auditEvents.find((event) =>
    event.action === "ACCOUNT_DELETED" && event.entityId === "account-a");
  assert.equal(deletionAudit?.metadata?.legacyArchivePurgedCount, 1);
  assert.equal(deletionAudit?.metadata?.deletedCollectorAuthTicketCount, 1);
  assert.equal(deletionAudit?.metadata?.deletedCollectorSessionCount, 1);
  assert.equal(deletionAudit?.metadata?.deletedCollectorOzonEnrichmentCacheCount, 1);
  assert.equal(deletionAudit?.metadata?.deletedCollectorOzonEnrichmentJobCount, 1);

  const reloaded = testExports.ensureAccountState(structuredClone(saved));
  assert.deepEqual(
    reloaded.legacyDataCollectionStoreAuditArchive,
    saved.legacyDataCollectionStoreAuditArchive,
  );
  assert.doesNotMatch(
    JSON.stringify(reloaded.legacyDataCollectionStoreAuditArchive),
    /account-a|seller-a-retired-on-disk/,
  );
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
