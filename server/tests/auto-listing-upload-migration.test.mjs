import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/038_auto_listing_upload_rollout.sql", import.meta.url);
const migrationsUrl = new URL("../db/migrations/", import.meta.url);

function tableBlock(sql, tableName) {
  const match = sql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName}([\\s\\S]*?)(?=\\nCREATE TABLE IF NOT EXISTS|\\nALTER TABLE|\\nCREATE (?:UNIQUE )?INDEX|\\nCREATE OR REPLACE FUNCTION|$)`,
    "i",
  ));
  assert.ok(match, `missing ${tableName} table definition`);
  return match[0];
}

function functionBlock(sql, functionName) {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION ${functionName}\\(\\)[\\s\\S]*?\\$\\$;`,
    "i",
  ));
  assert.ok(match, `missing ${functionName} function`);
  return match[0];
}

test("038 freezes complete account-scoped Ozon listing bases and policy versions", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const bases = tableBlock(sql, "auto_listing_listing_bases");
  const policies = tableBlock(sql, "auto_listing_upload_policy_versions");

  assert.match(bases, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE RESTRICT/i);
  assert.match(bases, /job_id TEXT NOT NULL/i);
  assert.match(bases, /item_id TEXT NOT NULL/i);
  assert.match(bases, /source_snapshot_id TEXT NOT NULL/i);
  assert.match(bases, /collect_item_id TEXT NOT NULL/i);
  assert.match(bases, /product_draft_id TEXT NOT NULL/i);
  assert.match(bases, /product_draft_version INTEGER NOT NULL CHECK \(product_draft_version > 0\)/i);
  assert.match(bases, /product_draft_data_hash TEXT NOT NULL CHECK \(product_draft_data_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(bases, /ozon_ready_variants JSONB NOT NULL[\s\S]*?jsonb_typeof\(ozon_ready_variants\) = 'array'/i);
  assert.match(bases, /canonical_hash TEXT NOT NULL CHECK \(canonical_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(bases, /normalizer_version TEXT NOT NULL/i);
  assert.match(bases, /category_rule_version TEXT NOT NULL/i);
  assert.match(bases, /dictionary_version TEXT NOT NULL/i);
  assert.match(bases, /FOREIGN KEY \(account_id,job_id,item_id,source_snapshot_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id,job_id,id,snapshot_id\) ON DELETE RESTRICT/i);
  assert.match(bases, /FOREIGN KEY \(account_id,collect_item_id\)[\s\S]*?REFERENCES collect_items\(account_id,id\) ON DELETE RESTRICT/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS product_drafts_id_collect_item_id_key[\s\S]*?ON product_drafts\(id,collect_item_id\)/i);
  assert.match(bases, /FOREIGN KEY \(product_draft_id,collect_item_id\)[\s\S]*?REFERENCES product_drafts\(id,collect_item_id\) ON DELETE RESTRICT/i);
  assert.match(bases, /UNIQUE \(account_id,job_id,item_id,source_snapshot_id\)/i);
  assert.match(bases, /UNIQUE \(account_id,job_id,item_id,id\)/i);
  assert.match(functionBlock(sql, "auto_listing_reject_listing_base_mutation"), /listing bases are append-only/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_listing_bases[\s\S]*?auto_listing_reject_listing_base_mutation\(\)/i);

  assert.match(policies, /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE RESTRICT/i);
  assert.match(policies, /mode TEXT NOT NULL CHECK \(mode IN \('REVIEW','DIRECT'\)\)/i);
  assert.match(policies, /enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(policies, /version INTEGER NOT NULL CHECK \(version > 0\)/i);
  assert.match(policies, /publication_reason TEXT NOT NULL/i);
  assert.match(policies, /created_by TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE RESTRICT/i);
  assert.match(policies, /published_by TEXT REFERENCES accounts\(id\) ON DELETE RESTRICT/i);
  assert.match(policies, /UNIQUE \(account_id,version\)/i);
  assert.match(policies, /UNIQUE \(account_id,id\)/i);
  assert.match(functionBlock(sql, "auto_listing_require_admin_upload_policy_publisher"), /role = 'admin'/i);
  assert.match(functionBlock(sql, "auto_listing_reject_upload_policy_version_mutation"), /upload policy versions are immutable/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_upload_policy_versions[\s\S]*?auto_listing_reject_upload_policy_version_mutation\(\)/i);
  assert.doesNotMatch(sql, /INSERT INTO auto_listing_upload_policy_versions[\s\S]*?'DIRECT'[\s\S]*?TRUE/i);
});

test("038 links every result to its frozen base, active plan, existing listing submission, and policy", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const links = tableBlock(sql, "auto_listing_submission_links");

  for (const column of [
    "account_id", "job_id", "auto_listing_item_id", "listing_base_id", "active_plan_id",
    "target_store_id", "source_hash", "config_hash", "request_hash", "result_hash",
    "upload_policy_version_id", "submission_snapshot_id", "submission_job_id", "idempotency_key", "status",
  ]) {
    assert.match(links, new RegExp(`${column} `, "i"), `missing submission link ${column}`);
  }
  assert.match(links, /source_hash TEXT NOT NULL CHECK \(source_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(links, /config_hash TEXT NOT NULL CHECK \(config_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(links, /request_hash TEXT NOT NULL CHECK \(request_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(links, /result_hash TEXT NOT NULL CHECK \(result_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(links, /UNIQUE \(account_id,auto_listing_item_id,result_hash,target_store_id\)/i);
  assert.match(links, /UNIQUE \(account_id,idempotency_key\)/i);
  assert.match(links, /UNIQUE \(account_id,job_id,auto_listing_item_id,id\)/i);
  assert.match(links, /UNIQUE \(account_id,job_id,auto_listing_item_id,id,target_store_id\)/i);
  assert.match(links, /FOREIGN KEY \(account_id,job_id,auto_listing_item_id,target_store_id\)[\s\S]*?REFERENCES auto_listing_job_items\(account_id,job_id,id,target_store_id\) ON DELETE RESTRICT/i);
  assert.match(links, /FOREIGN KEY \(account_id,job_id,auto_listing_item_id,listing_base_id\)[\s\S]*?REFERENCES auto_listing_listing_bases\(account_id,job_id,item_id,id\) ON DELETE RESTRICT/i);
  assert.match(links, /FOREIGN KEY \(account_id,job_id,auto_listing_item_id,active_plan_id\)[\s\S]*?REFERENCES ai_content_plans\(account_id,job_id,item_id,id\) ON DELETE RESTRICT/i);
  assert.match(links, /FOREIGN KEY \(account_id,upload_policy_version_id\)[\s\S]*?REFERENCES auto_listing_upload_policy_versions\(account_id,id\) ON DELETE RESTRICT/i);
  assert.match(links, /FOREIGN KEY \(account_id,target_store_id\)[\s\S]*?REFERENCES stores\(owner_account_id,id\) ON DELETE RESTRICT/i);
  assert.match(links, /FOREIGN KEY \(account_id,submission_snapshot_id,target_store_id\)[\s\S]*?REFERENCES submission_snapshots\(account_id,id,store_id\) ON DELETE RESTRICT/i);
  assert.match(links, /FOREIGN KEY \(account_id,submission_job_id,submission_snapshot_id,target_store_id\)[\s\S]*?REFERENCES submission_jobs\(account_id,id,snapshot_id,store_id\) ON DELETE RESTRICT/i);
  assert.match(links, /CHECK \([\s\S]*?submission_snapshot_id IS NULL AND submission_job_id IS NULL[\s\S]*?submission_snapshot_id IS NOT NULL AND submission_job_id IS NOT NULL[\s\S]*?\)/i);
  assert.match(links, /CHECK \([\s\S]*?status NOT IN \('SUBMITTED','RECONCILING','SUCCEEDED'\)[\s\S]*?submission_snapshot_id IS NOT NULL AND submission_job_id IS NOT NULL[\s\S]*?\)/i);
  const protection = functionBlock(sql, "auto_listing_protect_submission_link");
  for (const field of [
    "account_id", "job_id", "auto_listing_item_id", "listing_base_id", "active_plan_id",
    "target_store_id", "source_hash", "config_hash", "request_hash", "result_hash",
    "upload_policy_version_id", "idempotency_key", "created_at",
  ]) assert.match(protection, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, "i"));
  assert.match(protection, /OLD\.submission_snapshot_id IS NOT NULL[\s\S]*?NEW\.submission_snapshot_id IS DISTINCT FROM OLD\.submission_snapshot_id/i);
  assert.match(protection, /OLD\.submission_job_id IS NOT NULL[\s\S]*?NEW\.submission_job_id IS DISTINCT FROM OLD\.submission_job_id/i);
  assert.match(protection, /TG_OP = 'DELETE'/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_submission_links[\s\S]*?auto_listing_protect_submission_link\(\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_submission_links_item_status_idx[\s\S]*?ON auto_listing_submission_links\(account_id,auto_listing_item_id,status,created_at DESC\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_submission_links_submission_job_idx[\s\S]*?ON auto_listing_submission_links\(submission_job_id\)/i);
});

test("038 records append-only auditable upload attempts and freezes a job policy reference additively", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const attempts = tableBlock(sql, "auto_listing_upload_attempts");

  for (const column of [
    "account_id", "job_id", "auto_listing_item_id", "submission_link_id", "actor_account_id", "action",
    "expected_item_version", "target_store_id", "target_warehouse_id", "product_draft_hash",
    "request_hash", "result_hash", "outcome", "error_code", "error_safe", "listing_pipeline_response_summary", "correlation_id",
  ]) {
    assert.match(attempts, new RegExp(`${column} `, "i"), `missing upload attempt ${column}`);
  }
  assert.match(attempts, /expected_item_version INTEGER NOT NULL CHECK \(expected_item_version > 0\)/i);
  assert.match(attempts, /listing_pipeline_response_summary JSONB NOT NULL DEFAULT '\{\}'::JSONB[\s\S]*?jsonb_typeof\(listing_pipeline_response_summary\) = 'object'/i);
  assert.match(attempts, /error_code TEXT[\s\S]*?\^\[A-Z\]\[A-Z0-9_\]\{0,119\}\$/i);
  assert.match(attempts, /FOREIGN KEY \(account_id,job_id,auto_listing_item_id,submission_link_id,target_store_id\)[\s\S]*?REFERENCES auto_listing_submission_links\(account_id,job_id,auto_listing_item_id,id,target_store_id\) ON DELETE RESTRICT/i);
  assert.match(attempts, /FOREIGN KEY \(account_id,target_store_id\)[\s\S]*?REFERENCES stores\(owner_account_id,id\) ON DELETE RESTRICT/i);
  assert.match(attempts, /FOREIGN KEY \(target_store_id,target_warehouse_id\)[\s\S]*?REFERENCES warehouses\(store_id,id\) ON DELETE RESTRICT/i);
  assert.match(functionBlock(sql, "auto_listing_reject_upload_attempt_mutation"), /upload attempts are append-only/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON auto_listing_upload_attempts[\s\S]*?auto_listing_reject_upload_attempt_mutation\(\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS auto_listing_upload_attempts_item_created_idx[\s\S]*?ON auto_listing_upload_attempts\(account_id,auto_listing_item_id,created_at DESC\)/i);

  assert.match(sql, /ALTER TABLE auto_listing_jobs[\s\S]*?ADD COLUMN IF NOT EXISTS upload_policy_version_id TEXT/i);
  assert.match(sql, /FOREIGN KEY \(account_id,upload_policy_version_id\)[\s\S]*?REFERENCES auto_listing_upload_policy_versions\(account_id,id\) ON DELETE RESTRICT/i);
  assert.doesNotMatch(sql, /\b(?:DROP\s+(?:TABLE|COLUMN)|ALTER\s+TABLE[\s\S]*?\bRENAME\b|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.doesNotMatch(sql, /(?:^|;)\s*UPDATE\s+\w+\s+SET\b/im);
  for (const table of [
    "auto_listing_listing_bases", "auto_listing_upload_policy_versions",
    "auto_listing_submission_links", "auto_listing_upload_attempts",
  ]) {
    assert.match(tableBlock(sql, table), /account_id TEXT NOT NULL REFERENCES accounts\(id\) ON DELETE RESTRICT/i);
  }
});

test("038 is discovered after the existing auto-listing migrations", async () => {
  const migrations = (await readdir(migrationsUrl)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  assert.ok(migrations.includes("038_auto_listing_upload_rollout.sql"));
  assert.ok(migrations.indexOf("038_auto_listing_upload_rollout.sql") > migrations.indexOf("037_auto_listing_user_commands.sql"));
});
