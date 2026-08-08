import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingImportCleanupWorker } from "../auto-listing-import-cleanup-worker.mjs";

const row = Object.freeze({
  id: "cleanup-a", accountId: "account-a", importId: "import-a",
  objectKey: "auto-listing/imports/v1/account-a/import-a/workbook.xlsx",
  status: "PROCESSING", leaseOwner: "import-cleanup-v1", leaseToken: "lease-a",
});

test("cleanup worker removes only its leased scoped workbook then completes the obligation", async () => {
  const calls = [];
  const worker = createAutoListingImportCleanupWorker({
    repository: {
      async listRunnableCleanupAccountIds(input) { calls.push(["accounts", input]); return ["account-a"]; },
      async claimObjectCleanup(input) { calls.push(["claim", input]); return [row]; },
      async prepareObjectCleanup(input) { calls.push(["prepare", input]); return { deleteRequired: true, cleanup: row }; },
      async completeObjectCleanup(input) { calls.push(["complete", input]); return { status: "COMPLETED" }; },
      async failObjectCleanup() { assert.fail("successful removal must not fail"); },
    },
    workbookStore: {
      async removeWorkbook(input) { calls.push(["remove", input]); },
    },
  });
  assert.deepEqual(await worker.runOnce(), { accounts: 1, claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(calls, [
    ["accounts", { afterAccountId: null, limit: 100 }],
    ["claim", { accountId: "account-a", workerId: "import-cleanup-v1", limit: 20, leaseMs: 60_000 }],
    ["prepare", { accountId: "account-a", id: "cleanup-a", workerId: "import-cleanup-v1", leaseToken: "lease-a" }],
    ["remove", { accountId: "account-a", importId: "import-a", objectKey: row.objectKey }],
    ["complete", { accountId: "account-a", id: "cleanup-a", workerId: "import-cleanup-v1", leaseToken: "lease-a" }],
  ]);
});

test("cleanup worker records a retry and isolates one failed object from its siblings", async () => {
  const calls = [];
  const second = { ...row, id: "cleanup-b", importId: "import-b",
    objectKey: "auto-listing/imports/v1/account-a/import-b/workbook.xlsx", leaseToken: "lease-b" };
  const worker = createAutoListingImportCleanupWorker({
    repository: {
      async listRunnableCleanupAccountIds() { return ["account-a"]; },
      async claimObjectCleanup() { return [row, second]; },
      async prepareObjectCleanup(input) {
        return { deleteRequired: true, cleanup: input.id === "cleanup-a" ? row : second };
      },
      async completeObjectCleanup(input) { calls.push(["complete", input.id]); return { status: "COMPLETED" }; },
      async failObjectCleanup(input) { calls.push(["fail", input]); return { status: "PENDING" }; },
    },
    workbookStore: {
      async removeWorkbook(input) {
        if (input.importId === "import-a") throw new Error("credential=prod-secret");
      },
    },
    logger: { info() { throw new Error("logger must not alter cleanup"); } },
  });
  assert.deepEqual(await worker.runOnce(), { accounts: 1, claimed: 2, completed: 1, failed: 1 });
  assert.equal(calls[0][0], "fail");
  assert.equal(calls[0][1].errorCode, "OBJECT_STORAGE_REMOVE_FAILED");
  assert.equal(JSON.stringify(calls).includes("prod-secret"), false);
  assert.deepEqual(calls[1], ["complete", "cleanup-b"]);
});

test("cleanup worker rejects malformed repository rows before object storage", async () => {
  let removals = 0;
  const worker = createAutoListingImportCleanupWorker({
    repository: {
      async listRunnableCleanupAccountIds() { return ["account-a"]; },
      async claimObjectCleanup() { return [{ ...row, accountId: "account-b" }]; },
      async prepareObjectCleanup() { assert.fail("malformed row must not be prepared"); },
      async completeObjectCleanup() {},
      async failObjectCleanup() {},
    },
    workbookStore: { async removeWorkbook() { removals += 1; } },
  });
  await assert.rejects(worker.runOnce(), { code: "AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID" });
  assert.equal(removals, 0);
});

test("cleanup worker completes a referenced object without calling object storage", async () => {
  let removals = 0;
  let completions = 0;
  const worker = createAutoListingImportCleanupWorker({
    repository: {
      async listRunnableCleanupAccountIds() { return ["account-a"]; },
      async claimObjectCleanup() { return [row]; },
      async prepareObjectCleanup() {
        return { deleteRequired: false, cleanup: { ...row, status: "COMPLETED" } };
      },
      async completeObjectCleanup() { completions += 1; },
      async failObjectCleanup() { assert.fail("reference-safe completion cannot fail"); },
    },
    workbookStore: { async removeWorkbook() { removals += 1; } },
  });
  assert.deepEqual(await worker.runOnce(), { accounts: 1, claimed: 1, completed: 1, failed: 0 });
  assert.equal(removals, 0);
  assert.equal(completions, 0);
});

test("cleanup worker keyset-pages beyond the first 100 accounts without starving later tenants", async () => {
  const accounts = Array.from({ length: 101 }, (_, index) => `account-${String(index + 1).padStart(3, "0")}`);
  const discovery = [];
  const claimedAccounts = [];
  const worker = createAutoListingImportCleanupWorker({
    repository: {
      async listRunnableCleanupAccountIds(input) {
        discovery.push(input);
        return accounts.filter((accountId) => input.afterAccountId === null || accountId > input.afterAccountId)
          .slice(0, input.limit);
      },
      async claimObjectCleanup({ accountId }) { claimedAccounts.push(accountId); return []; },
      async prepareObjectCleanup() { assert.fail("empty claims are not prepared"); },
      async completeObjectCleanup() {}, async failObjectCleanup() {},
    },
    workbookStore: { async removeWorkbook() {} },
  });
  assert.deepEqual(await worker.runOnce(), { accounts: 101, claimed: 0, completed: 0, failed: 0 });
  assert.deepEqual(discovery, [
    { afterAccountId: null, limit: 100 },
    { afterAccountId: "account-100", limit: 100 },
  ]);
  assert.equal(claimedAccounts.at(-1), "account-101");
});

test("cleanup worker rejects unordered pages and account ids that do not advance beyond the cursor", async () => {
  for (const pages of [
    [["account-b", "account-a"]],
    [["account-a", "account-b"], ["account-b", "account-c"]],
    [["account-a", "account-b"], ["account-a", "account-c"]],
  ]) {
    let call = 0;
    const worker = createAutoListingImportCleanupWorker({
      accountLimit: 2,
      repository: {
        async listRunnableCleanupAccountIds() { return pages[call++] || []; },
        async claimObjectCleanup() { return []; },
        async prepareObjectCleanup() {}, async completeObjectCleanup() {}, async failObjectCleanup() {},
      },
      workbookStore: { async removeWorkbook() {} },
    });
    await assert.rejects(worker.runOnce(), { code: "AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID" });
  }
});

test("cleanup worker bounds discovery pages when a repository never returns a short page", async () => {
  let calls = 0;
  const worker = createAutoListingImportCleanupWorker({
    accountLimit: 2,
    maxAccountPages: 3,
    repository: {
      async listRunnableCleanupAccountIds({ afterAccountId }) {
        calls += 1;
        const suffix = afterAccountId === null ? 0 : Number(afterAccountId.split("-").at(-1));
        return [`account-${String(suffix + 1).padStart(3, "0")}`,
          `account-${String(suffix + 2).padStart(3, "0")}`];
      },
      async claimObjectCleanup() { return []; },
      async prepareObjectCleanup() {}, async completeObjectCleanup() {}, async failObjectCleanup() {},
    },
    workbookStore: { async removeWorkbook() {} },
  });
  await assert.rejects(worker.runOnce(), { code: "AUTO_LISTING_IMPORT_CLEANUP_WORKER_INVALID" });
  assert.equal(calls, 3);
});
