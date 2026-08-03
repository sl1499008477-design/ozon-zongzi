import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/026_auto_listing_foundation.sql", import.meta.url);

test("auto-listing foundation migration preserves account-scoped, append-only workflow contracts", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const normalized = sql.replace(/\s+/g, " ");

  for (const table of [
    "auto_listing_jobs",
    "auto_listing_source_snapshots",
    "auto_listing_job_items",
    "auto_listing_events",
    "ai_content_strategy_versions",
    "ai_content_strategy_rules",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }

  assert.match(sql, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /target_store_id TEXT NOT NULL REFERENCES stores\(id\) ON DELETE RESTRICT/i);
  assert.match(sql, /target_warehouse_id TEXT REFERENCES warehouses\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /job_id TEXT NOT NULL REFERENCES auto_listing_jobs\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /snapshot_id TEXT NOT NULL REFERENCES auto_listing_source_snapshots\(id\) ON DELETE RESTRICT/i);

  assert.match(sql, /source_type TEXT[^;]+CHECK \(source_type IN \('COLLECT_BOX', 'EXCEL_SKU'\)\)/is);
  assert.match(sql, /snapshot_hash TEXT NOT NULL/i);
  assert.match(sql, /UNIQUE \(account_id, idempotency_key\)/i);
  assert.match(sql, /config_snapshot JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(sql, /snapshot JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(sql, /details JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);

  assert.match(
    normalized,
    /CHECK \(status IN \('CREATED', 'SOURCE_READY', 'PLANNING', 'GENERATING', 'READY_FOR_REVIEW', 'UPLOAD_QUEUED', 'UPLOADING', 'SUCCEEDED', 'RETRYABLE_ERROR', 'BLOCKED', 'CANCELLED'\)\)/,
  );
  assert.match(sql, /status_version INTEGER NOT NULL DEFAULT 1 CHECK \(status_version > 0\)/i);
  assert.match(sql, /visual_group_count INTEGER NOT NULL DEFAULT 0 CHECK \(visual_group_count >= 0\)/i);
  assert.match(sql, /failure_code TEXT/i);
  assert.match(sql, /failure_detail_safe TEXT/i);

  assert.match(sql, /rule_kind TEXT NOT NULL CHECK \(rule_kind IN \('EXACT_CATEGORY', 'ANCESTOR_CATEGORY', 'PRODUCT_STYLE'\)\)/i);
  assert.match(sql, /rule_order INTEGER NOT NULL CHECK \(rule_order > 0\)/i);
  assert.match(sql, /UNIQUE \(strategy_version_id, rule_order\)/i);
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('DRAFT', 'PUBLISHED', 'RETIRED'\)\)/i);

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
  assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER[\s\S]*auto_listing_source_snapshots/i);
  assert.doesNotMatch(sql, /UPDATE\s+auto_listing_source_snapshots/i);
});
