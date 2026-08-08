import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/032_auto_listing_ai_runtime.sql", import.meta.url);

test("032 freezes source materialization version, statusVersion and exact stored-object evidence", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");
  assert.match(sql, /auto_listing_source_materialization_attempts[\s\S]*?expected_status_version INTEGER NOT NULL[\s\S]*?object_key_version TEXT/i);
  assert.match(sql, /object_key_version = 'SOURCE_V1'/i);
  assert.match(sql, /status = 'MATERIALIZING'[\s\S]*?object_key IS NULL[\s\S]*?content_hash IS NULL/i);
  assert.match(sql, /status = 'STORED'[\s\S]*?object_key IS NOT NULL[\s\S]*?content_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?content_type IN \('image\/png','image\/jpeg','image\/webp'\)/i);
  assert.match(sql, /auto_listing_source_materialization_object_key_valid/i);
  assert.match(sql, /\/attempt-'\s*\|\|\s*row_attempt_no/i);
  assert.match(sql, /auto_listing_source_materialization_terminal_immutable/i);
});

test("032 enforces retry bounds, active/accepted uniqueness and full composite ownership", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");
  assert.match(sql, /attempt_no BETWEEN 1 AND 3/i);
  assert.match(sql, /auto_listing_source_materialization_active_input_key[\s\S]*?WHERE status IN \('MATERIALIZING', 'STORED'\)/i);
  assert.match(sql, /auto_listing_source_materialization_accepted_input_key[\s\S]*?WHERE status = 'ACCEPTED'/i);
  assert.match(sql, /UNIQUE \(account_id, job_id, item_id, parent_plan_id, source_asset_id, source_ref_hash, input_hash, attempt_no\)/i);
  assert.match(sql, /FOREIGN KEY \(account_id, job_id, item_id, parent_plan_id\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.doesNotMatch(sql, /source_url|redirect_url|response_body/i);
});

test("032 persists versioned source-object cleanup evidence without weakening the materialization scope", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");
  assert.match(sql, /auto_listing_source_object_cleanup_obligations[\s\S]*?object_key_version TEXT NOT NULL[\s\S]*?original_error_code TEXT NOT NULL/i);
  assert.match(sql, /auto_listing_source_object_cleanup_obligations[\s\S]*?source_ref_hash TEXT NOT NULL[\s\S]*?input_hash TEXT NOT NULL[\s\S]*?expected_status_version INTEGER NOT NULL[\s\S]*?attempt_no INTEGER NOT NULL[\s\S]*?lease_token TEXT NOT NULL/i);
  assert.match(sql, /auto_listing_source_object_cleanup_obligations[\s\S]*?content_type TEXT NOT NULL[\s\S]*?width INTEGER NOT NULL[\s\S]*?height INTEGER NOT NULL[\s\S]*?size_bytes INTEGER NOT NULL/i);
  assert.match(sql, /UNIQUE \(account_id, object_key\)/i);
  assert.match(sql, /FOREIGN KEY \(account_id, job_id, item_id, parent_plan_id, source_asset_id, materialization_attempt_id\)[\s\S]*?REFERENCES auto_listing_source_materialization_attempts/i);
  assert.match(sql, /object_key_version = 'SOURCE_V1'/i);
  assert.doesNotMatch(sql, /auto_listing_source_cleanup_stored_evidence_fkey/i);
});
