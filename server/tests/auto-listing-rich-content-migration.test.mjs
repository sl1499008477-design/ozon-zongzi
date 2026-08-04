import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL("../db/migrations/031_auto_listing_rich_content_attempt_evidence.sql", import.meta.url);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 031 is additive and never rewrites historical terminal rich content", async () => {
  const value = await sql();
  assert.match(value, /ALTER TABLE ai_rich_content_results/i);
  assert.doesNotMatch(value, /(?:UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN))\s+ai_rich_content_results/i);
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort();
  assert.ok(migrations.indexOf("031_auto_listing_rich_content_attempt_evidence.sql")
    > migrations.indexOf("030_auto_listing_generated_asset_attempt_isolation.sql"));
});

test("migration 031 adds complete request, model, source, asset, prompt, plan, and lease evidence", async () => {
  const value = await sql();
  for (const column of [
    "plan_hash TEXT", "fact_registry_hash TEXT", "prompt_hash TEXT",
    "gateway_request_id TEXT", "request_evidence JSONB", "model_evidence JSONB",
    "source_fact_evidence JSONB", "asset_evidence JSONB",
    "lease_owner TEXT", "lease_token TEXT", "lease_expires_at TIMESTAMPTZ",
  ]) assert.match(value, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
});

test("new generating and accepted rows have explicit non-null evidence and closed lease checks", async () => {
  const value = await sql();
  assert.match(value, /status <> 'GENERATING'[\s\S]*?plan_hash IS NOT NULL[\s\S]*?fact_registry_hash IS NOT NULL[\s\S]*?prompt_hash IS NOT NULL[\s\S]*?request_evidence IS NOT NULL[\s\S]*?source_fact_evidence IS NOT NULL[\s\S]*?asset_evidence IS NOT NULL[\s\S]*?lease_owner IS NOT NULL[\s\S]*?lease_token IS NOT NULL[\s\S]*?lease_expires_at IS NOT NULL/is);
  assert.match(value, /status <> 'ACCEPTED'[\s\S]*?plan_hash IS NOT NULL[\s\S]*?prompt_hash IS NOT NULL[\s\S]*?gateway_request_id IS NOT NULL[\s\S]*?model_evidence IS NOT NULL[\s\S]*?checker_result IS NOT NULL[\s\S]*?accepted_at IS NOT NULL/is);
  assert.match(value, /status = 'GENERATING'[\s\S]*?OR[\s\S]*?lease_owner IS NULL[\s\S]*?lease_token IS NULL[\s\S]*?lease_expires_at IS NULL/is);
  assert.match(value, /jsonb_typeof\(asset_evidence\) = 'array'[\s\S]*?jsonb_array_length\(asset_evidence\) BETWEEN 6 AND 20/is);
  assert.match(value, /jsonb_typeof\(source_fact_evidence\) = 'array'[\s\S]*?jsonb_array_length\(source_fact_evidence\) BETWEEN 1 AND 256/is);
  assert.match(value, /request_evidence \? 'requestKey'[\s\S]*?request_evidence \? 'schemaVersion'[\s\S]*?request_evidence->>'schemaVersion' = 'AUTO_LISTING_RICH_CONTENT_V1'/is);
  assert.match(value, /model_evidence \? 'requestedTextModel'[\s\S]*?model_evidence \? 'gatewayReportedTextModel'[\s\S]*?model_evidence \? 'gatewayReportedTextModelPresent'[\s\S]*?model_evidence->>'requestedTextModel' = model_name[\s\S]*?model_evidence->>'gatewayReportedTextModel' = model_name[\s\S]*?model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB/is);
  assert.match(value, /checker_result \? 'accepted'[\s\S]*?\(checker_result->'accepted' = 'true'::JSONB\) IS TRUE/is);
});

test("attempt and active or accepted uniqueness use the complete tenant scope", async () => {
  const value = await sql();
  assert.match(value, /UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_full_attempt_key[\s\S]*?\(account_id, job_id, item_id, plan_id, input_hash, attempt_no\)/is);
  assert.match(value, /UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_active_input_key[\s\S]*?\(account_id, job_id, item_id, plan_id, input_hash\)[\s\S]*?WHERE status = 'GENERATING'/is);
  assert.match(value, /UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_full_accepted_input_key[\s\S]*?\(account_id, job_id, item_id, plan_id, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED'/is);
});
