import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "096_auto_listing_validation_boundary.sql";
const migrationUrl = new URL(`../db/migrations/${migrationName}`, import.meta.url);
const migrationsUrl = new URL("../db/migrations/", import.meta.url);

test("096 keeps accepted image evidence structural and aligns fact-proven rich text", async () => {
  const sql = await readFile(migrationUrl, "utf8").catch(() => "");

  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_checker_evidence_valid\b/iu);
  assert.match(sql, /value->>'generatedHash'\s*<>\s*content_hash/iu);
  assert.match(sql, /value->>'requestId'\s*<>\s*checker_request_id/iu);
  assert.match(sql, /value->>'profileAccountId'\s*<>\s*profile_account_id/iu);
  assert.match(sql, /value->'sourceAssets'/iu);
  assert.match(sql, /auto_listing_rich_fact_evidence_valid\(value->'sourceFacts'\)/iu);
  assert.doesNotMatch(sql, /checker_result->>'quality'\s*<>\s*'PASS'/iu);
  assert.doesNotMatch(sql, /checker_result->'matchesProduct'\s*=\s*'true'/iu);
  assert.doesNotMatch(sql, /auto_listing_rich_asset_checker_evidence_valid_v079\(/iu);

  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_rich_policy_rules_valid\b/iu);
  assert.match(sql, /подарок\|бонус/iu);
  assert.doesNotMatch(sql, /в\[\[:space:\]\]\+комплекте/iu);
  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_rich_russian_text_valid\b/iu);
  assert.doesNotMatch(sql, /fact->>'kind'\s+IN\s+\('BRAND','MODEL'\)/iu);

  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\s+(?:FROM\s+)?ai_/iu);
  const migrations = (await readdir(migrationsUrl))
    .filter((file) => /^\d{3}_.+\.sql$/u.test(file))
    .sort();
  assert.ok(migrations.indexOf(migrationName)
    > migrations.indexOf("095_auto_listing_rich_text_forbidden_projection.sql"));
});
