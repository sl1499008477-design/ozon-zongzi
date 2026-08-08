import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/033_auto_listing_ai_admin_integrity.sql", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

function functionBlock(sql, name) {
  const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$;`, "iu"));
  assert.ok(match, `expected function ${name}`);
  return match[0];
}

test("033 permits only the exact published-to-retired transition and keeps published strategy evidence immutable", async () => {
  const sql = await migrationSql();
  const fn = functionBlock(sql, "protect_published_auto_listing_strategy");

  assert.match(fn, /OLD\.status IN \('PUBLISHED', 'RETIRED'\)[\s\S]*?OR OLD\.published_at IS NOT NULL/iu);
  assert.match(fn, /OLD\.status = 'PUBLISHED'[\s\S]*?NEW\.status = 'RETIRED'/iu);
  for (const column of [
    "account_id", "id", "strategy_key", "version", "content", "content_hash",
    "published_at", "published_by", "created_by", "created_at",
  ]) {
    assert.match(fn, new RegExp(`NEW\\.${column} IS NOT DISTINCT FROM OLD\\.${column}`, "iu"));
  }
  assert.match(fn, /RAISE EXCEPTION 'published strategy versions are immutable' USING ERRCODE = '23514'/iu);
  assert.match(fn, /RETURN NEW/iu);
});

test("033 permanently protects rules and deletion after a strategy has ever been published", async () => {
  const sql = await migrationSql();
  const deletion = functionBlock(sql, "auto_listing_reject_published_strategy_version_deletion");
  const rules = functionBlock(sql, "auto_listing_reject_published_strategy_rule_mutation");

  assert.match(deletion, /OLD\.status IN \('PUBLISHED', 'RETIRED'\)[\s\S]*?OR OLD\.published_at IS NOT NULL[\s\S]*?ERRCODE = '23514'/iu);
  assert.match(rules, /account_id = OLD\.account_id[\s\S]*?id = OLD\.strategy_version_id[\s\S]*?status IN \('PUBLISHED', 'RETIRED'\)[\s\S]*?OR published_at IS NOT NULL/iu);
  assert.match(rules, /account_id = NEW\.account_id[\s\S]*?id = NEW\.strategy_version_id[\s\S]*?status IN \('PUBLISHED', 'RETIRED'\)[\s\S]*?OR published_at IS NOT NULL/iu);
  assert.match(rules, /ERRCODE = '23514'/iu);
  assert.match(sql, /FOREIGN KEY \(account_id, strategy_version_id\)[\s\S]*?REFERENCES ai_content_strategy_versions\(account_id, id\)[\s\S]*?ON DELETE CASCADE[\s\S]*?NOT VALID/iu);
  assert.match(sql, /cross-account AI content strategy rules require explicit repair[\s\S]*?ERRCODE = '23503'/iu);
  assert.match(sql, /VALIDATE CONSTRAINT ai_content_strategy_rules_account_version_fk/iu);
});

test("033 enforces one enabled profile per account and one published strategy per account and key", async () => {
  const sql = await migrationSql();

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_profiles_one_enabled_per_account_uq[\s\S]*?ON ai_gateway_profiles\(account_id\)[\s\S]*?WHERE enabled IS TRUE/iu);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ai_content_strategy_versions_one_published_per_key_uq[\s\S]*?ON ai_content_strategy_versions\(account_id, strategy_key\)[\s\S]*?WHERE status = 'PUBLISHED'/iu);
  assert.match(sql, /duplicate enabled AI gateway profiles[\s\S]*?ERRCODE = '23505'/iu);
  assert.match(sql, /duplicate published AI content strategies[\s\S]*?ERRCODE = '23505'/iu);
});

test("033 is additive and does not rewrite frozen jobs, plans, profiles, strategies, rules, or audit history", async () => {
  const sql = await migrationSql();

  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/iu);
  assert.doesNotMatch(sql, /\bUPDATE\s+(?:auto_listing_jobs|ai_content_plans|ai_gateway_profiles|ai_content_strategy_versions|ai_content_strategy_rules|audit_events)\s+SET\b/iu);
  assert.doesNotMatch(sql, /\b(?:api_key|access_token|refresh_token|credential|secret|cookie|bearer)\s+(?:TEXT|JSONB|BYTEA)\b/iu);
});
