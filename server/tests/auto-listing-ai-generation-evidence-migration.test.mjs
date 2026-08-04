import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/029_auto_listing_ai_generation_evidence.sql", import.meta.url);
const attemptIsolationMigrationUrl = new URL("../db/migrations/030_auto_listing_generated_asset_attempt_isolation.sql", import.meta.url);
const immutableContentMigrationUrl = new URL("../db/migrations/027_auto_listing_ai_content.sql", import.meta.url);

test("generation evidence migration is additive and preserves an immutable audit trail", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const column of ["plan_hash TEXT", "source_hash TEXT", "strategy_hash TEXT", "config_hash TEXT", "visual_groups_hash TEXT", "prompt_template_version TEXT", "source_asset_evidence JSONB", "checker_request_id TEXT", "model_evidence JSONB", "regeneration JSONB", "size_bytes BIGINT", "lease_token TEXT", "lease_expires_at TIMESTAMPTZ", "attempt_identity_hash TEXT", "generation_size TEXT", "final_input_bound_at TIMESTAMPTZ"]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
  for (const column of ["plan_hash", "source_hash", "strategy_hash", "config_hash", "visual_groups_hash"]) assert.match(sql, new RegExp(`${column} IS NULL OR ${column} ~ '\\^\\[a-f0-9\\]\\{64\\}\\$'`, "i"));
  assert.match(sql, /source_asset_evidence IS NULL OR jsonb_typeof\(source_asset_evidence\) = 'array'/i);
  assert.match(sql, /auto_listing_generation_source_evidence_complete\(source_asset_evidence\)/i);
  assert.match(sql, /jsonb_array_length\(value\) NOT BETWEEN 1 AND 7/i);
  assert.match(sql, /COALESCE\(jsonb_typeof\(entry->'contentType'\), 'null'\) <> 'string'/i);
  assert.match(sql, /COUNT\(DISTINCT item->>'assetId'\)[\s\S]*?<> jsonb_array_length\(value\)/i);
  for (const column of ["plan_hash", "source_hash", "strategy_hash", "config_hash", "visual_groups_hash", "model_evidence"]) assert.match(sql, new RegExp(`${column} IS NOT NULL`, "i"));
  assert.match(sql, /status <> 'ACCEPTED'[\s\S]*?plan_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?source_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?strategy_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?config_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?visual_groups_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?prompt_template_version[\s\S]*?source_asset_evidence[\s\S]*?checker_request_id[\s\S]*?model_evidence[\s\S]*?size_bytes/is);
  assert.match(sql, /\(lease_token IS NULL\) = \(lease_expires_at IS NULL\)/i);
  assert.match(sql, /status = 'GENERATING'[\s\S]*?NULLIF\(BTRIM\(lease_token\), ''\) IS NOT NULL[\s\S]*?lease_expires_at IS NOT NULL[\s\S]*?status <> 'GENERATING'[\s\S]*?lease_token IS NULL[\s\S]*?lease_expires_at IS NULL/is);
  assert.match(sql, /ai_generation_assets_attempt_binding_check[\s\S]*?attempt_identity_hash IS NOT NULL[\s\S]*?attempt_identity_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?generation_size IS NOT NULL[\s\S]*?generation_size ~ '\^\[1-9\]\[0-9\]\*x\[1-9\]\[0-9\]\*\$'[\s\S]*?final_input_bound_at IS NULL[\s\S]*?input_hash = attempt_identity_hash[\s\S]*?status IN \('GENERATING', 'FAILED'\)[\s\S]*?final_input_bound_at IS NOT NULL[\s\S]*?status NOT IN \('ACCEPTED', 'REJECTED'\) OR final_input_bound_at IS NOT NULL/is);
  assert.match(sql, /status <> 'ACCEPTED' OR \([\s\S]*?attempt_identity_hash IS NOT NULL AND attempt_identity_hash ~ '\^\[a-f0-9\]\{64\}\$'[\s\S]*?generation_size IS NOT NULL AND generation_size ~ '\^\[1-9\]\[0-9\]\*x\[1-9\]\[0-9\]\*\$'/is);
  assert.match(sql, /ON ai_generation_assets\(account_id, plan_id, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED'/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_active_scope_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash\)[\s\S]*?WHERE status = 'GENERATING' AND attempt_identity_hash IS NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_attempt_identity_attempt_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, attempt_identity_hash, attempt_no\)[\s\S]*?WHERE attempt_identity_hash IS NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_active_attempt_identity_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, attempt_identity_hash\)[\s\S]*?WHERE status = 'GENERATING' AND attempt_identity_hash IS NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_bound_input_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED' OR \(status = 'GENERATING' AND final_input_bound_at IS NOT NULL\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_asset_cleanup_obligations[\s\S]*?account_id TEXT NOT NULL[\s\S]*?job_id TEXT NOT NULL[\s\S]*?item_id TEXT NOT NULL[\s\S]*?plan_id TEXT NOT NULL[\s\S]*?visual_group_key TEXT NOT NULL[\s\S]*?slot_key TEXT NOT NULL[\s\S]*?attempt_identity_hash TEXT NOT NULL[\s\S]*?input_hash TEXT NOT NULL[\s\S]*?attempt_no INTEGER NOT NULL[\s\S]*?object_key TEXT NOT NULL[\s\S]*?content_hash TEXT NOT NULL[\s\S]*?reason TEXT NOT NULL[\s\S]*?original_error_code TEXT NOT NULL[\s\S]*?status TEXT NOT NULL DEFAULT 'PENDING'[\s\S]*?attempt_count INTEGER NOT NULL DEFAULT 0[\s\S]*?claim_token TEXT[\s\S]*?claim_owner TEXT[\s\S]*?claim_expires_at TIMESTAMPTZ[\s\S]*?created_at TIMESTAMPTZ NOT NULL[\s\S]*?updated_at TIMESTAMPTZ NOT NULL[\s\S]*?next_retry_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /auto_listing_asset_cleanup_claim_pair_check[\s\S]*?status = 'PROCESSING'[\s\S]*?claim_token[\s\S]*?claim_owner[\s\S]*?claim_expires_at/is);
  assert.match(sql, /UPDATE ai_generation_assets[\s\S]*?status = 'FAILED'[\s\S]*?error_code = 'MIGRATION_029_LEGACY_GENERATING_TERMINATED'[\s\S]*?error_retryable = TRUE[\s\S]*?lease_token = NULL[\s\S]*?lease_expires_at = NULL[\s\S]*?WHERE status = 'GENERATING'[\s\S]*?attempt_identity_hash IS NULL[\s\S]*?generation_size IS NULL/is);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_content_plans_account_job_item_id_key[\s\S]*?ON ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.match(sql, /auto_listing_asset_cleanup_obligations[\s\S]*?FOREIGN KEY \(account_id, job_id, item_id, plan_id\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.match(sql, /UNIQUE \(account_id, object_key\)/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+input_hash\s+DROP\s+NOT\s+NULL/i);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});

test("attempt-isolation migration upgrades deployed 029 schemas without rewriting legacy evidence", async () => {
  const sql = await readFile(attemptIsolationMigrationUrl, "utf8");
  const immutableSql = await readFile(immutableContentMigrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE ai_generation_assets[\s\S]*?ADD COLUMN IF NOT EXISTS object_key_version TEXT/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_generation_object_key_v2_complete\([\s\S]*?account_id[\s\S]*?job_id[\s\S]*?item_id[\s\S]*?plan_id[\s\S]*?visual_group_key[\s\S]*?slot_key[\s\S]*?attempt_identity_hash[\s\S]*?attempt_no[\s\S]*?input_hash[\s\S]*?content_hash[\s\S]*?object_key[\s\S]*?RETURNS BOOLEAN/is);
  assert.match(sql, /auto_listing_generation_object_key_v2_complete\(account_id,job_id,item_id,plan_id,visual_group_key,slot_key,attempt_identity_hash,attempt_no,input_hash,content_hash,object_key\)/i);
  assert.match(immutableSql, /CREATE TRIGGER ai_generation_assets_terminal_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON ai_generation_assets/is);
  assert.doesNotMatch(sql, /UPDATE\s+ai_generation_assets\b/i);
  assert.match(sql, /ai_generation_assets_new_object_key_v2_check[\s\S]*?status <> 'ACCEPTED'[\s\S]*?object_key_version IS NOT NULL[\s\S]*?object_key_version = 'ATTEMPT_V2'[\s\S]*?auto_listing_generation_object_key_v2_complete\(account_id,job_id,item_id,plan_id,visual_group_key,slot_key,attempt_identity_hash,attempt_no,input_hash,content_hash,object_key\) IS TRUE/is);
  assert.match(sql, /auto_listing_asset_cleanup_obligations[\s\S]*?object_key_version TEXT[\s\S]*?adopted_at TIMESTAMPTZ[\s\S]*?adopted_generation_asset_id TEXT[\s\S]*?adopted_generation_asset_status TEXT/is);
  assert.match(sql, /UPDATE auto_listing_asset_cleanup_obligations[\s\S]*?object_key_version = 'LEGACY_V1'[\s\S]*?object_key_version IS NULL/is);
  assert.match(sql, /auto_listing_asset_cleanup_new_object_key_v2_check[\s\S]*?object_key_version = 'ATTEMPT_V2'[\s\S]*?auto_listing_generation_object_key_v2_complete/is);
  assert.match(sql, /BEFORE INSERT ON auto_listing_asset_cleanup_obligations[\s\S]*?auto_listing_asset_cleanup_new_v2_only/i);
  assert.match(sql, /status IN \('PENDING', 'PROCESSING', 'COMPLETED', 'ADOPTED'\)/i);
  assert.match(sql, /status = 'ADOPTED'[\s\S]*?adopted_at IS NOT NULL[\s\S]*?adopted_generation_asset_id[\s\S]*?adopted_generation_asset_status[\s\S]*?claim_token IS NULL[\s\S]*?claim_owner IS NULL[\s\S]*?claim_expires_at IS NULL/is);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});
