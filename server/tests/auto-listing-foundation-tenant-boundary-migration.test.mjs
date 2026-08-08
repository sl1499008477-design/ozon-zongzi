import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/039_auto_listing_foundation_tenant_boundaries.sql", import.meta.url);

test("039 detects historical cross-scope rows before validating additive composite foreign keys", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /FROM auto_listing_job_items item[\s\S]*?JOIN auto_listing_jobs job[\s\S]*?item\.account_id IS DISTINCT FROM job\.account_id/i);
  assert.match(sql, /JOIN auto_listing_source_snapshots snapshot[\s\S]*?item\.account_id IS DISTINCT FROM snapshot\.account_id/i);
  assert.match(sql, /JOIN stores store[\s\S]*?item\.account_id IS DISTINCT FROM store\.owner_account_id/i);
  assert.match(sql, /JOIN warehouses warehouse[\s\S]*?item\.target_store_id IS DISTINCT FROM warehouse\.store_id/i);
  assert.match(sql, /FROM auto_listing_events event[\s\S]*?JOIN auto_listing_jobs job[\s\S]*?event\.account_id IS DISTINCT FROM job\.account_id/i);
  assert.match(sql, /JOIN auto_listing_job_items item[\s\S]*?event\.account_id IS DISTINCT FROM item\.account_id[\s\S]*?event\.job_id IS DISTINCT FROM item\.job_id/i);
  assert.match(sql, /RAISE EXCEPTION 'auto-listing historical tenant boundary violation:/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i);
});

test("039 closes job item account, snapshot, store, and warehouse relationships", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /FOREIGN KEY \(account_id,job_id\)[\s\S]*?REFERENCES auto_listing_jobs\(account_id,id\)[\s\S]*?NOT VALID/i);
  assert.match(sql, /FOREIGN KEY \(account_id,snapshot_id\)[\s\S]*?REFERENCES auto_listing_source_snapshots\(account_id,id\)[\s\S]*?NOT VALID/i);
  assert.match(sql, /FOREIGN KEY \(account_id,target_store_id\)[\s\S]*?REFERENCES stores\(owner_account_id,id\)[\s\S]*?NOT VALID/i);
  assert.match(sql, /FOREIGN KEY \(target_store_id,target_warehouse_id\)[\s\S]*?REFERENCES warehouses\(store_id,id\)[\s\S]*?NOT VALID/i);
  for (const name of [
    "auto_listing_job_items_account_job_scope_fkey",
    "auto_listing_job_items_account_snapshot_scope_fkey",
    "auto_listing_job_items_account_store_scope_fkey",
    "auto_listing_job_items_store_warehouse_scope_fkey",
  ]) assert.match(sql, new RegExp(`VALIDATE CONSTRAINT ${name}`, "i"));
});

test("039 closes event account, job, and optional item relationships", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE auto_listing_events[\s\S]*?FOREIGN KEY \(account_id,job_id\)[\s\S]*?REFERENCES auto_listing_jobs\(account_id,id\)[\s\S]*?NOT VALID/i);
  assert.match(sql, /ALTER TABLE auto_listing_events[\s\S]*?FOREIGN KEY \(account_id,job_id,item_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id,job_id,id\)[\s\S]*?NOT VALID/i);
  assert.match(sql, /VALIDATE CONSTRAINT auto_listing_events_account_job_scope_fkey/i);
  assert.match(sql, /VALIDATE CONSTRAINT auto_listing_events_account_job_item_scope_fkey/i);
});

test("039 follows upload migration without renumbering prior contracts", async () => {
  const migrations = (await readdir(new URL("../db/migrations/", import.meta.url)))
    .filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  assert.ok(migrations.indexOf("039_auto_listing_foundation_tenant_boundaries.sql")
    > migrations.indexOf("038_auto_listing_upload_rollout.sql"));
});
