import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresAutoListingImportRepository } from "../auto-listing-import-postgres.mjs";

const configSnapshot = Object.freeze({ stock: 5, targetStoreId: "store-a" });
const configHash = crypto.createHash("sha256").update(JSON.stringify(configSnapshot), "utf8").digest("hex");

function persistence(count = 1) {
  return {
    importFile: {
      id: "import-a", accountId: "account-a", sourceFileName: "skus.xlsx",
      sourceContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sourceSizeBytes: 20, fileHash: "a".repeat(64),
      objectKey: "auto-listing/imports/v1/account-a/import-a/workbook.xlsx",
      worksheetName: "SKU", totalRows: count, acceptedRows: count, rejectedRows: 0, duplicateRows: 0,
      readyRows: 0, failedRows: 0, status: "QUEUED", statusVersion: 1,
      configSnapshot, configHash, idempotencyKey: "idem-a", createdBy: "account-a",
      correlationId: "corr-a", generatedJobId: null, lastErrorCode: null, lastErrorSafe: null,
      createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z", completedAt: null,
    },
    rows: Array.from({ length: count }, (_, index) => ({
      id: `row-${index + 1}`, accountId: "account-a", importFileId: "import-a", rowNumber: index + 2,
      rawSku: String(1001 + index), normalizedSku: String(1001 + index), status: "PENDING", statusVersion: 0,
      attemptCount: 0, collectItemId: null, autoListingItemId: null, lastErrorCode: null,
      lastErrorSafe: null, createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
      completedAt: null,
    })),
    outbox: Array.from({ length: count }, (_, index) => ({
      id: `source-${index + 1}`, accountId: "account-a", importFileId: "import-a", rowId: `row-${index + 1}`,
      eventType: "COLLECT_EXCEL_SKU", dedupeKey: `dedupe-${index + 1}`, state: "PENDING", stateVersion: 0,
      attempts: 0, availableAt: "2026-08-07T00:00:00.000Z", leaseOwner: null, leaseToken: null,
      leaseExpiresAt: null, leaseGeneration: 0, lastErrorCode: null, lastErrorSafe: null,
      createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z", completedAt: null,
    })),
  };
}

function databaseRow(overrides = {}) {
  return {
    id: "import-a", account_id: "account-a", source_file_name: "skus.xlsx",
    source_content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source_size_bytes: "20", file_hash: "a".repeat(64), object_key: "auto-listing/imports/v1/account-a/import-a/workbook.xlsx",
    worksheet_name: "SKU", total_rows: 1, accepted_rows: 1, rejected_rows: 0, duplicate_rows: 0,
    ready_rows: 0, failed_rows: 0, status: "QUEUED", status_version: "1",
    config_snapshot: configSnapshot, config_hash: configHash, idempotency_key: "idem-a",
    created_by: "account-a", correlation_id: "corr-a", generated_job_id: null,
    last_error_code: null, last_error_safe: null, created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z", completed_at: null,
    ...overrides,
  };
}

test("import graph persists RECEIVED to QUEUED atomically under an account lock", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("WHERE account_id=$1 AND idempotency_key=$2")) return { rows: [] };
      if (sql.includes("UPDATE auto_listing_import_files")) return { rows: [databaseRow()] };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push(["RELEASE", []]); },
  };
  const cleanup = { async enqueueObjectCleanup() {} };
  const repository = createPostgresAutoListingImportRepository({
    pool: { async query() { throw new Error("direct query not expected"); }, async connect() { return client; } },
    cleanupRepository: cleanup,
  });

  const result = await repository.createImportWithRows(persistence());
  assert.equal(result.status, "QUEUED");
  assert.equal(result.accountId, "account-a");
  assert.match(calls.find(([sql]) => sql.includes("INSERT INTO auto_listing_import_files"))[0], /'RECEIVED',0/u);
  assert.match(calls.find(([sql]) => sql.includes("INSERT INTO auto_listing_import_rows"))[0], /jsonb_to_recordset/u);
  assert.match(calls.find(([sql]) => sql.includes("INSERT INTO auto_listing_source_outbox"))[0], /jsonb_to_recordset/u);
  assert.deepEqual(calls.map(([sql]) => sql).filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK", "RELEASE"].includes(sql)), [
    "BEGIN", "COMMIT", "RELEASE",
  ]);
});

