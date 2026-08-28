import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../db/migrations/098_auto_listing_ai_channel_pool.sql", import.meta.url);

test("098 creates account-scoped profile channels and exact-version evidence", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_ai_profile_channels/);
  assert.match(sql, /FOREIGN KEY \(account_id, profile_id, profile_version\)/);
  assert.match(sql, /FOREIGN KEY \(account_id, connection_id, connection_version\)/);
  assert.match(sql, /dispatch_generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /uncertain_result_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /gateway_connection_id/);
  assert.match(sql, /checker_connection_id/);
});
