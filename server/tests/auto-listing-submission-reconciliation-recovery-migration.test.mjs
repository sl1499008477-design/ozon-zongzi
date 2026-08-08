import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const file = new URL("../db/migrations/051_auto_listing_reconciliation_admin_recovery.sql", import.meta.url);

test("migration 051 permits only audited same-task DEAD recovery generations", async () => {
  const sql = await readFile(file, "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0/iu);
  assert.match(sql, /event_type IN \('CREATED','LEASED','RESCHEDULED','COMPLETED','DEAD','RECOVERED'\)/iu);
  assert.match(sql, /OLD\.state = 'DEAD'[\s\S]*NEW\.state = 'PENDING'/iu);
  assert.match(sql, /NEW\.attempt_count = 0/iu);
  assert.match(sql, /NEW\.recovery_count = OLD\.recovery_count \+ 1/iu);
  assert.match(sql, /NEW\.account_id IS DISTINCT FROM OLD\.account_id/iu);
  assert.match(sql, /NEW\.submission_job_id IS DISTINCT FROM OLD\.submission_job_id/iu);
  assert.match(sql, /AUTO_LISTING_RECONCILIATION_TASK_RECOVERED/iu);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON audit_events/iu);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM|CASCADE/iu);
});
