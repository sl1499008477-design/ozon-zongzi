import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../db/migrations/100_auto_listing_rich_phone_boundary.sql", import.meta.url);

test("database rich-text policy recognizes standalone Russian phones without matching digits inside model IDs", async () => {
  const sql = await readFile(migration, "utf8");

  assert.match(sql, /\(\^\|\[\^\[:alnum:\]\]\)\(\\\+\?7\|8\)[\s\S]*?\(\$\|\[\^\[:alnum:\]\]\)/u);
  assert.match(sql, /CREATE OR REPLACE FUNCTION auto_listing_rich_policy_rules_valid/u);
});
