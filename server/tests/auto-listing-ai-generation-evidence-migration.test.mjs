import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/029_auto_listing_ai_generation_evidence.sql", import.meta.url);

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
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash\)[\s\S]*?WHERE status = 'GENERATING'/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_attempt_identity_attempt_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, attempt_identity_hash, attempt_no\)[\s\S]*?WHERE attempt_identity_hash IS NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_active_attempt_identity_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, attempt_identity_hash\)[\s\S]*?WHERE status = 'GENERATING'/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_bound_input_key[\s\S]*?ON ai_generation_assets\(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED' OR \(status = 'GENERATING' AND final_input_bound_at IS NOT NULL\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_asset_cleanup_obligations[\s\S]*?account_id TEXT NOT NULL[\s\S]*?job_id TEXT NOT NULL[\s\S]*?item_id TEXT NOT NULL[\s\S]*?plan_id TEXT NOT NULL[\s\S]*?visual_group_key TEXT NOT NULL[\s\S]*?slot_key TEXT NOT NULL[\s\S]*?attempt_identity_hash TEXT NOT NULL[\s\S]*?input_hash TEXT NOT NULL[\s\S]*?attempt_no INTEGER NOT NULL[\s\S]*?object_key TEXT NOT NULL[\s\S]*?content_hash TEXT NOT NULL[\s\S]*?reason TEXT NOT NULL[\s\S]*?original_error_code TEXT NOT NULL[\s\S]*?status TEXT NOT NULL DEFAULT 'PENDING'[\s\S]*?attempt_count INTEGER NOT NULL DEFAULT 0[\s\S]*?created_at TIMESTAMPTZ NOT NULL[\s\S]*?updated_at TIMESTAMPTZ NOT NULL[\s\S]*?next_retry_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_content_plans_account_job_item_id_key[\s\S]*?ON ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.match(sql, /auto_listing_asset_cleanup_obligations[\s\S]*?FOREIGN KEY \(account_id, job_id, item_id, plan_id\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id\)/i);
  assert.match(sql, /UNIQUE \(account_id, object_key\)/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+input_hash\s+DROP\s+NOT\s+NULL/i);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+ai_generation_assets)\b/i);
});
