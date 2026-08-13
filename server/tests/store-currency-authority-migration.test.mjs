import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = path.join(__dirname, "../db/migrations/073_store_currency_authority.sql");

test("073 records exact Ozon seller-info currency authority without rewriting legacy defaults", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /ADD COLUMN currency_source TEXT/i);
  assert.match(sql, /ADD COLUMN currency_synced_at TIMESTAMPTZ/i);
  assert.match(sql, /currency_source='OZON_SELLER_INFO'/i);
  assert.match(sql, /currency_code IN \('RUB','CNY'\)/i);
  assert.match(sql, /currency_source IS NULL AND currency_synced_at IS NULL/i);
  assert.doesNotMatch(sql, /UPDATE\s+stores\s+SET\s+currency_source/i);
});
