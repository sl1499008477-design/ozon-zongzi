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

test("migration 031 owns immutable closed JSON validators", async () => {
  const value = await sql();
  for (const helper of [
    "auto_listing_rich_fact_evidence_valid",
    "auto_listing_rich_source_asset_evidence_valid",
    "auto_listing_rich_asset_checker_evidence_valid",
    "auto_listing_rich_legacy_object_key_complete",
    "auto_listing_rich_asset_evidence_valid",
    "auto_listing_rich_asset_evidence_matches",
    "auto_listing_rich_content_valid",
    "auto_listing_rich_checker_evidence_valid",
  ]) assert.match(value, new RegExp(`CREATE OR REPLACE FUNCTION ${helper}\\b`, "i"));
});

test("new rich-content hashes and request identity are exact and SQL-null-safe", async () => {
  const value = await sql();
  for (const hashColumn of ["input_hash", "source_hash", "asset_hash", "output_hash", "plan_hash", "fact_registry_hash", "prompt_hash"]) {
    assert.match(value, new RegExp(`${hashColumn} IS NOT NULL[\\s\\S]*?${hashColumn} ~ '\\^\\[a-f0-9\\]\\{64\\}\\$'`, "i"));
  }
  assert.match(value, /request_evidence->>'requestKey'\s*=\s*'auto-listing-rich-'\s*\|\|\s*input_hash/is);
  assert.match(value, /auto_listing_rich_fact_evidence_valid\(source_fact_evidence\) IS TRUE/is);
  assert.match(value, /auto_listing_rich_asset_evidence_valid\(asset_evidence\) IS TRUE/is);
});

test("fact and complete Task4 asset evidence reject open, malformed, duplicate, or forged records", async () => {
  const value = await sql();
  assert.match(value, /NOT \(entry \?& ARRAY\['factId','field','kind','value','numericValue','unit','sourcePath'\]\)/is);
  assert.match(value, /entry - 'factId' - 'field' - 'kind' - 'value' - 'numericValue' - 'unit' - 'sourcePath'\) <> '\{\}'::JSONB/is);
  assert.match(value, /jsonb_typeof\(entry->'factId'\)[\s\S]*?'string'[\s\S]*?jsonb_typeof\(entry->'numericValue'\)[\s\S]*?jsonb_typeof\(entry->'unit'\)/is);
  assert.match(value, /COUNT\(DISTINCT\s+fact_row->>'factId'\)[\s\S]*?jsonb_array_length\(value\)/is);
  const assetKeys = [
    "assetId", "status", "accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "role",
    "attemptIdentityHash", "attemptNo", "inputHash", "generationSize", "contentHash", "objectKeyVersion", "objectKey",
    "contentType", "width", "height", "size", "gatewayRequestId", "checkerRequestId", "modelEvidence",
    "profileId", "profileVersion", "modelName", "planHash", "sourceHash", "strategyHash", "configHash",
    "visualGroupsHash", "promptTemplateVersion", "promptHash", "checkerEvidence", "sourceAssetEvidence", "regeneration",
  ];
  const assetValidator = value.slice(
    value.indexOf("CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_valid"),
    value.indexOf("CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_matches"),
  );
  for (const key of assetKeys) {
    assert.match(assetValidator, new RegExp(`'${key}'`, "i"), `missing closed asset key ${key}`);
  }
  assert.match(assetValidator, /NOT \(entry \?& ARRAY\[[\s\S]*?'assetId'[\s\S]*?'regeneration'[\s\S]*?\]\)/is);
  assert.match(assetValidator, /entry - 'assetId'[\s\S]*?- 'sourceAssetEvidence' - 'regeneration'\) <> '\{\}'::JSONB/is);
  assert.match(assetValidator, /COUNT\(DISTINCT\s+asset_row->>'assetId'\)[\s\S]*?COUNT\(DISTINCT\s+\(asset_row->>'visualGroupKey',\s*asset_row->>'slotKey'\)\)[\s\S]*?COUNT\(\*\)\s+FILTER\s*\([\s\S]*?asset_row->>'role'\s*=\s*'MAIN'[\s\S]*?main_count\s*=\s*1/is);
  assert.match(assetValidator, /objectKeyVersion'[\s\S]*?NOT IN \('string','null'\)[\s\S]*?ATTEMPT_V2[\s\S]*?auto_listing_generation_object_key_v2_complete[\s\S]*?jsonb_typeof\(entry->'objectKeyVersion'\) = 'null'[\s\S]*?auto_listing_rich_legacy_object_key_complete/is);
  assert.doesNotMatch(assetValidator, /entry->>'objectKeyVersion'\s*=\s*'LEGACY_V1'/is);
  assert.match(value, /auto_listing_rich_asset_evidence_matches\([\s\S]*?source_fact_evidence[\s\S]*?expected_account_id[\s\S]*?expected_checker_model/is);
  assert.match(value, /auto_listing_rich_asset_evidence_matches\(\s*asset_evidence,\s*source_fact_evidence,\s*account_id,\s*job_id,\s*item_id,\s*plan_id/is);
});

test("accepted rich content and checker evidence are closed and reference only frozen fact and asset ids", async () => {
  const value = await sql();
  assert.match(value, /auto_listing_rich_content_valid\(rich_content,\s*source_fact_evidence,\s*asset_evidence\) IS TRUE/is);
  assert.match(value, /auto_listing_rich_checker_evidence_valid\(checker_result,\s*rich_content,\s*source_fact_evidence,\s*asset_evidence\) IS TRUE/is);
  assert.match(value, /rich_content[\s\S]*?AUTO_LISTING_RICH_CONTENT_V1[\s\S]*?language[\s\S]*?ru[\s\S]*?HERO_IMAGE[\s\S]*?HEADING[\s\S]*?TEXT[\s\S]*?IMAGE_TEXT/is);
  assert.match(value, /checker_result[\s\S]*?accepted[\s\S]*?validator[\s\S]*?sourceFactIds[\s\S]*?assetIds[\s\S]*?jsonb_array_elements/is);
  assert.match(value, /jsonb_typeof\([^)]*->'accepted'[^)]*\)\s*=\s*'boolean'[\s\S]*?=\s*'true'::JSONB\) IS TRUE/is);
});

test("attempt and active or accepted uniqueness use the complete tenant scope", async () => {
  const value = await sql();
  assert.match(value, /UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_full_attempt_key[\s\S]*?\(account_id, job_id, item_id, plan_id, input_hash, attempt_no\)/is);
  assert.match(value, /UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_active_input_key[\s\S]*?\(account_id, job_id, item_id, plan_id, input_hash\)[\s\S]*?WHERE status = 'GENERATING'/is);
  assert.match(value, /UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_full_accepted_input_key[\s\S]*?\(account_id, job_id, item_id, plan_id, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED'/is);
});
