import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/036_auto_listing_import_cleanup.sql", import.meta.url);

test("import workbook cleanup has a durable account-scoped lease-fenced table", () => {
  const sql = fs.readFileSync(migrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_import_object_cleanup/u);
  assert.match(sql, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /UNIQUE \(account_id, object_key\)/u);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'PENDING' CHECK \(status IN \('PENDING', 'PROCESSING', 'COMPLETED'\)\)/u);
  assert.match(sql, /lease_token TEXT/u);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/u);
  assert.match(sql, /CHECK \(\s*\(status = 'PROCESSING'[\s\S]*completed_at IS NOT NULL\s*\)\s*\)/u);
  assert.match(sql, /auto_listing_enforce_import_cleanup_transition/u);
  assert.match(sql, /terminal import cleanup is immutable/u);
  assert.match(sql, /invalid import cleanup claim/u);
  assert.match(sql, /invalid import cleanup reclaim/u);
  assert.match(sql, /invalid import cleanup release/u);
  assert.match(sql, /FOR UPDATE/u);
  assert.doesNotMatch(sql, /api.?key|authorization|bearer|cookie|password|secret/iu);
});
