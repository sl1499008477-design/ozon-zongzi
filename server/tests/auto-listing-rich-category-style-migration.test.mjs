import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/079_auto_listing_rich_category_style_evidence.sql",
  import.meta.url,
);
const sql = async () => readFile(migrationUrl, "utf8").catch(() => "");

test("migration 079 only replaces the checker evidence validator", async () => {
  const value = await sql();
  assert.match(value, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_checker_evidence_valid\b/i);
  assert.doesNotMatch(value, /\b(?:ALTER|UPDATE|DELETE|INSERT|TRUNCATE|DROP)\b/i);
});

test("migration 079 accepts only complete legacy or complete category-style checker evidence", async () => {
  const value = await sql();
  assert.match(value, /has_category_style := value \?& ARRAY\['categoryStyleGuidance','categoryStyleAssets'\]/i);
  assert.match(value, /categoryStyleGuidance[\s\S]*?categoryStyleAssets[\s\S]*?<> '\{\}'::JSONB/i);
  assert.match(value, /matchesCategoryStyle[\s\S]*?categoryStyle[\s\S]*?referenceEvidenceIds/i);
  assert.match(value, /jsonb_array_length\(style_assets\) NOT BETWEEN 1 AND 3/i);
  assert.match(value, /entry->>'contentType' NOT IN \('image\/png','image\/jpeg','image\/webp'\)/i);
  assert.match(value, /entry->>'contentHash'\) !~ '\^\[a-f0-9\]\{64\}\$'/i);
  assert.match(value, /\(entry->>'width'\)::NUMERIC < 256/i);
  assert.match(value, /\(entry->>'height'\)::NUMERIC < 256/i);
  assert.match(value, /COUNT\(DISTINCT style_entry->>'evidenceId'\)[\s\S]*?COUNT\(DISTINCT style_entry->>'sku'\)/i);
});

test("migration 079 binds the style verdict and ordered evidence ids before legacy validation", async () => {
  const value = await sql();
  assert.match(value, /style_evidence->'matches' <> checker_result->'matchesCategoryStyle'/i);
  assert.match(value, /style_evidence->'referenceEvidenceIds' <> \([\s\S]*?jsonb_agg\(style_entry->'evidenceId' ORDER BY ordinal\)/i);
  assert.match(value, /value := \(value - 'categoryStyleGuidance' - 'categoryStyleAssets'\)/i);
  assert.match(value, /checker_result - 'matchesCategoryStyle'/i);
  assert.match(value, /evidence - 'categoryStyle'/i);
});

test("migration 079 preserves bounded closed guidance text", async () => {
  const value = await sql();
  for (const field of ["overallStyle", "role", "composition", "background", "textDensity", "layout"]) {
    assert.match(value, new RegExp(`OCTET_LENGTH\\(style_guidance->>'${field}'\\) > 1000`, "i"));
  }
  assert.match(value, /jsonb_array_length\(style_guidance->'prohibitedPatterns'\) > 20/i);
  assert.match(value, /jsonb_array_elements\(style_guidance->'prohibitedPatterns'\)[\s\S]*?OCTET_LENGTH/i);
});
