import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/024_collect_category_resolution.sql", import.meta.url);
const runtimeCursorMigrationUrl = new URL(
  "../db/migrations/025_collect_category_resolution_runtime_cursor.sql",
  import.meta.url,
);

test("category resolution migration adds an account-scoped, non-destructive current-record table", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /CREATE TABLE collect_category_resolutions/);
  assert.match(sql, /UNIQUE \(account_id, collect_item_id, taxonomy_scope\)/);
  assert.match(sql, /REFERENCES accounts\(id\) ON DELETE CASCADE/);
  assert.match(sql, /REFERENCES collect_items\(id\) ON DELETE CASCADE/);
  assert.match(sql, /REFERENCES stores\(id\) ON DELETE SET NULL/);
  assert.match(sql, /CHECK \(status IN \('[^']+'(?:, '[^']+')+\)\)/);
  assert.match(sql, /CHECK \([\s\S]*target_description_category_id[\s\S]*target_type_id[\s\S]*method[\s\S]*\)/);
  assert.match(sql, /ON collect_category_resolutions\(status, next_attempt_at\)/);
  assert.match(sql, /ON collect_category_resolutions\(account_id, collect_item_id\)/);
  assert.match(
    sql.replace(/\s+/g, " "),
    /CHECK \( \(status = 'MATCHING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL\) OR \(status <> 'MATCHING' AND lease_token IS NULL AND lease_expires_at IS NULL\) \)/,
  );
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
  assert.doesNotMatch(sql, /product_drafts|categoryResolution/);
});

test("category resolution worker cursor migration is additive and restart-safe", async () => {
  const sql = await readFile(runtimeCursorMigrationUrl, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS collect_category_resolution_runtime_cursors/);
  assert.match(sql, /worker_key TEXT PRIMARY KEY/);
  assert.match(sql, /cursor_key TEXT NOT NULL/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
});
