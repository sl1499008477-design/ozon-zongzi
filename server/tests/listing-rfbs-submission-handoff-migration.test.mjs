import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = path.join(path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations/061_auto_listing_rfbs_submission_handoff.sql");

test("061 is an additive tenant-bound RFBS handoff with separate identity and attempt evidence", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS submission_rfbs_handoffs/iu);
  assert.match(sql, /link_identity_evidence_id TEXT NOT NULL/iu);
  assert.match(sql, /attempt_authorization_evidence_id TEXT NOT NULL/iu);
  assert.match(sql, /reserved_attempt_id TEXT NOT NULL/iu);
  assert.match(sql, /link\.warehouse_validation_evidence_id=NEW\.link_identity_evidence_id/iu);
  assert.match(sql, /attempt\.warehouse_validation_evidence_id=NEW\.attempt_authorization_evidence_id/iu);
  assert.match(sql, /link\.status='RESERVED'[\s\S]*link\.status IN \('SUBMITTED','RECONCILING','SUCCEEDED'\)/iu);
  assert.match(sql, /INSERT INTO submission_rfbs_handoffs[\s\S]*rfbs-handoff-backfill/iu);
  assert.match(sql, /unresolved AUTO_LISTING fulfillment blocks migration 061/iu);
  assert.match(sql, /link\.submission_job_id IS NULL[\s\S]*listing_base\.collect_item_id=job\.collect_item_id/iu);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER submission_jobs_rfbs_handoff_commit_gate/iu);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/iu);
  assert.match(sql, /AUTO_LISTING RFBS lineage requires an exact handoff/iu);
  assert.match(sql, /stock->>'warehouse_id'=attempt_evidence\.platform_warehouse_id/iu);
  assert.doesNotMatch(sql, /api_key|encrypted_api_key|raw_response|generated_content/iu);
});

test("061 phase authorization is append-only and permits only parent-account cascade cleanup", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS submission_rfbs_write_authorizations/iu);
  assert.match(sql, /phase TEXT NOT NULL CHECK \(phase IN \('PRE_IMPORT','PRE_STOCK'\)\)/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON submission_rfbs_handoffs/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON submission_rfbs_write_authorizations/iu);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM accounts WHERE id=OLD\.account_id\)/iu);
  assert.match(sql, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/iu);
});
