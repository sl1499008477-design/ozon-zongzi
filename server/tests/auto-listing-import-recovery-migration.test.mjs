import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../db/migrations/040_auto_listing_import_recovery.sql", import.meta.url), "utf8").catch(() => "");
const lineageSql = await readFile(new URL("../db/migrations/042_auto_listing_import_retry_lineage.sql", import.meta.url), "utf8").catch(() => "");

test("import recovery migration adds traceable child imports and immutable retry commands", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS retry_of_import_id TEXT/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,retry_of_import_id\)[\s\S]*auto_listing_import_files\(account_id,id\)/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_import_retry_commands/iu);
  assert.match(sql, /UNIQUE \(account_id,idempotency_key\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,retry_import_file_id\)[\s\S]*auto_listing_import_files\(account_id,id\)/iu);
  assert.match(sql, /retry_of_import_id IS DISTINCT FROM OLD\.retry_of_import_id/iu);
});

test("shared immutable workbook evidence can be referenced by retry child imports", () => {
  assert.match(sql, /DROP CONSTRAINT IF EXISTS auto_listing_import_files_account_id_object_key_key/iu);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_import_files_account_object_idx/iu);
});

test("retry lineage migration gives each failed row and parent import at most one successor", () => {
  assert.match(lineageSql, /ADD COLUMN IF NOT EXISTS retry_source_row_id TEXT/iu);
  assert.match(lineageSql, /UNIQUE INDEX[\s\S]*account_id,retry_source_row_id/iu);
  assert.match(lineageSql, /UNIQUE INDEX[\s\S]*account_id,import_file_id/iu);
  assert.match(lineageSql, /FOREIGN KEY \(account_id,retry_source_row_id\)[\s\S]*auto_listing_import_rows\(account_id,id\)/iu);
  assert.match(lineageSql, /retry_source_row_id IS DISTINCT FROM OLD\.retry_source_row_id/iu);
  assert.match(lineageSql, /source\.status <> 'FAILED'/iu);
  assert.match(lineageSql, /AUTO_LISTING_IMPORT_RETRY_HISTORY_CONFLICT/iu);
  assert.match(lineageSql, /ERRCODE='P4202'/iu);
  assert.match(lineageSql, /AUTO_LISTING_IMPORT_RETRY_LINEAGE_SOURCE_INVALID/iu);
  assert.match(lineageSql, /ERRCODE='P4203'/iu);
  assert.match(lineageSql, /source\.status='FAILED'/iu);
  assert.match(lineageSql, /auto_listing_import_retry_lineage_backfill_audit/iu);
  assert.match(lineageSql, /DISABLE TRIGGER auto_listing_import_rows_state_guard[\s\S]*ENABLE TRIGGER auto_listing_import_rows_state_guard/iu);
  assert.match(lineageSql, /source\.row_number <> NEW\.row_number/iu);
  assert.match(lineageSql, /source\.raw_sku IS DISTINCT FROM NEW\.raw_sku/iu);
});
