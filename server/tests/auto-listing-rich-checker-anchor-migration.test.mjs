import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/081_auto_listing_rich_checker_anchor.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 081 delegates to the complete 079 validator with the same checker anchor rule as image replay", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_checker_evidence_valid\b/i);
  assert.match(value, /jsonb_array_length\(value->'sourceAssets'\) = jsonb_array_length\(source_asset_evidence\)/i);
  assert.match(value, /jsonb_build_array\(source_asset_evidence->0\)/i);
  assert.match(value, /auto_listing_rich_asset_checker_evidence_valid_v079\([\s\S]*?checker_source_asset_evidence/i);
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/i);
});
