import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const file = new URL("../db/migrations/049_auto_listing_submission_reconciliation.sql", import.meta.url);

test("reconciliation tasks are durable, tenant bound, leased and append-audited", async () => {
  const sql = await readFile(file, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_submission_reconcile_tasks/iu);
  for (const column of [
    "account_id", "job_id", "auto_listing_item_id", "submission_link_id", "submission_job_id",
    "state", "attempt_count", "next_run_at", "lease_owner", "lease_token", "lease_expires_at",
    "last_error_code", "created_at", "updated_at",
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, "iu"));
  assert.match(sql, /UNIQUE\s*\(account_id,submission_link_id\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,job_id,auto_listing_item_id,submission_link_id,submission_job_id\)[\s\S]*auto_listing_submission_links/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,submission_job_id\)[\s\S]*submission_jobs\(account_id,id\)/iu);
  assert.match(sql, /UNIQUE INDEX IF NOT EXISTS auto_listing_submission_links_reconcile_binding_key[\s\S]*submission_job_id\s*\)\s*;/iu);
  assert.doesNotMatch(sql, /auto_listing_submission_links_reconcile_binding_key[\s\S]{0,240}WHERE\s+submission_job_id\s+IS\s+NOT\s+NULL/iu);
  assert.match(sql, /state IN \('PENDING','LEASED','COMPLETED','DEAD'\)/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_submission_reconcile_events/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,reconcile_task_id\)/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_submission_reconcile_events/iu);
  assert.match(sql, /auto_listing_reconcile_task_identity_is_immutable/iu);
  assert.match(sql, /OLD\.state = 'PENDING'[\s\S]*NEW\.state = 'LEASED'[\s\S]*NEW\.attempt_count = OLD\.attempt_count \+ 1/iu);
  assert.match(sql, /OLD\.state = 'LEASED'[\s\S]*NEW\.state = 'LEASED'[\s\S]*OLD\.lease_expires_at <= STATEMENT_TIMESTAMP\(\)/iu);
  assert.match(sql, /NEW\.updated_at < OLD\.updated_at/iu);
  assert.match(sql, /OCTET_LENGTH\(evidence::TEXT\) <= 4096/iu);
  assert.match(sql, /ISFINITE\(next_run_at\)/iu);
  assert.match(sql, /ISFINITE\(lease_expires_at\)/iu);
  assert.match(sql, /NEW\.lease_expires_at > STATEMENT_TIMESTAMP\(\)/iu);
  assert.match(sql, /state <> 'DEAD' OR last_error_code IS NOT NULL/iu);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM|CASCADE/iu);
});
