import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  here,
  "../db/migrations/074_auto_listing_configurable_skeleton_diagnostics.sql",
);

test("074 additively freezes planning contracts and durable planner stages", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /ALTER TABLE auto_listing_job_items[\s\S]*ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3'/iu);
  assert.match(sql, /ALTER TABLE ai_content_plans[\s\S]*planning_contract[\s\S]*skeleton_hash/iu);
  assert.match(sql, /ALTER TABLE auto_listing_content_plan_attempts[\s\S]*planning_contract[\s\S]*skeleton_hash[\s\S]*planner_stage/iu);
  assert.match(sql, /BUILDING_SKELETON[\s\S]*FILLING_COPY[\s\S]*VALIDATING_COPY[\s\S]*COMPLETED[\s\S]*FAILED/iu);
  assert.match(sql, /auto_listing_content_plan_attempt_stage_guard/iu);
  assert.match(sql, /item\.planning_contract=NEW\.planning_contract/iu);
  assert.match(sql, /auto_listing_content_plan_contract_guard/iu);
  assert.match(sql, /ERRCODE\s*=\s*'23514'/iu);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/iu);
});

test("074 creates tenant-bound immutable response and validation evidence", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_content_plan_diagnostic_runs/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_content_plan_responses/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_content_plan_validation_results/iu);
  assert.match(sql, /attempt_id IS NOT NULL AND diagnostic_run_id IS NULL[\s\S]*attempt_id IS NULL AND diagnostic_run_id IS NOT NULL/iu);
  assert.match(sql, /UNIQUE\s*\(account_id,idempotency_key\)/iu);
  assert.match(sql, /auto_listing_content_plan_evidence_append_only/iu);
  assert.match(sql, /auto_listing_content_plan_validation_append_only/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,job_id,item_id,source_snapshot_id\)/iu);
  assert.doesNotMatch(sql, /\bON DELETE SET NULL\b/iu);
});
