import assert from "node:assert/strict";
import test from "node:test";
import { removeAccountScope } from "../account-deletion.mjs";
import {
  migrateLegacyDataCollectionStoreStateForAudit,
} from "../legacy-data-collection-store.mjs";

function scopedFixture() {
  return {
    token: "target-token",
    currentAccountId: "account-target",
    sessionIssuedAt: "2026-07-27T00:00:00.000Z",
    sessions: {
      "target-token": { accountId: "account-target" },
      "other-token": { accountId: "account-other" },
    },
    accounts: [
      { id: "account-target", role: "user" },
      { id: "account-other", role: "admin" },
    ],
    currentStoreId: "store-target",
    currentStoreIdsByAccount: {
      "account-target": "store-target",
      "account-other": "store-other",
    },
    stores: [
      { id: "store-target", ownerAccountId: "account-target" },
      { id: "store-other", ownerAccountId: "account-other" },
    ],
    caches: {
      products: [
        { id: "product-target", accountId: "account-target", storeId: "store-target" },
        { id: "product-other", accountId: "account-other", storeId: "store-other" },
      ],
      postings: [{ id: "order-target", localStoreId: "store-target" }],
      announcements: [{ id: "global-announcement" }],
      files: [{ id: "file-target", ownerAccountId: "account-target", objectKey: "target/file.png" }],
    },
    hashes: {
      "target-hash": { accountId: "account-target" },
      "other-hash": { accountId: "account-other" },
    },
    leases: {
      "lease-target": { accountId: "account-target", storeId: "store-target" },
      "lease-other": { accountId: "account-other", storeId: "store-other" },
    },
    browserAgents: {
      "agent-target": { accountId: "account-target", lockedStoreId: "store-target" },
      "agent-other": { accountId: "account-other", lockedStoreId: "store-other" },
    },
    jobs: {
      "job-target": { accountId: "account-target", storeId: "store-target" },
      "job-other": { accountId: "account-other", storeId: "store-other" },
    },
    reports: [
      { id: "report-target", accountId: "account-target" },
      { id: "report-other", accountId: "account-other" },
    ],
    auditEvents: [
      { id: "audit-target", accountId: "account-target", storeId: "store-target" },
      { id: "audit-other", accountId: "account-other", storeId: "store-other" },
    ],
  };
}

test("removeAccountScope removes only the deleted account business scope and keeps audits", () => {
  const state = scopedFixture();

  const result = removeAccountScope(state, "account-target", {
    actor: { type: "account", id: "admin-test" },
    reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
    occurredAt: "2026-07-30T10:00:00.000Z",
  });

  assert.deepEqual(result.storeIds, ["store-target"]);
  assert.deepEqual(result.fileObjectKeys, ["target/file.png"]);
  assert.deepEqual(state.accounts.map((item) => item.id), ["account-other"]);
  assert.deepEqual(state.stores.map((item) => item.id), ["store-other"]);
  assert.deepEqual(Object.keys(state.sessions), ["other-token"]);
  assert.deepEqual(state.caches.products.map((item) => item.id), ["product-other"]);
  assert.deepEqual(state.caches.postings, []);
  assert.deepEqual(state.caches.announcements.map((item) => item.id), ["global-announcement"]);
  assert.deepEqual(state.caches.files, []);
  assert.deepEqual(Object.keys(state.hashes), ["other-hash"]);
  assert.deepEqual(Object.keys(state.leases), ["lease-other"]);
  assert.deepEqual(Object.keys(state.browserAgents), ["agent-other"]);
  assert.deepEqual(Object.keys(state.jobs), ["job-other"]);
  assert.deepEqual(state.reports.map((item) => item.id), ["report-other"]);
  assert.equal(state.auditEvents.length, 2);
  assert.equal(state.currentAccountId, "");
  assert.equal(state.currentStoreId, "");
  assert.equal(state.currentStoreIdsByAccount["account-target"], undefined);
  assert.deepEqual(state.__deletedAccountScopes, [{
    accountId: "account-target",
    storeIds: ["store-target"],
    legacyDataStorePurgePolicy: {
      actor: { type: "account", id: "admin-test" },
      reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
      occurredAt: "2026-07-30T10:00:00.000Z",
    },
  }]);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(state, "__deletedAccountScopes"),
    false,
  );
});

test("removeAccountScope rejects a missing account without mutating state", () => {
  const state = scopedFixture();
  const original = structuredClone(state);

  assert.throws(
    () => removeAccountScope(state, "missing"),
    (error) => error?.code === "ACCOUNT_NOT_FOUND",
  );
  assert.deepEqual(state, original);
});

