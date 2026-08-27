import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/077_auto_listing_generation_retry_version_scope.sql", import.meta.url);

test("manual generation retries isolate attempt uniqueness by item status version", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql,
    /DROP CONSTRAINT IF EXISTS ai_generation_assets_item_id_slot_key_input_hash_attempt_no_key/iu);
  assert.match(sql,
    /ON ai_generation_assets\(item_id,slot_key,input_hash,expected_status_version,attempt_no\)[\s\S]*?WHERE expected_status_version IS NOT NULL/iu);
  assert.match(sql,
    /ON ai_generation_assets\(item_id,slot_key,input_hash,attempt_no\)[\s\S]*?WHERE expected_status_version IS NULL/iu);
  assert.doesNotMatch(sql, /UPDATE\s+ai_generation_assets\b/iu);
});
