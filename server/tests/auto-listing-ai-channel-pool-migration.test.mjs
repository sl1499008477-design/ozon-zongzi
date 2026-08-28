import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../db/migrations/098_auto_listing_ai_channel_pool.sql", import.meta.url);

function tableBlock(sql, table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`, "u"));
  assert.ok(match, `expected ${table} table`);
  return match[1];
}

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

test("098 closes nullable provenance loopholes and keeps dispatch state on Outbox", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const channels = tableBlock(sql, "auto_listing_ai_profile_channels");

  assert.doesNotMatch(channels, /dispatch_generation|uncertain_result_count/);
  assert.match(channels, /assigned_status_version IS NOT NULL[\s\S]*?assigned_status_version > 0/);
  for (const pair of [
    "last_ai_connection_version",
    "gateway_connection_version",
    "checker_connection_version",
  ]) assert.match(sql, new RegExp(`${pair} IS NOT NULL[\\s\\S]*?${pair} > 0`, "u"));
  assert.match(sql, /BEFORE DELETE\s+ON auto_listing_ai_profile_channels/);
  assert.match(sql, /ON auto_listing_ai_profile_channels\(account_id, assigned_job_id, assigned_item_id\)/);
  assert.match(sql, /dispatch_contract_version = 'CHANNEL_WORK_V1'[\s\S]*?published_at IS NOT NULL/);
});
