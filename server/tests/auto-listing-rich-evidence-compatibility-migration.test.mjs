import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const migrationName = "102_auto_listing_rich_evidence_compatibility.sql";
const migrationUrl = new URL(`../db/migrations/${migrationName}`, import.meta.url);

test("rich evidence compatibility migration is additive and ordered after the channel pool", async () => {
  const sql = await readFile(migrationUrl, "utf8").catch(() => "");
  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_matches\b/i);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN))\s+ai_rich_content_results/i);
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.ok(migrations.indexOf(migrationName) > migrations.indexOf("101_manual_category_confirmation_product_revision.sql"));
});

test("rich evidence compatibility keeps both complete containment directions", async () => {
  const sql = await readFile(migrationUrl, "utf8").catch(() => "");
  const checkerInRich = sql.match(/FROM jsonb_array_elements\(entry->'checkerEvidence'->'sourceFacts'\)[\s\S]*?FROM jsonb_array_elements\(source_fact_evidence\)/iu);
  const richInChecker = sql.match(/FROM jsonb_array_elements\(source_fact_evidence\)[\s\S]*?FROM jsonb_array_elements\(entry->'checkerEvidence'->'sourceFacts'\)/iu);
  assert.ok(checkerInRich, "checker facts must be allowed as a subset of rich facts");
  assert.ok(richInChecker, "rich facts must be allowed as a subset of historical checker facts");
  assert.match(sql, /IF NOT \([\s\S]*?OR[\s\S]*?\) THEN\s+RETURN FALSE/iu);
});

test("rich evidence compatibility reuses the authoritative numeric projection matcher", async () => {
  const sql = await readFile(migrationUrl, "utf8").catch(() => "");
  const matches = sql.match(/auto_listing_rich_fact_numeric_projection_matches\s*\(/giu) || [];
  assert.ok(matches.length >= 2, "both containment directions must accept equivalent derived numeric facts");
  assert.doesNotMatch(sql, /rich_fact->'numericValue'\s*=\s*checker_fact->'numericValue'/iu);
  assert.doesNotMatch(sql, /checker_fact->'numericValue'\s*=\s*rich_fact->'numericValue'/iu);
});
