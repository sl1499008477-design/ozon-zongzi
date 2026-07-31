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
