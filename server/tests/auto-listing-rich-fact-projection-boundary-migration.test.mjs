import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/084_auto_listing_rich_fact_projection_boundary.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 084 compares immutable fact identity instead of derived numeric metadata", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_matches\b/i);
  assert.match(value, /fact_value->>'factId'\s*=\s*checker_fact->>'factId'/i);
  for (const field of ["field", "kind", "value", "sourcePath"]) {
    assert.match(value, new RegExp(`fact_value->'${field}'\\s*=\\s*checker_fact->'${field}'`, "i"));
  }
  assert.doesNotMatch(value, /fact_value->'numericValue'\s*=\s*checker_fact->'numericValue'/i);
  assert.doesNotMatch(value, /auto_listing_rich_unit_normalized\(fact_value->>'unit'\)/i);
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/i);
});
