import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/087_auto_listing_rich_deterministic_fallback.sql", import.meta.url);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 087 changes no existing rich-content data", async () => {
  const value = await sql();
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_rich_content_results\b/iu);
});

test("migration 087 allows only an explicit deterministic fallback or verified gateway evidence", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_model_evidence_valid/iu);
  assert.match(value, /gateway_request_id = 'auto-listing-rich-fallback-' \|\| input_hash/iu);
  assert.match(value, /gatewayReportedTextModelPresent/iu);
  assert.match(value, /auto_listing_ai_model_identity_compatible/iu);
  for (const constraint of [
    "ai_rich_content_results_accepted_evidence_check",
    "ai_rich_content_results_accepted_closed_evidence_check",
  ]) {
    assert.match(value, new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`, "iu"));
    assert.match(value, new RegExp(`ADD CONSTRAINT ${constraint}`, "iu"));
  }
});
