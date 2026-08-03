import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL("../db/migrations/027_auto_listing_ai_content.sql", import.meta.url);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const secretValueColumnPattern = /\b(?:api_key|access_token|refresh_token|secret_value|credential(?:_value)?|cookie(?:_value)?|bearer(?:_value)?)\s+(?:TEXT|JSONB|BYTEA|VARCHAR(?:\s*\(\s*\d+\s*\))?|CHARACTER\s+VARYING(?:\s*\(\s*\d+\s*\))?)/i;

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\r\n]*/g, "");
}

async function migrationSql() {
  return stripSqlComments(await readFile(migrationUrl, "utf8"));
}

function tableBlock(sql, table) {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`,
    "i",
  ));
  assert.ok(match, `expected CREATE TABLE block for ${table}`);
  return match[1];
}

function functionBlock(sql, name) {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$;`,
    "i",
  ));
  assert.ok(match, `expected trigger function ${name}`);
  return match[0];
}

test("AI content persistence keeps profiles non-secret, versioned, and account-scoped", async () => {
  const sql = await migrationSql();
  const profiles = tableBlock(sql, "ai_gateway_profiles");

  assert.match(profiles, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
  assert.match(profiles, /api_key_env_name TEXT NOT NULL/i);
  assert.match(profiles, /text_protocol TEXT NOT NULL\s+CHECK \(text_protocol IN \('SUB2API_RESPONSES'\)\)/i);
  assert.match(profiles, /image_protocol TEXT NOT NULL\s+CHECK \(image_protocol IN \('SUB2API_RESPONSES_IMAGE_TOOL', 'SUB2API_OPENAI_IMAGES'\)\)/i);
  assert.match(profiles, /config_version INTEGER NOT NULL CHECK \(config_version > 0\)/i);
  assert.match(profiles, /capability_result JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(profiles, /capability_checked_at TIMESTAMPTZ/i);
  assert.match(profiles, /enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(profiles, /UNIQUE \(account_id, id, config_version\)/i);
  assert.doesNotMatch(profiles, secretValueColumnPattern);
  assert.match("api_key VARCHAR(255)", secretValueColumnPattern);
  assert.match("refresh_token CHARACTER VARYING ( 512 )", secretValueColumnPattern);

  const protection = functionBlock(sql, "auto_listing_protect_referenced_ai_gateway_profile");
  assert.match(protection, /FROM ai_content_plans[\s\S]*?profile_id = OLD\.id[\s\S]*?profile_version = OLD\.config_version/i);
  for (const field of ["base_url", "api_key_env_name", "text_protocol", "image_protocol", "text_model", "image_model", "config_version"]) {
    assert.match(protection, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, "i"));
  }
  assert.doesNotMatch(protection, /NEW\.(?:capability_result|capability_checked_at|enabled) IS DISTINCT FROM/i);
});

test("AI plans, generation attempts, and rich results cannot cross account job item or profile boundaries", async () => {
  const sql = await migrationSql();
  const plans = tableBlock(sql, "ai_content_plans");
  const assets = tableBlock(sql, "ai_generation_assets");
  const results = tableBlock(sql, "ai_rich_content_results");

  for (const block of [plans, assets, results]) {
    assert.match(block, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
    assert.match(block, /FOREIGN KEY \(account_id, job_id\)[\s\S]*?REFERENCES auto_listing_jobs\(account_id, id\) ON DELETE RESTRICT/i);
    assert.match(block, /FOREIGN KEY \(account_id, job_id, item_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id, job_id, id\) ON DELETE RESTRICT/i);
  }

  assert.match(plans, /FOREIGN KEY \(account_id, job_id, strategy_version_id\)[\s\S]*?REFERENCES auto_listing_jobs\(account_id, id, strategy_version_id\) ON DELETE RESTRICT/i);
  assert.match(plans, /FOREIGN KEY \(account_id, job_id, item_id, source_snapshot_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id, job_id, id, snapshot_id\) ON DELETE RESTRICT/i);
  assert.match(plans, /FOREIGN KEY \(account_id, profile_id, profile_version\)[\s\S]*?REFERENCES ai_gateway_profiles\(account_id, id, config_version\) ON DELETE RESTRICT/i);
  assert.match(plans, /FOREIGN KEY \(account_id, source_snapshot_id\)[\s\S]*?REFERENCES auto_listing_source_snapshots\(account_id, id\) ON DELETE RESTRICT/i);
  assert.match(plans, /FOREIGN KEY \(account_id, strategy_version_id\)[\s\S]*?REFERENCES ai_content_strategy_versions\(account_id, id\) ON DELETE RESTRICT/i);
  assert.match(plans, /strategy_hash TEXT NOT NULL/i);
  assert.match(plans, /config_hash TEXT NOT NULL/i);
  assert.match(plans, /source_hash TEXT NOT NULL/i);
  assert.match(plans, /input_hash TEXT NOT NULL/i);
  assert.match(plans, /plan JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(plans, /plan_hash TEXT NOT NULL/i);
  assert.match(plans, /UNIQUE \(account_id, item_id, input_hash\)/i);
  assert.match(plans, /UNIQUE \(account_id, job_id, item_id, id, profile_id, profile_version\)/i);

  assert.match(assets, /profile_id TEXT NOT NULL/i);
  assert.match(assets, /FOREIGN KEY \(account_id, job_id, item_id, plan_id, profile_id, profile_version\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id, profile_id, profile_version\) ON DELETE RESTRICT/i);
  assert.match(assets, /attempt_no INTEGER NOT NULL CHECK \(attempt_no > 0\)/i);
  assert.match(assets, /status TEXT NOT NULL CHECK \(status IN \('PENDING', 'GENERATING', 'ACCEPTED', 'REJECTED', 'FAILED'\)\)/i);
  assert.match(assets, /role TEXT NOT NULL CHECK \(role IN \('MAIN', 'SELLING_POINT', 'DETAIL', 'SCENE', 'SPECIFICATION', 'INFOGRAPHIC'\)\)/i);
  assert.doesNotMatch(assets, /'BENEFIT'/i);
  assert.match(assets, /UNIQUE \(item_id, slot_key, input_hash, attempt_no\)/i);
  assert.match(results, /profile_id TEXT NOT NULL/i);
  assert.match(results, /FOREIGN KEY \(account_id, job_id, item_id, plan_id, profile_id, profile_version\)[\s\S]*?REFERENCES ai_content_plans\(account_id, job_id, item_id, id, profile_id, profile_version\) ON DELETE RESTRICT/i);
  assert.match(results, /rich_content JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(results, /attempt_no INTEGER NOT NULL CHECK \(attempt_no > 0\)/i);
  assert.match(results, /UNIQUE \(item_id, input_hash, attempt_no\)/i);
});

test("terminal AI artifacts and plans are immutable while retries remain traceable", async () => {
  const sql = await migrationSql();

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_accepted_slot_input_key[\s\S]*?ON ai_generation_assets\(item_id, slot_key, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED'/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_accepted_item_input_key[\s\S]*?ON ai_rich_content_results\(item_id, input_hash\)[\s\S]*?WHERE status = 'ACCEPTED'/i);

  const planProtection = functionBlock(sql, "auto_listing_reject_ai_content_plan_mutation");
  assert.match(planProtection, /RAISE EXCEPTION 'AI content plans are immutable'/i);
  const assetProtection = functionBlock(sql, "auto_listing_reject_terminal_generation_asset_mutation");
  assert.match(assetProtection, /OLD\.status IN \('ACCEPTED', 'REJECTED', 'FAILED'\)/i);
  const resultProtection = functionBlock(sql, "auto_listing_reject_terminal_rich_content_result_mutation");
  assert.match(resultProtection, /OLD\.status IN \('ACCEPTED', 'REJECTED', 'FAILED'\)/i);

  assert.match(sql, /CREATE TRIGGER ai_content_plans_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON ai_content_plans[\s\S]*?EXECUTE FUNCTION auto_listing_reject_ai_content_plan_mutation\(\)/i);
  assert.match(sql, /CREATE TRIGGER ai_generation_assets_terminal_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON ai_generation_assets[\s\S]*?EXECUTE FUNCTION auto_listing_reject_terminal_generation_asset_mutation\(\)/i);
  assert.match(sql, /CREATE TRIGGER ai_rich_content_results_terminal_immutable[\s\S]*?BEFORE UPDATE OR DELETE ON ai_rich_content_results[\s\S]*?EXECUTE FUNCTION auto_listing_reject_terminal_rich_content_result_mutation\(\)/i);
});

test("accepted artifacts require complete storage and checker evidence", async () => {
  const sql = await migrationSql();
  const assets = tableBlock(sql, "ai_generation_assets");
  const results = tableBlock(sql, "ai_rich_content_results");

  assert.match(assets, /CHECK \(status <> 'ACCEPTED' OR \([\s\S]*?NULLIF\(BTRIM\(object_key\), ''\) IS NOT NULL[\s\S]*?NULLIF\(BTRIM\(content_hash\), ''\) IS NOT NULL[\s\S]*?NULLIF\(BTRIM\(content_type\), ''\) IS NOT NULL[\s\S]*?width > 0[\s\S]*?height > 0[\s\S]*?checker_result <> '\{\}'::JSONB[\s\S]*?accepted_at IS NOT NULL[\s\S]*?\)\)/i);
  assert.match(results, /CHECK \(status <> 'ACCEPTED' OR \([\s\S]*?rich_content <> '\{\}'::JSONB[\s\S]*?NULLIF\(BTRIM\(output_hash\), ''\) IS NOT NULL[\s\S]*?NULLIF\(BTRIM\(source_hash\), ''\) IS NOT NULL[\s\S]*?NULLIF\(BTRIM\(asset_hash\), ''\) IS NOT NULL[\s\S]*?checker_result <> '\{\}'::JSONB[\s\S]*?accepted_at IS NOT NULL[\s\S]*?\)\)/i);
});

test("AI outbox supports idempotent account-scoped pending and lease claiming", async () => {
  const sql = await migrationSql();
  const outbox = tableBlock(sql, "auto_listing_ai_outbox");

  assert.match(outbox, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
  assert.match(outbox, /FOREIGN KEY \(account_id, job_id\)[\s\S]*?REFERENCES auto_listing_jobs\(account_id, id\) ON DELETE RESTRICT/i);
  assert.match(outbox, /FOREIGN KEY \(account_id, job_id, item_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id, job_id, id\) ON DELETE RESTRICT/i);
  assert.match(outbox, /dedupe_key TEXT NOT NULL UNIQUE/i);
  assert.match(outbox, /payload JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(outbox, /available_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(outbox, /lease_owner TEXT/i);
  assert.match(outbox, /lease_expires_at TIMESTAMPTZ/i);
  assert.match(outbox, /CHECK \(\(state = 'LEASED'[\s\S]*?NULLIF\(BTRIM\(lease_owner\), ''\) IS NOT NULL[\s\S]*?lease_expires_at IS NOT NULL[\s\S]*?OR \(state <> 'LEASED'[\s\S]*?lease_owner IS NULL[\s\S]*?lease_expires_at IS NULL[\s\S]*?\)\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_ai_outbox_pending_available_idx[\s\S]*?ON auto_listing_ai_outbox\(available_at, created_at\)[\s\S]*?WHERE state = 'PENDING'/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_ai_outbox_lease_expiry_idx[\s\S]*?ON auto_listing_ai_outbox\(lease_expires_at\)[\s\S]*?WHERE state = 'LEASED'/i);
});

test("AI migration is additive, discovered after both foundation migrations, and has no secret values", async () => {
  const sql = await migrationSql();
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

  assert.ok(migrations.indexOf("027_auto_listing_ai_content.sql") > migrations.indexOf("026_auto_listing_foundation.sql"));
  assert.ok(migrations.indexOf("027_auto_listing_ai_content.sql") > migrations.indexOf("026_auto_listing_recovery_point.sql"));
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_jobs_account_id_strategy_key[\s\S]*?ON auto_listing_jobs\(account_id, id, strategy_version_id\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_account_job_id_snapshot_key[\s\S]*?ON auto_listing_job_items\(account_id, job_id, id, snapshot_id\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_account_job_id_id_key[\s\S]*?ON auto_listing_job_items\(account_id, job_id, id\)/i);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|ALTER\s+TABLE[\s\S]*?\bRENAME\b|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(sql, /(?:^|;)\s*UPDATE\s+\w+\s+SET\b/im);
  assert.doesNotMatch(sql, secretValueColumnPattern);
});
