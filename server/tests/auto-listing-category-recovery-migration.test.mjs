import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(here, "../db/migrations/068_auto_listing_category_recovery.sql");

test("068 creates tenant-bound category error evidence and one recovery attempt", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE submission_category_error_evidence/);
  assert.match(sql, /CREATE TABLE submission_category_recovery_attempts/);
  assert.match(sql, /UNIQUE \(account_id,submission_job_id\)/);
  assert.match(sql, /FOREIGN KEY \(account_id,submission_job_id,submission_snapshot_id\)/);
  assert.match(sql, /submission_category_error_evidence_basis/);
  assert.match(sql, /submission_snapshot_category_recovery_basis/);
  assert.match(sql, /snapshot\.items=NEW\.original_items/);
  assert.match(sql, /item\.response->'errorEvidence'=NEW\.safe_evidence/);
  assert.match(sql, /FOREIGN KEY \(submission_job_id,submission_snapshot_id,submission_item_id,offer_id\)/);
  assert.match(sql, /CLAIMED.*MATCHED.*RETRY_PENDING.*RETRY_ACCEPTED.*SUCCEEDED.*NEEDS_REVIEW/s);
});

test("068 guards append-only evidence and the closed attempt transition lattice", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /submission_category_error_evidence_append_only/);
  assert.match(sql, /submission_category_recovery_attempt_insert/);
  assert.match(sql, /NEW\.status<>'CLAIMED'/);
  assert.match(sql, /canonical_submission_category_recovery_json/);
  assert.match(sql, /replacement_category_metadata JSONB/);
  assert.match(sql, /valid_submission_category_recovery_metadata/);
  assert.match(sql, /valid_submission_category_recovery_complex_attributes/);
  assert.match(sql, /valid_submission_category_recovery_simple_attributes/);
  assert.match(sql, /NEW\.status='MATCHED'/);
  assert.match(sql, /replacement\.source_description_category_id IS DISTINCT FROM source_evidence\.source_description_category_id/);
  assert.match(sql, /JSONB_TYPEOF\(NEW\.corrected_items\)<>'array'/);
  assert.match(sql, /submission_category_recovery_attempt_transition/);
  assert.match(sql, /ERRCODE\s*=\s*'23514'/g);
  assert.match(sql, /OLD\.corrected_items IS NOT NULL.*NEW\.corrected_items IS DISTINCT FROM OLD\.corrected_items/s);
  assert.match(sql, /OLD\.retry_ozon_task_id IS NOT NULL.*NEW\.retry_ozon_task_id IS DISTINCT FROM OLD\.retry_ozon_task_id/s);
});
