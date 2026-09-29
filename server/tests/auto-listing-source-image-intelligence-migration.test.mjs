import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/103_auto_listing_source_image_intelligence.sql", import.meta.url);

test("migration 103 adds scoped intelligence evidence without rewriting old tables", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "auto_listing_source_image_analysis_runs",
    "auto_listing_source_image_assessments",
    "auto_listing_source_image_decisions",
    "auto_listing_image_group_checks",
  ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}`, "u"));
  assert.match(sql, /source_analysis_run_id TEXT/u);
  assert.match(sql, /contract_version IN \('V1', 'V2', 'V3'\)/u);
  assert.match(sql, /ANALYZE_SOURCE_IMAGE_BATCH/u);
  assert.match(sql, /CHECK_IMAGE_GROUP/u);
});

test("migration 103 binds evidence and source objects to one account-scoped owner", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /FOREIGN KEY \(account_id, job_id, item_id, parent_run_id\)[\s\S]*?REFERENCES auto_listing_source_image_analysis_runs/u);
  assert.match(sql, /FOREIGN KEY \(account_id, job_id, item_id, source_analysis_run_id\)[\s\S]*?REFERENCES auto_listing_source_image_analysis_runs/u);
  assert.match(sql, /\(\(parent_plan_id IS NOT NULL\)::INTEGER \+ \(source_analysis_run_id IS NOT NULL\)::INTEGER\) = 1/u);
  assert.match(sql, /auto-listing\/source\/v2\//u);
  assert.match(sql, /SOURCE_V1[\s\S]*?parent_plan_id IS NOT NULL/u);
  assert.match(sql, /SOURCE_V2[\s\S]*?source_analysis_run_id IS NOT NULL/u);
});

test("migration 103 preserves old planning contracts and requires intelligence only for the new contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /LEGACY_FULL_PLAN_V3/u);
  assert.match(sql, /FIXED_SKELETON_V1/u);
  assert.match(sql, /FIXED_SKELETON_SOURCE_IMAGE_V1/u);
  assert.match(sql, /source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL/u);
  assert.match(sql, /source_image_analysis_run_id IS NOT NULL[\s\S]*?source_image_intelligence_hash ~ '\^\[a-f0-9\]\{64\}\$'/u);
  assert.match(sql, /auto_listing_content_plan_contract_guard/u);
  assert.match(sql, /validate_auto_listing_content_plan_response_owner/u);
});

test("migration 103 keeps V1 and V2 phases while V3 uses exact phase targets", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /row_contract_version IN \('V1', 'V2'\)[\s\S]*?PLAN_CONTENT[\s\S]*?GENERATE_RICH_CONTENT/u);
  for (const pair of [
    ["MATERIALIZE_SOURCE_ASSET", "sourceAssetId"],
    ["ANALYZE_SOURCE_IMAGE_BATCH", "analysisBatchId"],
    ["RECONCILE_SOURCE_IMAGE_ANALYSIS", "analysisRunId"],
    ["GENERATE_IMAGE_SLOT", "slotKey"],
    ["CHECK_IMAGE_GROUP", "visualGroupKey"],
  ]) assert.match(sql, new RegExp(`${pair[0]}[\\s\\S]*?${pair[1]}`, "u"));
  assert.match(sql, /WHERE contract_version IN \('V1', 'V2', 'V3'\) AND state = 'PENDING'/u);
  assert.match(sql, /WHERE contract_version IN \('V1', 'V2', 'V3'\) AND state = 'PROCESSING'/u);
});
