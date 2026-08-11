import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(__dirname, "../db/migrations/059_auto_listing_rfbs_warehouse_evidence.sql");

test("059 adds tenant-bound append-only RFBS evidence and nullable consumer bindings", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_rfbs_warehouse_evidence/iu);
  assert.match(sql, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,store_id\)[\s\S]*REFERENCES stores\(owner_account_id,id\)/iu);
  assert.match(sql, /FOREIGN KEY \(store_id,warehouse_record_id,platform_warehouse_id\)[\s\S]*REFERENCES warehouses\(store_id,id,warehouse_id\)/iu);
  assert.match(sql, /fulfillment_type TEXT NOT NULL CHECK \(fulfillment_type = 'RFBS'\)/iu);
  assert.match(sql, /outcome TEXT NOT NULL CHECK \(outcome = 'PASSED'\)/iu);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL CHECK \(expires_at > observed_at\)/iu);
  assert.match(sql, /raw_response_ref TEXT[\s\S]*raw_response_ref IS NULL[\s\S]*OCTET_LENGTH\(raw_response_ref\) <= 500/iu);
  assert.match(sql, /BEFORE INSERT ON auto_listing_rfbs_warehouse_evidence[\s\S]*STATEMENT_TIMESTAMP\(\)/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_rfbs_warehouse_evidence/iu);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM accounts WHERE id = OLD\.account_id\)/iu);
  assert.match(sql, /NOT EXISTS \([\s\S]*FROM stores[\s\S]*owner_account_id=OLD\.account_id[\s\S]*id=OLD\.store_id/iu);

  for (const table of ["auto_listing_jobs", "auto_listing_submission_links", "auto_listing_upload_attempts"]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+[\\s\\S]*ADD COLUMN IF NOT EXISTS warehouse_validation_evidence_id TEXT`, "iu"));
    assert.match(sql, new RegExp(`ALTER TABLE ${table}[\\s\\S]*FOREIGN KEY \\(account_id,warehouse_validation_evidence_id\\)[\\s\\S]*REFERENCES auto_listing_rfbs_warehouse_evidence\\(account_id,id\\)`, "iu"));
  }
  for (const table of ["auto_listing_submission_links", "auto_listing_upload_attempts"]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}[\\s\\S]*auto_listing_rfbs_warehouse_evidence\\(account_id,id\\) ON DELETE RESTRICT`, "iu"));
  }
});

test("059 protects immutable RFBS bindings on jobs and existing upload evidence", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /auto_listing_jobs[\s\S]*warehouse_validation_evidence_id IS DISTINCT FROM OLD\.warehouse_validation_evidence_id/iu);
  assert.match(sql, /auto_listing_submission_links[\s\S]*warehouse_validation_evidence_id IS DISTINCT FROM OLD\.warehouse_validation_evidence_id/iu);
  assert.match(sql, /auto_listing_upload_attempts[\s\S]*warehouse_validation_evidence_id IS DISTINCT FROM OLD\.warehouse_validation_evidence_id/iu);
});

test("059 permits only parent-driven audit scope anonymization during controlled privacy cleanup", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /NEW\.account_id IS NULL[\s\S]*NOT EXISTS \(SELECT 1 FROM accounts WHERE id=OLD\.account_id\)/iu);
  assert.match(sql, /NEW\.store_id IS NULL[\s\S]*NOT EXISTS \([\s\S]*FROM stores[\s\S]*id=OLD\.store_id/iu);
  assert.match(sql, /TO_JSONB\(NEW\)-'account_id'-'store_id'[\s\S]*TO_JSONB\(OLD\)-'account_id'-'store_id'/iu);
  assert.match(sql, /NEW\.account_id IS DISTINCT FROM OLD\.account_id[\s\S]*NEW\.store_id IS DISTINCT FROM OLD\.store_id/iu);
});
