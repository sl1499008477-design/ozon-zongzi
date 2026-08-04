import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/028_auto_listing_ai_plan_evidence.sql", import.meta.url);

test("plan evidence migration is additive, type-safe, and preserves old immutable rows", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE ai_content_plans\s+ADD COLUMN IF NOT EXISTS visual_groups_hash TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS visual_groups JSONB/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS regeneration JSONB/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS gateway_request_id TEXT/i);
  assert.match(sql, /visual_groups_hash IS NULL OR visual_groups_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
  assert.match(sql, /visual_groups IS NULL OR jsonb_typeof\(visual_groups\) = 'object'/i);
  assert.match(sql, /regeneration IS NULL OR jsonb_typeof\(regeneration\) = 'object'/i);
  assert.match(sql, /gateway_request_id IS NULL OR \(CHAR_LENGTH\(gateway_request_id\) BETWEEN 1 AND 240 AND gateway_request_id = BTRIM\(gateway_request_id\)\)/i);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+ai_content_plans)\b/i);
});
