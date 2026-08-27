import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const migrationPath = path.join(migrationsDir, "076_auto_listing_category_strategy_analysis_edits.sql");

test("076 adds append-only AI/manual result provenance without changing 075", async () => {
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(migrations.includes("076_auto_listing_category_strategy_analysis_edits.sql"), true);
  assert.equal(migrations.at(-1), "096_auto_listing_validation_boundary.sql");
  const sql = await readFile(migrationPath, "utf8");
  for (const token of [
    "source_kind", "edited_by", "edited_at", "base_analysis_attempt_id", "AI", "MANUAL",
  ]) assert.match(sql, new RegExp(token, "iu"));
  assert.match(sql, /WHERE\s+source_kind\s*=\s*'AI'/iu);
  assert.match(sql, /FOREIGN KEY\s*\(account_id,draft_id,taxonomy_scope,description_category_id,type_id,base_analysis_attempt_id\)/iu);
  assert.match(sql, /CHECK\s*\(edited_by=account_id\)/iu);
  assert.match(sql, /raw_response\s*=\s*JSONB_BUILD_OBJECT\s*\(\s*'sourceKind'\s*,\s*'MANUAL'\s*,\s*'baseAnalysisAttemptId'/iu);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/iu);
});
