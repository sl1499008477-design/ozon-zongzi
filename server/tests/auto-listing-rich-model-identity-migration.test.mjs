import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/080_auto_listing_rich_model_identity.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 080 preserves rich-content rows while replacing only model identity boundaries", async () => {
  const value = await sql();
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_rich_content_results\b/i);
  assert.match(value, /ALTER FUNCTION auto_listing_rich_asset_checker_evidence_valid[\s\S]*?RENAME TO auto_listing_rich_asset_checker_evidence_valid_v079/i);
  assert.match(value, /CREATE FUNCTION auto_listing_rich_asset_checker_evidence_valid\b/i);
  assert.match(value, /auto_listing_rich_asset_checker_evidence_valid_v079\(/i);
});

test("migration 080 accepts exact or valid date-snapshot model identities only", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_ai_model_identity_compatible\b/i);
  assert.match(value, /reported_model = requested_model/i);
  assert.match(value, /requested_model ~ '\-\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$'/i);
  assert.match(value, /regexp_match\(reported_model, '\^\(\.\*\)-\(\[0-9\]\{4\}\)-\(\[0-9\]\{2\}\)-\(\[0-9\]\{2\}\)\$'/i);
  assert.match(value, /make_date\(/i);
  assert.match(value, /auto_listing_ai_model_identity_compatible\(checker_model, reported_model\)/i);
});

test("migration 080 replaces both accepted rich-content constraints with the same compatibility rule", async () => {
  const value = await sql();
  for (const constraint of [
    "ai_rich_content_results_accepted_evidence_check",
    "ai_rich_content_results_accepted_closed_evidence_check",
  ]) {
    assert.match(value, new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`, "i"));
    assert.match(value, new RegExp(`ADD CONSTRAINT ${constraint}`, "i"));
  }
  assert.equal(
    (value.match(/auto_listing_ai_model_identity_compatible\(\s*model_name,\s*model_evidence->>'gatewayReportedTextModel'\s*\)/gi) ?? []).length,
    2,
  );
  assert.match(value, /NOT VALID/i);
});
