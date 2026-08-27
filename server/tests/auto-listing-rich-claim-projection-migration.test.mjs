import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/083_auto_listing_rich_claim_projection.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 083 derives validation-only claims from the already bound frozen facts", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_for_validation\b/i);
  assert.match(value, /jsonb_array_elements\(normalized_entry->'checkerEvidence'->'sourceFactIds'\)\s+WITH ORDINALITY/i);
  assert.match(value, /jsonb_array_elements\(normalized_entry->'checkerEvidence'->'sourceFacts'\)/i);
  assert.match(value, /fact->>'factId' = bound_fact_id/i);
  for (const field of ["sourceFactId", "field", "value", "numericValue", "unit"]) {
    assert.match(value, new RegExp(`'${field}'`, "i"));
  }
  assert.match(value, /'text', source_fact->>'value'/i);
  assert.match(value, /\{checkerEvidence,checkerResult,evidence,claims\}/i);
  assert.match(value, /\{checkerEvidence,checkerResult,claimsVerified\}/i);
  assert.match(value, /RETURN NULL/i);
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/i);
});
