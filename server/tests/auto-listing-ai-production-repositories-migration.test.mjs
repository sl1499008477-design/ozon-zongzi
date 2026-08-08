import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/032_auto_listing_ai_runtime.sql", import.meta.url);

test("032 adds an opt-in status-version fence for new generation attempts without rewriting legacy rows", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE ai_generation_assets[\s\S]*?ADD COLUMN IF NOT EXISTS expected_status_version INTEGER/i);
  assert.match(sql, /ai_generation_assets_expected_status_version_check[\s\S]*?expected_status_version IS NULL[\s\S]*?expected_status_version BETWEEN 1 AND 2147483647/i);
  assert.doesNotMatch(sql, /ALTER COLUMN expected_status_version SET NOT NULL/i);
  assert.doesNotMatch(sql, /UPDATE\s+ai_generation_assets\s+SET[\s\S]*?expected_status_version/i);
});

test("032 adds the closed planner request contract while preserving historical null rows", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE auto_listing_content_plan_attempts[\s\S]*?ADD COLUMN IF NOT EXISTS expected_status_version INTEGER[\s\S]*?ADD COLUMN IF NOT EXISTS request_key TEXT/i);
  assert.match(sql, /auto_listing_content_plan_attempt_request_contract_check[\s\S]*?expected_status_version IS NULL AND request_key IS NULL[\s\S]*?expected_status_version BETWEEN 1 AND 2147483647[\s\S]*?request_key ~ '\^auto-listing-plan-\[a-f0-9\]\{64\}\$'/i);
  assert.match(sql, /auto_listing_content_plan_attempts_active_request_key[\s\S]*?WHERE status = 'PLANNING' AND request_key IS NOT NULL/i);
  assert.match(sql, /auto_listing_content_plan_attempts_accepted_request_key[\s\S]*?WHERE status = 'ACCEPTED' AND request_key IS NOT NULL/i);
  assert.match(sql, /auto_listing_content_plan_attempt_require_runtime_contract[\s\S]*?BEFORE INSERT ON auto_listing_content_plan_attempts/i);
  assert.match(sql, /auto_listing_content_plan_attempt_identity_immutable[\s\S]*?BEFORE UPDATE ON auto_listing_content_plan_attempts/i);
  assert.doesNotMatch(sql, /ALTER COLUMN (?:expected_status_version|request_key) SET NOT NULL/i);
  assert.doesNotMatch(sql, /UPDATE\s+auto_listing_content_plan_attempts\s+SET[\s\S]*?(?:expected_status_version|request_key)/i);
});

test("032 serializes content planning per item without deleting conflicting audit rows", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /SELECT 1[\s\S]*?FROM auto_listing_content_plan_attempts[\s\S]*?WHERE status = 'PLANNING'[\s\S]*?GROUP BY account_id,job_id,item_id[\s\S]*?HAVING COUNT\(\*\) > 1[\s\S]*?RAISE EXCEPTION/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_one_planning_per_item[\s\S]*?ON auto_listing_content_plan_attempts\(account_id, job_id, item_id\)[\s\S]*?WHERE status = 'PLANNING'/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+auto_listing_content_plan_attempts/i);
});

test("032 stores the closed fact registry beside each new content plan without rewriting historical plans", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE ai_content_plans[\s\S]*?ADD COLUMN IF NOT EXISTS fact_registry JSONB[\s\S]*?ADD COLUMN IF NOT EXISTS fact_registry_hash TEXT/i);
  assert.match(sql, /ai_content_plans_fact_registry_contract_check[\s\S]*?fact_registry IS NULL AND fact_registry_hash IS NULL[\s\S]*?jsonb_typeof\(fact_registry\) = 'array'[\s\S]*?jsonb_array_length\(fact_registry\) BETWEEN 1 AND 10000[\s\S]*?fact_registry_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
  assert.doesNotMatch(sql, /ALTER COLUMN (?:fact_registry|fact_registry_hash) SET NOT NULL/i);
  assert.doesNotMatch(sql, /UPDATE\s+ai_content_plans\s+SET[\s\S]*?(?:fact_registry|fact_registry_hash)/i);
});

test("032 keeps one active-content-plan column declaration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const matches = sql.match(/ADD COLUMN IF NOT EXISTS active_content_plan_id TEXT/gi) || [];
  assert.equal(matches.length, 1);
});
