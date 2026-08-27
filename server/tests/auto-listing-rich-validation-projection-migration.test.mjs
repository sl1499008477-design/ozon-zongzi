import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/082_auto_listing_rich_validation_projection.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 082 projects only exact full-source or first-anchor checker evidence", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_for_validation\b/i);
  assert.match(value, /jsonb_array_length\(checker_sources\) = jsonb_array_length\(full_sources\)[\s\S]*?checker_sources <> full_sources/i);
  assert.match(value, /jsonb_array_length\(checker_sources\) = 1[\s\S]*?checker_sources <> jsonb_build_array\(full_sources->0\)/i);
  assert.match(value, /RETURN NULL/i);
  assert.match(value, /jsonb_set\([\s\S]*?\{sourceAssetEvidence\}[\s\S]*?checker_sources/i);
  assert.match(value, /auto_listing_ai_model_identity_compatible\(/i);
  assert.doesNotMatch(value, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/i);
});

test("migration 082 makes generating and accepted rich constraints validate the same projection", async () => {
  const value = await sql();
  for (const constraint of [
    "ai_rich_content_results_generating_closed_evidence_check",
    "ai_rich_content_results_accepted_closed_evidence_check",
  ]) {
    assert.match(value, new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`, "i"));
    assert.match(value, new RegExp(`ADD CONSTRAINT ${constraint}`, "i"));
  }
  assert.match(value, /auto_listing_rich_asset_evidence_valid\(\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)\s*\)/i);
  assert.match(value, /auto_listing_rich_asset_evidence_matches\(\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)/i);
  assert.match(value, /auto_listing_rich_content_valid\(\s*rich_content,\s*source_fact_evidence,\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)\s*\)/i);
  assert.match(value, /NOT VALID/i);
});
