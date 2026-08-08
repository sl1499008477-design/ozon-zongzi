import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/032_auto_listing_ai_runtime.sql", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

function tableBlock(sql, table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
  assert.ok(match, `expected CREATE TABLE block for ${table}`);
  return match[1];
}

test("032 upgrades only new-contract outbox rows to a closed, fenced and immutable publication contract", async () => {
  const sql = await migrationSql();

  for (const column of [
    "contract_version TEXT", "expected_status_version INTEGER", "correlation_id TEXT", "phase TEXT",
    "phase_target_id TEXT", "lease_token TEXT", "publication_id TEXT", "published_at TIMESTAMPTZ",
    "next_retry_at TIMESTAMPTZ",
  ]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));

  assert.match(sql, /CHECK \(\s*contract_version IS NULL OR contract_version = 'V1'\s*\) NOT VALID/i);
  assert.match(sql, /auto_listing_ai_outbox_new_contract_check CHECK \([\s\S]*?contract_version IS NULL OR \(\([\s\S]*?\) IS TRUE\s*\)\s*\) NOT VALID/i);
  assert.match(sql, /phase IN \('PLAN_CONTENT', 'MATERIALIZE_SOURCE_ASSET', 'FINALIZE_MATERIALIZED_PLAN', 'GENERATE_IMAGE_SLOT', 'GENERATE_RICH_CONTENT'\)/i);
  assert.match(sql, /last_error_code ~ '\^\[A-Z\]\[A-Z0-9_\]\{0,119\}\$'/i);
  assert.match(sql, /jsonb_typeof\(value\) IS DISTINCT FROM 'object'/i);
  assert.match(sql, /COUNT\(\*\)[\s\S]*?FROM jsonb_object_keys\(value\)/i);
  assert.match(sql, /value->>'contractVersion' <> row_contract_version/i);
  assert.match(sql, /value->>'expectedStatusVersion'/i);
  assert.match(sql, /value->>'correlationId' <> row_correlation_id/i);
  assert.match(sql, /value->>'phase' <> row_phase/i);
  assert.match(sql, /phase_target_id IS NULL/i);
  assert.match(sql, /value->>'sourceAssetId' = row_phase_target_id/i);
  assert.match(sql, /value->>'slotKey' = row_phase_target_id/i);
  assert.match(sql, /\(value->'expectedStatusVersion'\)::INTEGER <> row_expected_status_version/i);
  assert.match(sql, /\(state = 'PROCESSING'[\s\S]*?lease_owner IS NOT NULL[\s\S]*?lease_token IS NOT NULL[\s\S]*?lease_expires_at IS NOT NULL/i);
  assert.match(sql, /state = 'COMPLETED'[\s\S]*?publication_id IS NOT NULL[\s\S]*?published_at IS NOT NULL/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_ai_outbox_terminal_immutable/i);
  assert.match(sql, /OLD\.state IN \('SUCCEEDED', 'COMPLETED', 'DEAD'\)/i);
  assert.match(sql, /NOT VALID/i);
  assert.doesNotMatch(sql, /(?:source|redirect|download)_url\s+TEXT/i);
  assert.doesNotMatch(sql, /\bsource_ref\s+TEXT/i);
});

