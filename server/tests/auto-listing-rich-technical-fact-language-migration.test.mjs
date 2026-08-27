import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/085_auto_listing_rich_technical_fact_language.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 085 aligns watt units and source-proven technical tokens with the rich validator", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_unit_normalized\b/i);
  assert.match(value, /WHEN 'вт' THEN 'w'/i);
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_russian_text_valid\b/i);
  assert.match(value, /fact->>'kind' IN \('BRAND','MODEL'\) OR captures\[1\] ~ '\[0-9\]'/i);
  assert.match(value, /fact->>'factId' = fact_id #>> '\{\}'/i);
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/i);
});
