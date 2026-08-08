import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingImportRecoveryRepository } from "../auto-listing-import-recovery-postgres.mjs";

function fileRow(overrides = {}) {
  return {
    id: "import-a", account_id: "account-a", source_file_name: "skus.xlsx",
    source_content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source_size_bytes: "20", file_hash: "a".repeat(64), object_key: "auto-listing/imports/v1/account-a/import-a/workbook.xlsx",
    worksheet_name: "SKU", total_rows: 2, accepted_rows: 2, rejected_rows: 0, duplicate_rows: 0,
    ready_rows: 1, failed_rows: 1, status: "PARTIAL", status_version: "4",
    config_snapshot: { stock: 5 }, config_hash: "b".repeat(64), idempotency_key: "original",
    created_by: "account-a", correlation_id: "corr-original", generated_job_id: "job-a",
    last_error_code: null, last_error_safe: null, retry_of_import_id: null,
    created_at: "2026-08-08T00:00:00.000Z", updated_at: "2026-08-08T00:01:00.000Z",
    completed_at: "2026-08-08T00:01:00.000Z", ...overrides,
  };
}

function failedRow(overrides = {}) {
  return {
    id: "row-failed", account_id: "account-a", import_file_id: "import-a", row_number: 3,
    raw_sku: "SKU-3", normalized_sku: "SKU-3", status: "FAILED", status_version: "4",
    attempt_count: 5, collect_item_id: null, auto_listing_item_id: null,
    last_error_code: "OZON_SKU_COLLECTION_FAILED", last_error_safe: null,
    created_at: "2026-08-08T00:00:00.000Z", updated_at: "2026-08-08T00:01:00.000Z",
    completed_at: "2026-08-08T00:01:00.000Z", ...overrides,
  };
}

