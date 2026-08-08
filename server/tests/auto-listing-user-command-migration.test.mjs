import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../db/migrations/037_auto_listing_user_commands.sql", import.meta.url), "utf8").catch(() => "");

test("user item commands are append-only, account scoped and idempotent", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_user_commands/i);
  assert.match(sql, /UNIQUE\s*\(account_id,\s*idempotency_key\)/i);
  assert.match(sql, /FOREIGN KEY \(account_id,job_id,item_id\)[\s\S]*auto_listing_job_items/i);
  assert.match(sql, /action TEXT NOT NULL CHECK \(action IN \('CANCEL','REGENERATE'\)\)/i);
  assert.match(sql, /expected_status_version INTEGER NOT NULL/i);
  assert.match(sql, /result_status_version INTEGER NOT NULL/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_user_commands/i);
});
