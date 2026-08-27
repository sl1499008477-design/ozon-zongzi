import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("migration 020 creates account-scoped Ozon enrichment cache and jobs", async () => {
  const sql = await readFile(
    new URL("../db/migrations/020_collector_ozon_enrichment.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE collector_ozon_enrichment_cache/);
  assert.match(sql, /CREATE TABLE collector_ozon_enrichment_jobs/);
  assert.match(sql, /PRIMARY KEY \(account_id, source, sku, contract_version\)/);
  assert.match(sql, /UNIQUE \(account_id, request_id, sku\)/);
  assert.match(sql, /FOREIGN KEY \(account_id\) REFERENCES accounts\(id\) ON DELETE CASCADE/);
  assert.match(sql, /FOREIGN KEY \(last_executor_session_id\) REFERENCES collector_sessions\(id\) ON DELETE SET NULL/);
  assert.match(sql, /CHECK \(status IN \('COMPLETE', 'ERROR'\)\)/);
  assert.match(sql, /CHECK \(status IN \('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'\)\)/);
  assert.match(sql, /CREATE INDEX collector_ozon_enrichment_cache_expires_at_idx/);
  assert.match(sql, /CREATE INDEX collector_ozon_enrichment_jobs_pending_idx/);
  assert.match(sql, /CREATE INDEX collector_ozon_enrichment_jobs_account_idx/);
});

test("migration 021 adds durable linked retry scheduling and capture evidence", async () => {
  const sql = await readFile(
    new URL("../db/migrations/021_async_collect_enrichment.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS collect_item_id TEXT/);
  assert.match(sql, /REFERENCES collect_items\(id\) ON DELETE SET NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_error_json JSONB/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS capture_context_json JSONB/);
  assert.match(sql, /ALTER TABLE collector_ozon_enrichment_cache[\s\S]*ADD COLUMN IF NOT EXISTS capture_context_json JSONB/);
  assert.match(sql, /DROP INDEX IF EXISTS collector_ozon_enrichment_jobs_pending_idx/);
  assert.match(sql, /ON collector_ozon_enrichment_jobs\(account_id, next_attempt_at, created_at, id\)/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE/);
});

test("migration 022 fences claims and deterministically supersedes legacy duplicate active linked jobs", async () => {
  const sql = await readFile(
    new URL("../db/migrations/022_ozon_enrichment_claim_fence.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS claim_fence TEXT/);
  assert.match(sql, /WHERE status = 'PROCESSING'/);
  assert.match(sql, /ROW_NUMBER\(\) OVER \([\s\S]*PARTITION BY account_id, collect_item_id, sku[\s\S]*ORDER BY created_at ASC, id ASC/);
  assert.match(sql, /UPDATE collector_ozon_enrichment_jobs AS duplicate/);
  assert.match(sql, /OZON_ENRICHMENT_DUPLICATE_SUPERSEDED/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS collector_ozon_enrichment_jobs_active_linked_key/);
  assert.match(sql, /ON collector_ozon_enrichment_jobs \(account_id, collect_item_id, sku\)/);
  assert.match(sql, /collect_item_id IS NOT NULL[\s\S]*status IN \('PENDING', 'PROCESSING'\)/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE/);
});

test("migration 023 adds an account-session Seller context watermark without destructive rewrites", async () => {
  const sql = await readFile(
    new URL("../db/migrations/023_collector_seller_context_watermark.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE collector_sessions/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS seller_context_json JSONB/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS seller_context_updated_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
});

test("migration 089 expires orphaned Ozon enrichment work without deleting audit history", async () => {
  const sql = await readFile(
    new URL("../db/migrations/089_expire_orphan_ozon_enrichment_jobs.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /UPDATE collector_ozon_enrichment_jobs/);
  assert.match(sql, /collect_item_id IS NULL/);
  assert.match(sql, /status IN \('PENDING', 'PROCESSING'\)/);
  assert.match(sql, /deadline_at <= NOW\(\)/);
  assert.match(sql, /OZON_ENRICHMENT_ORPHAN_EXPIRED/);
  assert.match(sql, /status = 'FAILED'/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
});

test("migration 090 terminates exhausted linked retries and preserves their collect items", async () => {
  const sql = await readFile(
    new URL("../db/migrations/090_exhaust_ozon_enrichment_retries.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /UPDATE collector_ozon_enrichment_jobs/);
  assert.match(sql, /collect_item_id IS NOT NULL/);
  assert.match(sql, /attempt_count >= 5/);
  assert.match(sql, /OZON_ENRICH_RETRY_EXHAUSTED/);
  assert.match(sql, /status = 'FAILED'/);
  assert.match(sql, /UPDATE collect_items/);
  assert.match(sql, /NEEDS_ATTENTION/);
  assert.match(sql, /deleted_at IS NULL/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
});

test("migration 091 terminates active enrichment work for soft-deleted collect items", async () => {
  const sql = await readFile(
    new URL("../db/migrations/091_close_deleted_collect_enrichment_jobs.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /UPDATE collector_ozon_enrichment_jobs/);
  assert.match(sql, /JOIN collect_items/);
  assert.match(sql, /deleted_at IS NOT NULL/);
  assert.match(sql, /status = 'DELETED'/);
  assert.match(sql, /OZON_ENRICHMENT_COLLECT_ITEM_DELETED/);
  assert.match(sql, /status = 'FAILED'/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
});
