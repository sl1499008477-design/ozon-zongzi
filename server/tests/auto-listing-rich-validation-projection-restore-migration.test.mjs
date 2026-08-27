import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/094_auto_listing_rich_validation_projection_restore.sql",
  import.meta.url,
);
const migrationsUrl = new URL("../db/migrations/", import.meta.url);

test("094 restores the accepted rich-content validation projection without rewriting evidence", async () => {
  const sql = await readFile(migrationUrl, "utf8").catch(() => "");

  assert.match(sql, /DROP CONSTRAINT IF EXISTS ai_rich_content_results_accepted_closed_evidence_check/iu);
  assert.match(sql, /ADD CONSTRAINT ai_rich_content_results_accepted_closed_evidence_check/iu);
  assert.match(sql, /auto_listing_rich_model_evidence_valid\(/iu);
  assert.match(sql, /auto_listing_rich_asset_evidence_valid\(\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)\s*\)/iu);
  assert.match(sql, /auto_listing_rich_asset_evidence_matches\(\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)/iu);
  assert.match(sql, /auto_listing_rich_content_valid\(\s*rich_content,\s*source_fact_evidence,\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)/iu);
  assert.match(sql, /auto_listing_rich_checker_evidence_valid\(\s*checker_result,\s*rich_content,\s*source_fact_evidence,\s*auto_listing_rich_asset_evidence_for_validation\(asset_evidence\)/iu);
  assert.match(sql, /NOT VALID/iu);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN))\s+ai_rich_content_results/iu);

  const migrations = (await readdir(migrationsUrl))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
    .sort();
  assert.ok(migrations.indexOf("094_auto_listing_rich_validation_projection_restore.sql")
    > migrations.indexOf("093_category_strategy_source_product_revision.sql"));
});