test("account privacy deletion removes canonical and legacy archive ownership without changing B", () => {
  const state = scopedFixture();
  const keepB = [{
    archiveKey: "account-other:data-store-b",
    accountId: "account-other",
    dataCollectionStoreId: "data-store-b",
    sourceTimestamp: "2026-07-20T08:00:00.000Z",
    archivedAt: "2026-07-21T08:00:00.000Z",
    wasCurrent: true,
    sourceFields: ["dataCollectionStores"],
    legacySnapshot: {
      id: "data-store-b",
      ownerAccountId: "account-other",
      sellerCompanyId: "seller-b-preserved",
      note: "preserve exactly",
    },
  }, {
    archiveKey: "legacy-b-shape",
    dataCollectionStoreId: "data-store-b-legacy",
    sourceTimestamp: "2026-07-22T08:00:00.000Z",
    archivedAt: "2026-07-23T08:00:00.000Z",
    wasCurrent: false,
    sourceFields: ["dataCollectionStore"],
    legacySnapshot: {
      id: "data-store-b-legacy",
      owner_account_id: "account-other",
      sellerCompanyId: "seller-b-legacy-preserved",
    },
  }];
  state.legacyDataCollectionStoreAuditArchive = {
    schemaVersion: 1,
    readOnly: true,
    records: [{
      accountId: "account-target",
      dataCollectionStoreId: "target-canonical",
      legacySnapshot: { sellerCompanyId: "seller-target-1" },
    }, {
      account_id: "account-target",
      dataCollectionStoreId: "target-snake",
      legacySnapshot: { sellerCompanyId: "seller-target-2" },
    }, {
      ownerAccountId: "account-target",
      dataCollectionStoreId: "target-owner",
      legacySnapshot: { sellerCompanyId: "seller-target-3" },
    }, {
      archiveKey: "legacy-nested-target",
      dataCollectionStoreId: "target-nested",
      legacySnapshot: {
        owner_account_id: "account-target",
        sellerCompanyId: "seller-target-4",
      },
    }, {
      archiveKey: "account-target:target-key-only",
      dataCollectionStoreId: "target-key-only",
      legacySnapshot: { sellerCompanyId: "seller-target-5" },
    }, {
      accountId: "account-other",
      dataCollectionStoreId: "target-conflicted",
      legacySnapshot: {
        created_by: "account-target",
        sellerCompanyId: "seller-target-6",
      },
    }, ...structuredClone(keepB)],
    accountRecordCounts: {
      "account-target": 6,
      "account-other": 2,
      stale: 99,
    },
  };

  const result = removeAccountScope(state, "account-target", {
    actor: { type: "account", id: "admin-test" },
    reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
    occurredAt: "2026-07-30T11:00:00.000Z",
  });

  assert.equal(result.legacyArchivePurgedCount, 6);
  assert.deepEqual(
    state.legacyDataCollectionStoreAuditArchive.records,
    keepB,
    "other-account records and timestamps must remain byte-for-byte equivalent",
  );
  assert.deepEqual(
    state.legacyDataCollectionStoreAuditArchive.accountRecordCounts,
    { "account-other": 2 },
  );
  const serializedArchive = JSON.stringify(state.legacyDataCollectionStoreAuditArchive);
  assert.doesNotMatch(serializedArchive, /account-target|seller-target/);
});

test("account privacy deletion consumes retired runtime fields before they can recreate A", () => {
  const state = scopedFixture();
  const keepB = [{
    archiveKey: "legacy-b-nested",
    dataCollectionStoreId: "data-store-b",
    sourceTimestamp: "2026-07-24T08:00:00.000Z",
    archivedAt: "2026-07-25T08:00:00.000Z",
    wasCurrent: true,
    sourceFields: ["dataCollectionStores"],
    legacySnapshot: {
      id: "data-store-b",
      owner_account_id: "account-other",
      sellerCompanyId: "seller-b-stable",
    },
  }, {
    archiveKey: "legacy-b-snake",
    account_id: "account-other",
    dataCollectionStoreId: "data-store-b-second",
    sourceTimestamp: "2026-07-24T09:00:00.000Z",
    archivedAt: "2026-07-25T09:00:00.000Z",
    wasCurrent: false,
    sourceFields: ["dataCollectionStore"],
    legacySnapshot: {
      id: "data-store-b-second",
      sellerCompanyId: "seller-b-second-stable",
    },
  }];
  state.legacyDataCollectionStoreAuditArchive = {
    schemaVersion: 1,
    readOnly: true,
    records: structuredClone(keepB),
    accountRecordCounts: { "account-other": 2 },
  };
  state.currentDataCollectionStoreId = "data-store-a";
  state.currentDataCollectionStoreIdsByAccount = {
    "account-target": "data-store-a",
  };
  state.dataCollectionStore = {
    id: "data-store-a",
    ownerAccountId: "account-target",
    sellerCompanyId: "seller-a-retired-singular",
  };
  state.dataCollectionStores = [{
    id: "data-store-a",
    ownerAccountId: "account-target",
    sellerCompanyId: "seller-a-retired-plural",
  }];
  state.sessions["target-token"].currentDataCollectionStoreId = "data-store-a";

  const result = removeAccountScope(state, "account-target", {
    actor: { type: "account", id: "admin-test" },
    reason: "ACCOUNT_DELETION_PRIVACY_ERASURE",
    occurredAt: "2026-07-30T11:05:00.000Z",
  });
  migrateLegacyDataCollectionStoreStateForAudit(state, {
    archivedAt: "2026-07-30T11:06:00.000Z",
  });

  assert.equal(result.legacyArchivePurgedCount, 1);
  assert.deepEqual(state.legacyDataCollectionStoreAuditArchive.records, keepB);
  assert.deepEqual(
    state.legacyDataCollectionStoreAuditArchive.accountRecordCounts,
    { "account-other": 2 },
  );
  for (const retiredField of [
    "currentDataCollectionStoreId",
    "currentDataCollectionStoreIdsByAccount",
    "dataCollectionStore",
    "dataCollectionStores",
  ]) {
    assert.equal(Object.hasOwn(state, retiredField), false, retiredField);
  }
  assert.doesNotMatch(
    JSON.stringify(state.legacyDataCollectionStoreAuditArchive),
    /account-target|seller-a-retired/,
  );
});
