import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/088_auto_listing_batch_order_multiplier.sql", import.meta.url);

test("088 backfills a one-based batch order and adds an exact positive multiplier", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_order INTEGER/i);
  assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY account_id,job_id ORDER BY created_at,id\)/i);
  assert.match(sql, /ALTER COLUMN source_order SET NOT NULL/i);
  assert.match(sql, /CHECK \(source_order > 0\)/i);
  assert.match(sql, /conrelid\s*=\s*'auto_listing_job_items'::regclass/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_batch_order_uq[\s\S]*?account_id,job_id,source_order/i);
  assert.match(sql, /price_multiplier_micros BIGINT NOT NULL DEFAULT 1000000/i);
  assert.match(sql, /CHECK \(price_multiplier_micros > 0\)/i);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});
