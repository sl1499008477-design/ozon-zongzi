import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/086_auto_listing_rich_numeric_boundary.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 086 aligns embedded numeric bindings without weakening explicit fact evidence", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_text_matches_bindings\b/i);
  assert.match(value, /regexp_matches\(\s*candidate_binding->>'value'/i);
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_fact_numeric_projection_matches\b/i);
  assert.match(value, /auto_listing_rich_fact_derived_numeric/i);
  assert.match(value, /auto_listing_rich_fact_numeric_projection_matches\(fact_value, checker_fact\)/i);
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/i);
});