test("detail reads one account-scoped repeatable-read snapshot", async () => {
  const calls = [];
  const client = { async query(sql, params = []) {
    calls.push([sql, params]);
    if (sql.includes("FROM auto_listing_import_files")) return { rows: [fileRow()] };
    if (sql.includes("COUNT(*) FILTER")) return { rows: [{ recoverable_failed_rows: "1", has_retry_successor: false }] };
    if (sql.includes("FROM auto_listing_import_rows")) return { rows: [failedRow()] };
    return { rows: [] };
  }, release() { calls.push(["RELEASE", []]); } };
  const repository = createPostgresAutoListingImportRecoveryRepository({ pool: { async connect() { return client; } } });
  const result = await repository.getImportDetail({ accountId: "account-a", importId: "import-a" });
  assert.equal(result.importFile.accountId, "account-a");
  assert.equal(result.rows[0].accountId, "account-a");
  assert.equal(calls[0][0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.deepEqual(calls.find(([sql]) => sql.includes("FROM auto_listing_import_files"))[1], ["account-a", "import-a"]);
  assert.ok(calls.some(([sql]) => sql === "COMMIT"));
});

test("detail explicitly marks row summaries truncated instead of silently hiding oversized imports", async () => {
  const manyRows = Array.from({ length: 1001 }, (_, index) => failedRow({ id: `row-${index + 1}`, row_number: index + 1 }));
  const client = { async query(sql) {
    if (sql.includes("FROM auto_listing_import_files")) return { rows: [fileRow({ total_rows: 1001, accepted_rows: 1001, failed_rows: 1001 })] };
    if (sql.includes("COUNT(*) FILTER")) return { rows: [{ recoverable_failed_rows: "1001", has_retry_successor: false }] };
    if (sql.includes("FROM auto_listing_import_rows")) return { rows: manyRows };
    return { rows: [] };
  }, release() {} };
  const repository = createPostgresAutoListingImportRecoveryRepository({ pool: { async connect() { return client; } } });
  const detail = await repository.getImportDetail({ accountId: "account-a", importId: "import-a" });
  assert.equal(detail.rows.length, 1000);
  assert.equal(detail.rowsTruncated, true);
  assert.equal(detail.recoverableFailedRows, 1001);
});

test("retry atomically creates one audited child import and durable outbox for recoverable failed rows", async () => {
  const calls = [];
  const child = fileRow({ id: "retry-fixed-uuid", status: "QUEUED", status_version: "1", total_rows: 1,
    accepted_rows: 1, ready_rows: 0, failed_rows: 0, generated_job_id: null, retry_of_import_id: "import-a",
    idempotency_key: "retry-1", correlation_id: "corr-1", completed_at: null });
  const client = { async query(sql, params = []) {
    calls.push([sql, params]);
    if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
    if (sql.includes("FROM auto_listing_import_retry_commands") && sql.includes("idempotency_key")) return { rows: [] };
    if (sql.includes("FROM auto_listing_import_files") && sql.includes("FOR UPDATE")) return { rows: [fileRow()] };
    if (sql.includes("FROM auto_listing_import_rows") && sql.includes("FOR UPDATE")) return { rows: [failedRow()] };
    if (sql.includes("UPDATE auto_listing_import_files") && sql.includes("RETURNING")) return { rows: [child], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release() { calls.push(["RELEASE", []]); } };
  const repository = createPostgresAutoListingImportRecoveryRepository({
    pool: { async connect() { return client; } }, randomUUID: () => "fixed-uuid",
  });
  const result = await repository.retryFailedRows({ accountId: "account-a", actorId: "account-a",
    importId: "import-a", expectedStatusVersion: 4, idempotencyKey: "retry-1", correlationId: "corr-1" });
  assert.equal(result.id, "retry-fixed-uuid");
  assert.equal(result.retryOfImportId, "import-a");
  assert.equal(result.duplicate, false);
  assert.match(calls.find(([sql]) => sql.includes("INSERT INTO auto_listing_import_rows"))[0], /retry_source_row_id/u);
  assert.match(calls.find(([sql]) => sql.includes("INSERT INTO auto_listing_source_outbox"))[0], /'PENDING'/u);
  assert.ok(calls.some(([sql]) => sql.includes("INSERT INTO auto_listing_import_retry_commands")));
  assert.deepEqual(calls.map(([sql]) => sql).filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK", "RELEASE"].includes(sql)), ["BEGIN", "COMMIT", "RELEASE"]);
});

test("retry replay returns the same child without duplicating rows or collection outbox", async () => {
  const calls = [];
  const client = { async query(sql, params = []) {
    calls.push([sql, params]);
    if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
    if (sql.includes("FROM auto_listing_import_retry_commands") && sql.includes("idempotency_key")) {
      return { rows: [{ account_id: "account-a", import_file_id: "import-a", retry_import_file_id: "import-child",
        expected_status_version: "4", idempotency_key: "retry-1", correlation_id: "corr-1", actor_id: "account-a" }] };
    }
    if (sql.includes("FROM auto_listing_import_files") && sql.includes("id=$2")) return { rows: [fileRow({ id: "import-child",
      retry_of_import_id: "import-a", status: "QUEUED", status_version: "1", generated_job_id: null, completed_at: null })] };
    return { rows: [] };
  }, release() {} };
  const repository = createPostgresAutoListingImportRecoveryRepository({ pool: { async connect() { return client; } } });
  const result = await repository.retryFailedRows({ accountId: "account-a", actorId: "account-a", importId: "import-a",
    expectedStatusVersion: 4, idempotencyKey: "retry-1", correlationId: "corr-1" });
  assert.equal(result.duplicate, true);
  assert.equal(calls.some(([sql]) => sql.includes("INSERT INTO auto_listing_import_rows")), false);
  assert.equal(calls.some(([sql]) => sql.includes("INSERT INTO auto_listing_source_outbox")), false);
});

test("retry rejects stale versions and imports without recoverable rows before writes", async () => {
  for (const [version, rows] of [[3, [failedRow()]], [4, [failedRow({ last_error_code: "AUTO_LISTING_SOURCE_RESULT_INVALID" })]]]) {
    const calls = [];
    const client = { async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("FROM auto_listing_import_retry_commands")) return { rows: [] };
      if (sql.includes("FROM auto_listing_import_files") && sql.includes("FOR UPDATE")) return { rows: [fileRow()] };
      if (sql.includes("FROM auto_listing_import_rows") && sql.includes("FOR UPDATE")) return { rows };
      return { rows: [] };
    }, release() {} };
    const repository = createPostgresAutoListingImportRecoveryRepository({ pool: { async connect() { return client; } } });
    await assert.rejects(repository.retryFailedRows({ accountId: "account-a", actorId: "account-a",
      importId: "import-a", expectedStatusVersion: version, idempotencyKey: "retry-1", correlationId: "corr-1" }), {
      code: version === 3 ? "AUTO_LISTING_IMPORT_RECOVERY_CONFLICT" : "AUTO_LISTING_IMPORT_NOT_RETRYABLE",
    });
    assert.equal(calls.some(([sql]) => sql.includes("INSERT INTO auto_listing_import_rows")), false);
  }
});

test("retry rejects non-terminal imports and a parent already occupied by another command", async () => {
  for (const mode of ["collecting", "successor"]) {
    const calls = [];
    const client = { async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql.includes("SELECT id FROM accounts")) return { rows: [{ id: "account-a" }] };
      if (sql.includes("idempotency_key=$2")) return { rows: [] };
      if (sql.includes("retry_import_file_id,idempotency_key")) {
        return { rows: mode === "successor" ? [{ retry_import_file_id: "import-child", idempotency_key: "other" }] : [] };
      }
      if (sql.includes("FROM auto_listing_import_files") && sql.includes("FOR UPDATE")) {
        return { rows: [fileRow({ status: "COLLECTING", completed_at: null })] };
      }
      return { rows: [] };
    }, release() {} };
    const repository = createPostgresAutoListingImportRecoveryRepository({ pool: { async connect() { return client; } } });
    await assert.rejects(repository.retryFailedRows({ accountId: "account-a", actorId: "account-a",
      importId: "import-a", expectedStatusVersion: 4, idempotencyKey: "retry-new", correlationId: "corr-new" }), {
      code: mode === "successor" ? "AUTO_LISTING_IMPORT_ALREADY_RETRIED" : "AUTO_LISTING_IMPORT_NOT_RETRYABLE",
    });
    assert.equal(calls.some(([sql]) => sql.includes("INSERT INTO auto_listing_import_rows")), false);
  }
});
