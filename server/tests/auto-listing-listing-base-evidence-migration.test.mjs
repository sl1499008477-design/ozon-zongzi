import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baseSql = await readFile(new URL("../db/migrations/038_auto_listing_upload_rollout.sql", import.meta.url), "utf8");
const upgradeSql = await readFile(new URL("../db/migrations/043_auto_listing_base_evidence.sql", import.meta.url), "utf8").catch(() => "");

test("fresh and already-applied upload schemas preserve every V1 listing-base hash input", () => {
  for (const column of ["target_store_id", "pricing_evidence", "rich_content_attribute_supported", "listing_base_version"]) {
    assert.match(baseSql, new RegExp(`\\b${column}\\b`, "u"));
    assert.match(upgradeSql, new RegExp(`\\b${column}\\b`, "u"));
  }
  assert.match(baseSql, /FOREIGN KEY \(account_id,target_store_id\)[\s\S]*REFERENCES stores\(owner_account_id,id\)/iu);
  assert.match(upgradeSql, /BEFORE INSERT ON auto_listing_listing_bases/iu);
  assert.match(upgradeSql, /new auto-listing listing bases require complete V1 evidence/iu);
  assert.doesNotMatch(upgradeSql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE\s+auto_listing_listing_bases/iu);
});