test("032 adds account-scoped planner, materialization, derived-plan and cleanup persistence", async () => {
  const sql = await migrationSql();
  const planner = tableBlock(sql, "auto_listing_content_plan_attempts");
  const materialization = tableBlock(sql, "auto_listing_source_materialization_attempts");
  const derivations = tableBlock(sql, "auto_listing_content_plan_derivations");
  const cleanup = tableBlock(sql, "auto_listing_source_object_cleanup_obligations");

  assert.match(sql, /ALTER TABLE auto_listing_job_items[\s\S]*?ADD COLUMN IF NOT EXISTS active_content_plan_id TEXT/i);
  assert.match(sql, /FOREIGN KEY \(account_id, job_id, id, active_content_plan_id\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.match(sql, /ALTER TABLE ai_content_plans[\s\S]*?ADD COLUMN IF NOT EXISTS parent_plan_id TEXT[\s\S]*?ADD COLUMN IF NOT EXISTS derivation_kind TEXT[\s\S]*?ADD COLUMN IF NOT EXISTS materialization_set_hash TEXT/i);
  assert.match(sql, /parent_plan_id IS NULL[\s\S]*?derivation_kind IS NULL[\s\S]*?materialization_set_hash IS NULL[\s\S]*?OR[\s\S]*?parent_plan_id IS NOT NULL[\s\S]*?derivation_kind = 'SOURCE_MATERIALIZATION'[\s\S]*?materialization_set_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);

  for (const block of [planner, materialization, derivations, cleanup]) {
    assert.match(block, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
    assert.match(block, /FOREIGN KEY \(account_id, job_id, item_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id, job_id, id\) ON DELETE RESTRICT/i);
  }
  assert.match(planner, /lease_token TEXT/i);
  assert.match(planner, /status TEXT NOT NULL[\s\S]*?'PLANNING'[\s\S]*?'ACCEPTED'[\s\S]*?'FAILED'/i);
  assert.match(materialization, /source_ref_hash TEXT NOT NULL CHECK \(source_ref_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(materialization, /lease_token TEXT/i);
  assert.match(materialization, /FOREIGN KEY \(account_id, job_id, item_id, parent_plan_id\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.match(materialization, /UNIQUE \(account_id, job_id, item_id, parent_plan_id, source_asset_id, id\)/i);
  assert.match(derivations, /UNIQUE \(account_id, job_id, item_id, parent_plan_id, materialization_set_hash\)/i);
  assert.match(cleanup, /claim_token TEXT/i);
  assert.match(cleanup, /FOREIGN KEY \(account_id, job_id, item_id, parent_plan_id, source_asset_id, materialization_attempt_id\)[\s\S]*?REFERENCES auto_listing_source_materialization_attempts\(\s*account_id, job_id, item_id, parent_plan_id, source_asset_id, id\s*\)/i);
  assert.match(sql, /ADD CONSTRAINT auto_listing_source_materialization_attempt_scope_asset_key\s+UNIQUE \(account_id, job_id, item_id, parent_plan_id, source_asset_id, id\)/i);
  assert.match(sql, /ADD CONSTRAINT auto_listing_source_cleanup_materialization_asset_fkey\s+FOREIGN KEY \(account_id, job_id, item_id, parent_plan_id, source_asset_id, materialization_attempt_id\)[\s\S]*?NOT VALID/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_active_input_key[\s\S]*?WHERE status = 'PLANNING'/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_source_materialization_accepted_input_key[\s\S]*?WHERE status = 'ACCEPTED'/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_content_plan_attempts_terminal_immutable/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_source_materialization_terminal_immutable/i);
});

test("032 is additive and does not backfill, delete or expose source locations or credentials", async () => {
  const sql = await migrationSql();
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(sql, /(?:^|;)\s*UPDATE\s+\w+\s+SET\b/im);
  assert.doesNotMatch(sql, /\b(?:api_key|access_token|refresh_token|credential|secret|cookie|bearer)\s+(?:TEXT|JSONB|BYTEA)/i);
  assert.doesNotMatch(sql, /\b(?:url|source_ref|redirect_location)\s+(?:TEXT|JSONB|BYTEA)/i);
});

test("032 freezes one optional account-scoped AI profile version on each new job without rewriting history", async () => {
  const sql = await migrationSql();

  assert.match(sql, /ALTER TABLE auto_listing_jobs[\s\S]*?ADD COLUMN IF NOT EXISTS ai_profile_id TEXT[\s\S]*?ADD COLUMN IF NOT EXISTS ai_profile_version INTEGER/i);
  assert.match(sql, /CHECK \(\s*\(ai_profile_id IS NULL AND ai_profile_version IS NULL\)[\s\S]*?OR \(ai_profile_id IS NOT NULL AND ai_profile_version IS NOT NULL[\s\S]*?ai_profile_version > 0\)[\s\S]*?\) NOT VALID/i);
  assert.match(sql, /FOREIGN KEY \(account_id, ai_profile_id, ai_profile_version\)[\s\S]*?REFERENCES ai_gateway_profiles\(account_id, id, config_version\) ON DELETE RESTRICT NOT VALID/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_jobs_protect_ai_profile\(\)/i);
  assert.match(sql, /NEW\.ai_profile_id IS DISTINCT FROM OLD\.ai_profile_id[\s\S]*?NEW\.ai_profile_version IS DISTINCT FROM OLD\.ai_profile_version/i);
  assert.match(sql, /CREATE TRIGGER auto_listing_jobs_ai_profile_immutable[\s\S]*?BEFORE UPDATE ON auto_listing_jobs/i);
  assert.doesNotMatch(sql, /UPDATE\s+auto_listing_jobs\s+SET\s+ai_profile_/i);
});

test("032 freezes referenced profile runtime fields from job creation before any content plan exists", async () => {
  const sql = await migrationSql();
  const functionMatch = sql.match(/CREATE OR REPLACE FUNCTION auto_listing_protect_referenced_ai_gateway_profile\(\)[\s\S]*?\$\$;/i);
  assert.ok(functionMatch);
  const protection = functionMatch[0];
  assert.match(protection, /FROM ai_content_plans[\s\S]*?profile_id = OLD\.id[\s\S]*?profile_version = OLD\.config_version/i);
  assert.match(protection, /FROM auto_listing_jobs[\s\S]*?ai_profile_id = OLD\.id[\s\S]*?ai_profile_version = OLD\.config_version/i);
  for (const field of [
    "account_id", "id", "base_url", "api_key_env_name", "text_protocol", "image_protocol",
    "text_model", "image_model", "config_version",
  ]) assert.match(protection, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, "i"));
  assert.match(protection, /RAISE EXCEPTION 'referenced AI gateway profile configuration is immutable'\s+USING ERRCODE = '23514'/i);
  assert.doesNotMatch(protection, /NEW\.(?:capability_result|capability_checked_at|enabled) IS DISTINCT FROM/i);
});