test("configured repositories persist 1001 and 2500-row imports in bounded batches", async () => {
  for (const count of [1_001, 2_500]) {
    const calls = [];
    const client = { async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("idempotency_key=$2")) return { rows: [] };
      if (sql.includes("UPDATE auto_listing_import_files")) {
        return { rows: [databaseRow({ total_rows: count, accepted_rows: count })] };
      }
      return { rows: [], rowCount: 1 };
    }, release() {} };
    const repository = createPostgresAutoListingImportRepository({
      pool: { async query() {}, async connect() { return client; } },
      cleanupRepository: { async enqueueObjectCleanup() {} },
      maxRows: 2_500,
    });
    assert.equal((await repository.createImportWithRows(persistence(count))).totalRows, count);
    assert.equal(calls.filter((sql) => sql.includes("INSERT INTO auto_listing_import_rows")).length,
      Math.ceil(count / 1_000));
    assert.equal(calls.filter((sql) => sql.includes("INSERT INTO auto_listing_source_outbox")).length,
      Math.ceil(count / 1_000));
  }
});

test("repository accepts the configured 100000-row boundary and rejects one row above it before connecting", async () => {
  let connects = 0;
  const repository = createPostgresAutoListingImportRepository({
    pool: { async query() {}, async connect() { connects += 1; return {}; } },
    cleanupRepository: { async enqueueObjectCleanup() {} }, maxRows: 100_000,
  });
  const overLimit = persistence();
  overLimit.rows = Array(100_001).fill(overLimit.rows[0]);
  overLimit.outbox = Array(100_001).fill(overLimit.outbox[0]);
  await assert.rejects(repository.createImportWithRows(overLimit), {
    code: "AUTO_LISTING_IMPORT_REPOSITORY_INVALID",
  });
  assert.equal(connects, 0);
  assert.doesNotThrow(() => createPostgresAutoListingImportRepository({
    pool: { async query() {}, async connect() {} },
    cleanupRepository: { async enqueueObjectCleanup() {} }, maxRows: 100_000,
  }));
});

test("import repository rejects mixed-account graphs before connecting", async () => {
  let connects = 0;
  const repository = createPostgresAutoListingImportRepository({
    pool: { async query() {}, async connect() { connects += 1; } },
    cleanupRepository: { async enqueueObjectCleanup() {} },
  });
  const input = persistence();
  input.rows[0].accountId = "account-b";
  await assert.rejects(repository.createImportWithRows(input), { code: "AUTO_LISTING_IMPORT_REPOSITORY_INVALID" });
  assert.equal(connects, 0);
});

test("idempotent replay exact-compares file and config hashes without writing rows", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("WHERE account_id=$1 AND idempotency_key=$2")) return { rows: [databaseRow()] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = createPostgresAutoListingImportRepository({
    pool: { async query() {}, async connect() { return client; } },
    cleanupRepository: { async enqueueObjectCleanup() {} },
  });
  const result = await repository.createImportWithRows(persistence());
  assert.equal(result.duplicate, true);
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO auto_listing_import_rows")), false);

  const changed = persistence();
  changed.importFile.fileHash = "c".repeat(64);
  await assert.rejects(repository.createImportWithRows(changed), { code: "AUTO_LISTING_IMPORT_IDEMPOTENCY_CONFLICT" });
});

test("new import persistence cannot race an in-progress object deletion reservation", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("idempotency_key=$2")) return { rows: [] };
      if (sql.includes("auto_listing_import_object_cleanup")) return { rows: [{ id: "cleanup-a" }] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = createPostgresAutoListingImportRepository({
    pool: { async query() {}, async connect() { return client; } },
    cleanupRepository: { async enqueueObjectCleanup() {} },
  });
  await assert.rejects(repository.createImportWithRows(persistence()), {
    code: "AUTO_LISTING_IMPORT_OBJECT_CLEANUP_IN_PROGRESS",
  });
  assert.equal(calls.some((sql) => sql.includes("INSERT INTO auto_listing_import_files")), false);
  assert.ok(calls.includes("ROLLBACK"));
});

test("database errors roll back, release, and expose only a stable code", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      throw new Error("password=prod-secret relation=internal_table");
    },
    release() { calls.push("RELEASE"); },
  };
  const repository = createPostgresAutoListingImportRepository({
    pool: { async query() {}, async connect() { return client; } },
    cleanupRepository: { async enqueueObjectCleanup() {} },
  });
  await assert.rejects(repository.createImportWithRows(persistence()), (error) => (
    error?.code === "AUTO_LISTING_IMPORT_PERSIST_FAILED"
      && !/password|prod-secret|internal_table/iu.test(error.message)
  ));
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(calls.includes("RELEASE"));
});
