import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/026_auto_listing_foundation.sql", import.meta.url);
const recoveryMigrationUrl = new URL("../db/migrations/026_auto_listing_recovery_point.sql", import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

async function recoveryMigrationSql() {
  return readFile(recoveryMigrationUrl, "utf8");
}

function tableBlock(sql, table) {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`,
    "i",
  ));
  assert.ok(match, `expected CREATE TABLE block for ${table}`);
  return match[1];
}

function triggerTargetTables(sql) {
  return [...sql.matchAll(
    /CREATE\s+TRIGGER\s+\w+\s+BEFORE[\s\S]*?\bON\s+(\w+)\s+FOR\s+EACH\s+ROW/gi,
  )].map((match) => match[1]);
}

function functionBlock(sql, name) {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$;`,
    "i",
  ));
  assert.ok(match, `expected trigger function ${name}`);
  return match[0];
}

test("auto-listing foundation tables keep every persisted workflow record account-scoped", async () => {
  const sql = await migrationSql();

  for (const table of [
    "auto_listing_jobs",
    "auto_listing_source_snapshots",
    "auto_listing_job_items",
    "auto_listing_events",
    "ai_content_strategy_versions",
    "ai_content_strategy_rules",
  ]) {
    assert.match(tableBlock(sql, table), /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
  }

  const jobs = tableBlock(sql, "auto_listing_jobs");
  assert.match(jobs, /source_type TEXT NOT NULL CHECK \(source_type IN \('COLLECT_BOX', 'EXCEL_SKU'\)\)/i);
  assert.match(jobs, /config_snapshot JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(jobs, /config_hash TEXT NOT NULL/i);
  assert.match(jobs, /UNIQUE \(account_id, idempotency_key\)/i);
});

test("source snapshots retain immutable, complete source evidence without a writable path", async () => {
  const sql = await migrationSql();
  const snapshots = tableBlock(sql, "auto_listing_source_snapshots");

  assert.match(snapshots, /source_type TEXT NOT NULL CHECK \(source_type IN \('COLLECT_BOX', 'EXCEL_SKU'\)\)/i);
  assert.match(snapshots, /source_record_id TEXT NOT NULL/i);
  assert.match(snapshots, /source_version TEXT NOT NULL/i);
  assert.match(snapshots, /snapshot JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(snapshots, /snapshot_hash TEXT NOT NULL/i);
  assert.match(snapshots, /raw_response_ref TEXT/i);
  assert.ok(!triggerTargetTables(sql).includes("auto_listing_source_snapshots"));
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE\s+FROM)\s+auto_listing_source_snapshots\b/i);
});

test("job items freeze both target store and warehouse references", async () => {
  const sql = await migrationSql();
  const items = tableBlock(sql, "auto_listing_job_items");
  const normalized = items.replace(/\s+/g, " ");

  assert.match(items, /job_id TEXT NOT NULL REFERENCES auto_listing_jobs\(id\) ON DELETE CASCADE/i);
  assert.match(items, /snapshot_id TEXT NOT NULL REFERENCES auto_listing_source_snapshots\(id\) ON DELETE RESTRICT/i);
  assert.match(items, /target_store_id TEXT NOT NULL REFERENCES stores\(id\) ON DELETE RESTRICT/i);
  assert.match(items, /target_warehouse_id TEXT NOT NULL REFERENCES warehouses\(id\) ON DELETE RESTRICT/i);
  assert.match(
    normalized,
    /CHECK \(status IN \('CREATED', 'SOURCE_READY', 'PLANNING', 'GENERATING', 'READY_FOR_REVIEW', 'UPLOAD_QUEUED', 'UPLOADING', 'SUCCEEDED', 'RETRYABLE_ERROR', 'BLOCKED', 'CANCELLED'\)\)/,
  );
  assert.match(items, /status_version INTEGER NOT NULL DEFAULT 1 CHECK \(status_version > 0\)/i);
  assert.match(items, /visual_group_count INTEGER NOT NULL DEFAULT 0 CHECK \(visual_group_count >= 0\)/i);
  assert.match(items, /failure_code TEXT/i);
  assert.match(items, /failure_detail_safe TEXT/i);
});

test("published strategy records are immutable and event records are append-only", async () => {
  const sql = await migrationSql();
  const versions = tableBlock(sql, "ai_content_strategy_versions");
  const rules = tableBlock(sql, "ai_content_strategy_rules");
  const events = tableBlock(sql, "auto_listing_events");

  assert.match(versions, /status TEXT NOT NULL CHECK \(status IN \('DRAFT', 'PUBLISHED', 'RETIRED'\)\)/i);
  assert.match(rules, /rule_kind TEXT NOT NULL CHECK \(rule_kind IN \('EXACT_CATEGORY', 'ANCESTOR_CATEGORY', 'PRODUCT_STYLE'\)\)/i);
  assert.match(rules, /rule_order INTEGER NOT NULL CHECK \(rule_order > 0\)/i);
  assert.match(rules, /UNIQUE \(strategy_version_id, rule_order\)/i);
  assert.match(events, /details JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  const versionProtection = functionBlock(sql, "protect_published_auto_listing_strategy");
  assert.match(
    versionProtection,
    /IF OLD\.status = 'PUBLISHED' THEN[\s\S]*?RAISE EXCEPTION[\s\S]*?END IF;\s*RETURN NEW;/i,
  );
  assert.equal((versionProtection.match(/RAISE EXCEPTION/gi) || []).length, 1);
  assert.doesNotMatch(versionProtection, /\bRETURN OLD\b/i);
  assert.match(
    sql,
    /CREATE TRIGGER ai_content_strategy_versions_published_immutable[\s\S]*?BEFORE UPDATE ON ai_content_strategy_versions[\s\S]*?EXECUTE FUNCTION protect_published_auto_listing_strategy\(\)/i,
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION auto_listing_reject_published_strategy_version_deletion\(\)[\s\S]*?IF OLD\.status = 'PUBLISHED' THEN[\s\S]*?RAISE EXCEPTION[\s\S]*?RETURN OLD;[\s\S]*?CREATE TRIGGER ai_content_strategy_versions_published_delete_immutable[\s\S]*?BEFORE DELETE ON ai_content_strategy_versions[\s\S]*?EXECUTE FUNCTION auto_listing_reject_published_strategy_version_deletion\(\)/i,
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION auto_listing_reject_published_strategy_rule_mutation\(\)[\s\S]*?FROM ai_content_strategy_versions[\s\S]*?status = 'PUBLISHED'[\s\S]*?RAISE EXCEPTION[\s\S]*?CREATE TRIGGER ai_content_strategy_rules_published_immutable[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON ai_content_strategy_rules[\s\S]*?EXECUTE FUNCTION auto_listing_reject_published_strategy_rule_mutation\(\)/i,
  );
  const ruleProtection = functionBlock(sql, "auto_listing_reject_published_strategy_rule_mutation");
  assert.match(ruleProtection, /TG_OP IN \('UPDATE', 'DELETE'\)[\s\S]*?OLD\.strategy_version_id/i);
  assert.match(ruleProtection, /TG_OP IN \('INSERT', 'UPDATE'\)[\s\S]*?NEW\.strategy_version_id/i);
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION auto_listing_reject_event_mutation\(\)[\s\S]*?RAISE EXCEPTION[\s\S]*?CREATE TRIGGER auto_listing_events_append_only[\s\S]*?BEFORE UPDATE OR DELETE ON auto_listing_events[\s\S]*?EXECUTE FUNCTION auto_listing_reject_event_mutation\(\)/i,
  );
});

test("auto-listing foundation migration remains additive and indexed", async () => {
  const sql = await migrationSql();

  for (const index of [
    "auto_listing_jobs_account_status_idx",
    "auto_listing_jobs_strategy_version_idx",
    "auto_listing_source_snapshots_account_source_idx",
    "auto_listing_job_items_job_status_idx",
    "auto_listing_job_items_account_store_status_idx",
    "auto_listing_events_job_created_idx",
    "auto_listing_events_item_created_idx",
    "ai_content_strategy_versions_account_status_idx",
    "ai_content_strategy_rules_version_order_idx",
  ]) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`, "i"));
  }

  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i);
});

test("recovery-point migration is additive, idempotent, and constrains only closed values", async () => {
  const sql = await recoveryMigrationSql();

  assert.match(sql, /ALTER TABLE auto_listing_job_items\s+ADD COLUMN IF NOT EXISTS recovery_point TEXT/i);
  assert.match(sql, /CHECK\s*\(recovery_point IS NULL OR recovery_point IN \('PLANNING', 'GENERATION', 'UPLOAD'\)\)/i);
  assert.match(sql, /IF NOT EXISTS[\s\S]*?pg_constraint[\s\S]*?auto_listing_job_items_recovery_point_check/i);
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE\s+FROM)\s+auto_listing_events\b/i);
});
