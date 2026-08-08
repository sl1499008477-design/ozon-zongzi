import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresAutoListingImportCleanupRepository } from "../auto-listing-import-cleanup-postgres.mjs";

const cleanupObjectKey = "auto-listing/imports/v1/account-a/import-a/workbook.xlsx";
const obligation = {
  id: `import_cleanup_${crypto.createHash("sha256").update(`account-a\0${cleanupObjectKey}`, "utf8").digest("hex").slice(0, 40)}`,
  account_id: "account-a",
  import_id: "import-a",
  object_key: cleanupObjectKey,
  reason_code: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
  status: "PENDING",
  status_version: 0,
  attempt_count: 0,
  available_at: "2026-08-07T00:00:00.000Z",
  lease_owner: null,
  lease_token: null,
  lease_expires_at: null,
  last_error_code: null,
  created_at: "2026-08-07T00:00:00.000Z",
  updated_at: "2026-08-07T00:00:00.000Z",
  completed_at: null,
};

test("cleanup enqueue is deterministic, account scoped, and exact-compares a replay", async () => {
  const calls = [];
  let inserted = true;
  const repository = createPostgresAutoListingImportCleanupRepository({
    pool: {
      async query(sql, params) {
        calls.push([sql, params]);
        if (sql.includes("INSERT INTO auto_listing_import_object_cleanup")) {
          return { rows: inserted ? [obligation] : [] };
        }
        if (sql.includes("SELECT * FROM auto_listing_import_object_cleanup")) return { rows: [obligation] };
        throw new Error("unexpected query");
      },
    },
  });
  const input = {
    accountId: "account-a",
    importId: "import-a",
    objectKey: obligation.object_key,
    reasonCode: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
  };
  assert.equal((await repository.enqueueObjectCleanup(input)).accountId, "account-a");
  inserted = false;
  assert.equal((await repository.enqueueObjectCleanup(input)).objectKey, obligation.object_key);
  assert.ok(calls.every(([, params]) => params.includes("account-a")));
  assert.ok(calls[0][1][0].startsWith("import_cleanup_"));
});

test("cleanup claims, completes, and retries with token CAS and bounded leases", async () => {
  const calls = [];
  const processing = { ...obligation, status: "PROCESSING", status_version: 1, attempt_count: 1,
    lease_owner: "worker-a", lease_token: "nonce-a:1", lease_expires_at: "2026-08-07T00:01:00.000Z" };
  const completed = { ...processing, status: "COMPLETED", status_version: 2,
    lease_owner: null, lease_token: null, lease_expires_at: null, completed_at: "2026-08-07T00:00:30.000Z" };
  const pending = { ...processing, status: "PENDING", status_version: 2,
    lease_owner: null, lease_token: null, lease_expires_at: null, last_error_code: "OBJECT_STORAGE_REMOVE_FAILED" };
  let result = processing;
  const repository = createPostgresAutoListingImportCleanupRepository({
    token: () => "nonce-a",
    pool: { async query(sql, params) { calls.push([sql, params]); return { rows: [result] }; } },
  });

  assert.equal((await repository.claimObjectCleanup({ accountId: "account-a", workerId: "worker-a", limit: 5, leaseMs: 60_000 }))[0].leaseToken, "nonce-a:1");
  assert.match(calls[0][0], /FOR UPDATE SKIP LOCKED/u);
  assert.match(calls[0][0], /account_id=\$1/u);
  result = completed;
  assert.equal((await repository.completeObjectCleanup({ accountId: "account-a", id: obligation.id,
    workerId: "worker-a", leaseToken: "nonce-a:1" })).status, "COMPLETED");
  assert.match(calls[1][0], /lease_cas_token=\$4/u);
  result = pending;
  assert.equal((await repository.failObjectCleanup({ accountId: "account-a", id: obligation.id,
    workerId: "worker-a", leaseToken: "nonce-a:1", errorCode: "OBJECT_STORAGE_REMOVE_FAILED" })).status, "PENDING");
  assert.match(calls[2][0], /available_at=NOW\(\)\+/u);
});

test("cleanup discovery is a real repository method and referenced objects complete atomically without deletion", async () => {
  const calls = [];
  const processing = { ...obligation, status: "PROCESSING", status_version: 1, attempt_count: 1,
    lease_owner: "worker-a", lease_token: "nonce-a:1", lease_expires_at: "2026-08-07T00:01:00.000Z" };
  const completed = { ...processing, status: "COMPLETED", status_version: 2,
    lease_owner: null, lease_token: null, lease_expires_at: null, completed_at: "2026-08-07T00:00:30.000Z",
    delete_required: false };
  const repository = createPostgresAutoListingImportCleanupRepository({ pool: { async query(sql, params) {
    calls.push([sql, params]);
    if (sql.includes("SELECT DISTINCT account_id")) return { rows: [{ account_id: "account-a" }] };
    return { rows: [completed] };
  } } });
  assert.deepEqual(await repository.listRunnableCleanupAccountIds({ afterAccountId: null, limit: 10 }), ["account-a"]);
  const decision = await repository.prepareObjectCleanup({ accountId: "account-a", id: obligation.id,
    workerId: "worker-a", leaseToken: "nonce-a:1" });
  assert.equal(decision.deleteRequired, false);
  assert.equal(decision.cleanup.status, "COMPLETED");
  assert.match(calls[1][0], /EXISTS[\s\S]*auto_listing_import_files/iu);
  assert.match(calls[1][0], /SELECT id FROM accounts WHERE id=\$1 FOR UPDATE/iu);
  assert.match(calls[1][0], /FOR UPDATE/iu);
});

test("cleanup repository rejects cross-scope object keys and redacts database failures", async () => {
  const repository = createPostgresAutoListingImportCleanupRepository({
    pool: { async query() { throw new Error("password=prod-secret host=internal"); } },
  });
  await assert.rejects(repository.enqueueObjectCleanup({
    accountId: "account-a", importId: "import-a",
    objectKey: "auto-listing/imports/v1/account-b/import-a/workbook.xlsx",
    reasonCode: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
  }), { code: "AUTO_LISTING_IMPORT_CLEANUP_INVALID" });
  await assert.rejects(repository.enqueueObjectCleanup({
    accountId: "account-a", importId: "import-a", objectKey: obligation.object_key,
    reasonCode: "AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK",
  }), (error) => error?.code === "AUTO_LISTING_IMPORT_CLEANUP_REPOSITORY_FAILED"
    && !/password|prod-secret|internal/iu.test(error.message));
});
