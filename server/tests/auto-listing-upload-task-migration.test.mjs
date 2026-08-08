import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../db/migrations/050_auto_listing_upload_dispatch.sql", import.meta.url), "utf8").catch(() => "");

test("migration 050 adds a durable tenant-scoped upload queue and audit trail", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_upload_tasks/iu);
  assert.match(sql, /UNIQUE \(account_id,item_id,expected_status_version\)/iu);
  assert.match(sql, /FOREIGN KEY \(account_id,job_id,item_id\)[\s\S]*auto_listing_job_items/iu);
  assert.match(sql, /CHECK \(state IN \('PENDING','LEASED','COMPLETED','DEAD'\)\)/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_upload_task_events/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_upload_task_events/iu);
  assert.match(sql, /auto_listing_upload_task_identity_is_immutable/iu);
});

test("migration 050 makes the persisted approve command legal without weakening the closed action set", () => {
  assert.match(sql, /DROP CONSTRAINT IF EXISTS auto_listing_user_commands_action_check/iu);
  assert.match(sql, /CHECK \(action IN \('CANCEL','REGENERATE','APPROVE_UPLOAD'\)\)/iu);
});
