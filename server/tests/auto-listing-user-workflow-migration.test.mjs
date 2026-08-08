import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/034_auto_listing_user_workflow.sql", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

function tableBlock(sql, table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
  assert.ok(match, `expected CREATE TABLE block for ${table}`);
  return match[1];
}

test("034 keeps preferences and every import workflow record account scoped", async () => {
  const sql = await migrationSql();
  const preferences = tableBlock(sql, "auto_listing_preferences");

  assert.match(preferences, /account_id TEXT PRIMARY KEY REFERENCES accounts\(id\) ON DELETE CASCADE/i);
  assert.match(preferences, /target_store_id TEXT NOT NULL/i);
  assert.match(preferences, /target_warehouse_id TEXT NOT NULL/i);
  assert.match(preferences, /stock INTEGER NOT NULL CHECK \(stock > 0\)/i);
  assert.match(preferences, /price_adjustment_kopecks BIGINT NOT NULL DEFAULT 0/i);
  assert.match(preferences, /image_config JSONB NOT NULL/i);
  assert.match(preferences, /config_version INTEGER NOT NULL DEFAULT 1 CHECK \(config_version > 0\)/i);
  assert.match(preferences, /FOREIGN KEY \(account_id, target_store_id\)[\s\S]*?REFERENCES stores\(owner_account_id, id\)/i);
  assert.match(preferences, /FOREIGN KEY \(target_store_id, target_warehouse_id\)[\s\S]*?REFERENCES warehouses\(store_id, id\)/i);

  for (const table of [
    "auto_listing_import_files",
    "auto_listing_import_rows",
    "auto_listing_source_outbox",
  ]) {
    assert.match(tableBlock(sql, table), /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
  }
  assert.match(sql, /FOREIGN KEY \(account_id, import_file_id\)[\s\S]*?REFERENCES auto_listing_import_files\(account_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(account_id, import_file_id, row_id\)[\s\S]*?REFERENCES auto_listing_import_rows\(account_id, import_file_id, id\)/i);
});

test("034 records workbook evidence by object reference and hash without database bytes", async () => {
  const sql = await migrationSql();
  const files = tableBlock(sql, "auto_listing_import_files");

  for (const field of [
    "source_file_name TEXT NOT NULL",
    "source_content_type TEXT NOT NULL",
    "source_size_bytes BIGINT NOT NULL",
    "file_hash TEXT NOT NULL",
    "object_key TEXT NOT NULL",
    "config_snapshot JSONB NOT NULL",
    "config_hash TEXT NOT NULL",
    "idempotency_key TEXT NOT NULL",
    "correlation_id TEXT NOT NULL",
  ]) assert.match(files, new RegExp(field, "i"));

  assert.match(files, /file_hash TEXT NOT NULL CHECK \(file_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(files, /UNIQUE \(account_id, idempotency_key\)/i);
  assert.match(files, /FOREIGN KEY \(account_id, generated_job_id\)[\s\S]*?REFERENCES auto_listing_jobs\(account_id, id\)/i);
  assert.doesNotMatch(files, /\b(?:BYTEA|base64|file_bytes|workbook_data|binary_data)\b/i);
});

test("034 preserves row outcomes, deduplicates accepted SKUs, and keeps failures safe", async () => {
  const sql = await migrationSql();
  const rows = tableBlock(sql, "auto_listing_import_rows");

  assert.match(rows, /row_number INTEGER NOT NULL CHECK \(row_number > 0\)/i);
  assert.match(rows, /raw_sku TEXT NOT NULL DEFAULT ''/i);
  assert.match(rows, /normalized_sku TEXT/i);
  assert.match(rows, /OCTET_LENGTH\(normalized_sku\) BETWEEN 1 AND 160/i);
  assert.match(rows, /normalized_sku = BTRIM\(normalized_sku\)/i);
  assert.match(rows, /normalized_sku !~ '\[\[:cntrl:\]\]'/i);
  assert.match(rows, /NOT auto_listing_sku_has_forbidden_unicode\(normalized_sku\)/i);
  assert.doesNotMatch(rows, /normalized_sku ~ '\^\[0-9\]/i);
  assert.match(rows, /status TEXT NOT NULL[\s\S]*?'DUPLICATE_IN_FILE'[\s\S]*?'INVALID_SKU'[\s\S]*?'READY'[\s\S]*?'FAILED'/i);
  assert.match(rows, /attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0\)/i);
  assert.match(rows, /collect_item_id TEXT/i);
  assert.match(rows, /auto_listing_item_id TEXT/i);
  assert.match(rows, /last_error_code TEXT/i);
  assert.match(rows, /last_error_safe TEXT/i);
  assert.match(rows, /UNIQUE \(import_file_id, row_number\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_import_rows_normalized_sku_uq[\s\S]*?WHERE normalized_sku IS NOT NULL AND status <> 'DUPLICATE_IN_FILE'/i);
  assert.match(sql, /FOREIGN KEY \(account_id, collect_item_id\)[\s\S]*?REFERENCES collect_items\(account_id, id\)/i);
  assert.match(sql, /FOREIGN KEY \(account_id, auto_listing_item_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id, id\)/i);
  assert.match(sql, /last_error_code IS NULL OR last_error_code ~ '\^\[A-Z\]\[A-Z0-9_\]\{0,119\}\$'/i);
  assert.match(rows, /status IN \('DUPLICATE_IN_FILE', 'INVALID_SKU', 'READY', 'FAILED', 'CANCELLED'\)[\s\S]*?completed_at IS NOT NULL/i);
  assert.match(rows, /status_version BIGINT NOT NULL DEFAULT 0 CHECK \(status_version >= 0\)/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_import_rows_state_guard/i);
  assert.match(sql, /OLD\.status IN \('DUPLICATE_IN_FILE', 'INVALID_SKU', 'READY', 'FAILED', 'CANCELLED'\)[\s\S]*?RAISE EXCEPTION/i);
  assert.match(sql, /OLD\.status = 'PENDING' AND NEW\.status IN \('COLLECTING', 'FAILED', 'CANCELLED'\)/i);
  assert.match(sql, /OLD\.status = 'PENDING' AND NEW\.status = 'COLLECTING'[\s\S]*?NEW\.attempt_count <> OLD\.attempt_count \+ 1/i);
  assert.match(sql, /NEW\.raw_sku, NEW\.normalized_sku, NEW\.created_at[\s\S]*?import row identity or evidence is immutable/i);
  assert.match(sql, /OLD\.status = 'READY' AND NEW\.status = 'READY'[\s\S]*?OLD\.auto_listing_item_id IS NULL[\s\S]*?NEW\.status_version = OLD\.status_version \+ 1/i);
});

test("034 creates a durable, leased, idempotent Excel SKU source outbox", async () => {
  const sql = await migrationSql();
  const outbox = tableBlock(sql, "auto_listing_source_outbox");

  assert.match(outbox, /event_type TEXT NOT NULL CHECK \(event_type = 'COLLECT_EXCEL_SKU'\)/i);
  assert.match(outbox, /dedupe_key TEXT NOT NULL/i);
  assert.match(outbox, /state TEXT NOT NULL DEFAULT 'PENDING'[\s\S]*?'PROCESSING'[\s\S]*?'COMPLETED'[\s\S]*?'DEAD'/i);
  assert.match(outbox, /attempts INTEGER NOT NULL DEFAULT 0 CHECK \(attempts >= 0\)/i);
  assert.match(outbox, /state_version BIGINT NOT NULL DEFAULT 0 CHECK \(state_version >= 0\)/i);
  assert.match(outbox, /available_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(outbox, /lease_owner TEXT/i);
  assert.match(outbox, /lease_token TEXT/i);
  assert.match(outbox, /lease_expires_at TIMESTAMPTZ/i);
  assert.match(outbox, /lease_generation BIGINT NOT NULL DEFAULT 0 CHECK \(lease_generation >= 0\)/i);
  assert.match(outbox, /lease_cas_token TEXT CHECK \(lease_cas_token IS NULL\)/i);
  assert.match(outbox, /last_error_code TEXT/i);
  assert.match(outbox, /last_error_safe TEXT/i);
  assert.match(outbox, /UNIQUE \(account_id, dedupe_key\)/i);
  assert.match(outbox, /UNIQUE \(account_id, import_file_id, row_id, event_type\)/i);
  assert.match(outbox, /state = 'PROCESSING'[\s\S]*?lease_owner[\s\S]*?lease_token[\s\S]*?lease_expires_at/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_source_outbox_pending_idx[\s\S]*?WHERE state = 'PENDING'/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_source_outbox_state_guard/i);
  assert.match(sql, /OLD\.state IN \('COMPLETED', 'DEAD'\)[\s\S]*?RAISE EXCEPTION/i);
  assert.match(sql, /OLD\.state = 'PENDING' AND NEW\.state = 'PROCESSING'/i);
  assert.match(sql, /OLD\.state = 'PROCESSING' AND NEW\.state = 'PROCESSING'/i);
  assert.match(sql, /supplied_lease_token IS DISTINCT FROM OLD\.lease_token/i);
  assert.match(sql, /NEW\.event_type, NEW\.dedupe_key, NEW\.created_at[\s\S]*?source outbox identity or evidence is immutable/i);
});

test("034 closes file and row state transitions with monotonic versions", async () => {
  const sql = await migrationSql();
  const files = tableBlock(sql, "auto_listing_import_files");
  assert.match(files, /status_version BIGINT NOT NULL DEFAULT 0 CHECK \(status_version >= 0\)/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_import_files_state_guard/i);
  assert.match(sql, /OLD\.status = 'RECEIVED' AND NEW\.status IN \('QUEUED', 'CANCELLED', 'FAILED'\)/i);
  assert.match(sql, /OLD\.status = 'QUEUED' AND NEW\.status IN \('COLLECTING', 'CANCELLED', 'FAILED'\)/i);
  assert.match(sql, /OLD\.status = 'COLLECTING' AND NEW\.status IN \('READY', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'\)/i);
  assert.match(sql, /NEW\.status_version <> OLD\.status_version \+ 1/i);
  assert.match(sql, /NEW\.source_size_bytes, NEW\.file_hash, NEW\.object_key[\s\S]*?import file identity or evidence is immutable/i);
  assert.match(sql, /auto_listing_import_files_created_by_fkey[\s\S]*?ON DELETE RESTRICT/i);
  assert.match(sql, /TG_OP = 'INSERT'[\s\S]*?NEW\.ready_rows <> 0[\s\S]*?NEW\.failed_rows <> 0[\s\S]*?NEW\.generated_job_id IS NOT NULL[\s\S]*?invalid initial import file state/i);
  assert.match(sql, /NEW\.status IN \('ACCEPTED', 'PENDING'\)[\s\S]*?NEW\.attempt_count <> 0[\s\S]*?NEW\.collect_item_id IS NOT NULL[\s\S]*?NEW\.auto_listing_item_id IS NOT NULL/i);
  assert.match(sql, /NEW\.status = 'DUPLICATE_IN_FILE'[\s\S]*?NEW\.last_error_code IS DISTINCT FROM 'DUPLICATE_IN_FILE'/i);
  assert.match(sql, /NEW\.status = 'INVALID_SKU'[\s\S]*?NEW\.last_error_code NOT IN \('INVALID_SKU', 'FORMULA_RESULT_MISSING', 'SKU_COLUMN_MUST_BE_TEXT'\)/i);
  assert.match(sql, /SELECT generated_job_id[\s\S]*?FOR KEY SHARE[\s\S]*?auto_listing_job_items[\s\S]*?job_id = expected_job_id/i);
  assert.match(sql, /OLD\.status = 'COLLECTING' AND NEW\.status IN \('PENDING', 'READY', 'FAILED', 'CANCELLED'\)/i);
  assert.match(sql, /OLD\.status = 'COLLECTING' AND NEW\.status = 'PENDING'[\s\S]*?source_lease_cas_token/i);
});

test("034 bounds source leases with database statement time and finite expiry", async () => {
  const sql = await migrationSql();
  assert.match(sql, /auto_listing_source_outbox_max_lease_duration\(\)[\s\S]*?INTERVAL '5 minutes'/i);
  assert.match(sql, /NOT ISFINITE\(NEW\.lease_expires_at\)/i);
  assert.match(sql, /NEW\.lease_expires_at > STATEMENT_TIMESTAMP\(\) \+ auto_listing_source_outbox_max_lease_duration\(\)/i);
});

test("034 is additive, indexed, and never stores credentials or workbook binary", async () => {
  const sql = await migrationSql();

  for (const index of [
    "auto_listing_import_files_account_status_idx",
    "auto_listing_import_rows_import_status_idx",
    "auto_listing_import_rows_account_collect_idx",
    "auto_listing_source_outbox_pending_idx",
  ]) assert.match(sql, new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${index}`, "i"));

  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(sql, /(?:^|;)\s*UPDATE\s+\w+\s+SET\b/im);
  assert.doesNotMatch(sql, /\b(?:api_key|access_token|refresh_token|credential|secret|cookie|bearer)\s+(?:TEXT|JSONB|BYTEA)/i);
  assert.doesNotMatch(sql, /\b(?:workbook|file|source)_?(?:bytes|binary|base64)\s+(?:TEXT|JSONB|BYTEA)/i);
});
