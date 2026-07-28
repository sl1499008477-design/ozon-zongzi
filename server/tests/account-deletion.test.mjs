import assert from "node:assert/strict";
import test from "node:test";
import { removeAccountScope } from "../account-deletion.mjs";

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
    currentDataCollectionStoreId: "collector-target",
    currentDataCollectionStoreIdsByAccount: {
      "account-target": "collector-target",
      "account-other": "collector-other",
    },
    dataCollectionStores: [
      { id: "collector-target", ownerAccountId: "account-target" },
      { id: "collector-other", ownerAccountId: "account-other" },
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

  const result = removeAccountScope(state, "account-target");

  assert.deepEqual(result.storeIds, ["store-target"]);
  assert.deepEqual(result.fileObjectKeys, ["target/file.png"]);
  assert.deepEqual(state.accounts.map((item) => item.id), ["account-other"]);
  assert.deepEqual(state.stores.map((item) => item.id), ["store-other"]);
  assert.deepEqual(state.dataCollectionStores.map((item) => item.id), ["collector-other"]);
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
  assert.equal(state.currentDataCollectionStoreId, "");
  assert.equal(state.currentStoreIdsByAccount["account-target"], undefined);
  assert.equal(state.currentDataCollectionStoreIdsByAccount["account-target"], undefined);
  assert.deepEqual(state.__deletedAccountScopes, [{
    accountId: "account-target",
    storeIds: ["store-target"],
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
