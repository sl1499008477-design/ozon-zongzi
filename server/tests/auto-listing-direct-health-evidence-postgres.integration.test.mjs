import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1"
  && Boolean(process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const migrationUrl = new URL("../db/migrations/052_auto_listing_direct_health_evidence.sql", import.meta.url);
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

test("052 preserves historical DIRECT links and closes every new link and attempt in PostgreSQL", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `direct_health_052_${suffix}`;
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)},public`);
    await client.query(`CREATE TABLE auto_listing_upload_policy_versions (
      account_id TEXT NOT NULL,id TEXT NOT NULL,mode TEXT NOT NULL,PRIMARY KEY(account_id,id)
    )`);
    await client.query(`CREATE TABLE auto_listing_asset_publication_health_evidence (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,publication_version TEXT NOT NULL,
      public_base_url TEXT NOT NULL,public_prefix TEXT NOT NULL,outcome TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,UNIQUE(account_id,id)
    )`);
    await client.query(`CREATE TABLE auto_listing_submission_links (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,job_id TEXT NOT NULL,auto_listing_item_id TEXT NOT NULL,
      listing_base_id TEXT NOT NULL,active_plan_id TEXT NOT NULL,target_store_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,config_hash TEXT NOT NULL,request_hash TEXT NOT NULL,result_hash TEXT NOT NULL,
      upload_policy_version_id TEXT NOT NULL,publication_origin TEXT NOT NULL,publication_base_url TEXT NOT NULL,
      publication_prefix TEXT NOT NULL,publication_version TEXT NOT NULL,publication_policy_hash TEXT NOT NULL,
      media_evidence_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),submission_snapshot_id TEXT,submission_job_id TEXT,
      attempt_generation INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,claim_token TEXT,claim_expires_at TIMESTAMPTZ,
      UNIQUE(account_id,id)
    )`);
    await client.query(`CREATE TABLE auto_listing_upload_attempts (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,job_id TEXT NOT NULL,auto_listing_item_id TEXT NOT NULL,
      submission_link_id TEXT NOT NULL,actor_account_id TEXT NOT NULL,action TEXT NOT NULL,
      expected_item_version INTEGER NOT NULL,target_store_id TEXT NOT NULL,target_warehouse_id TEXT NOT NULL,
      product_draft_hash TEXT NOT NULL,request_hash TEXT NOT NULL,result_hash TEXT NOT NULL,outcome TEXT NOT NULL,
      error_code TEXT,error_safe TEXT,listing_pipeline_response_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      correlation_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE FUNCTION auto_listing_protect_submission_link()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`);
    await client.query(`CREATE TRIGGER auto_listing_submission_links_protected
      BEFORE UPDATE OR DELETE ON auto_listing_submission_links
      FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_submission_link()`);
    await client.query("INSERT INTO auto_listing_upload_policy_versions VALUES ('account-a','policy-direct','DIRECT')");
    const linkValues = ["link-legacy", "account-a", "job-a", "item-a", "base-a", "plan-a", "store-a",
      "source", "config", "request", "result", "policy-direct", "https://cdn.example.com",
      "https://cdn.example.com/", "listing/v1", "V1", "policy-hash", "media-hash", "idem-a"];
    await client.query(`INSERT INTO auto_listing_submission_links
      (id,account_id,job_id,auto_listing_item_id,listing_base_id,active_plan_id,target_store_id,
       source_hash,config_hash,request_hash,result_hash,upload_policy_version_id,publication_origin,
       publication_base_url,publication_prefix,publication_version,publication_policy_hash,
       media_evidence_hash,idempotency_key,status,claim_token,claim_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'RESERVED','legacy-claim',NOW()+INTERVAL '1 minute')`,
    linkValues);

    await client.query(await readFile(migrationUrl, "utf8"));
    assert.equal((await client.query(
      "SELECT direct_health_evidence_id FROM auto_listing_submission_links WHERE id='link-legacy'",
    )).rows[0].direct_health_evidence_id, null);

    await client.query(`INSERT INTO auto_listing_asset_publication_health_evidence
      (id,account_id,publication_version,public_base_url,public_prefix,outcome,expires_at)
      VALUES ('health-a','account-a','V1','https://cdn.example.com/','listing/v1','PASSED',NOW()+INTERVAL '10 minutes')`);
    await client.query(`INSERT INTO auto_listing_submission_links
      (id,account_id,job_id,auto_listing_item_id,listing_base_id,active_plan_id,target_store_id,
       source_hash,config_hash,request_hash,result_hash,upload_policy_version_id,publication_origin,
       publication_base_url,publication_prefix,publication_version,publication_policy_hash,
       media_evidence_hash,idempotency_key,status,claim_token,claim_expires_at,direct_health_evidence_id)
      VALUES ('link-new','account-a','job-b','item-b','base-b','plan-b','store-a','source','config','request',
        'result','policy-direct','https://cdn.example.com','https://cdn.example.com/','listing/v1','V1',
        'policy-hash','media-hash','idem-b','RESERVED','new-claim',NOW()+INTERVAL '1 minute','health-a')`);
    await client.query(`INSERT INTO auto_listing_upload_attempts
      (id,account_id,job_id,auto_listing_item_id,submission_link_id,actor_account_id,action,
       expected_item_version,target_store_id,target_warehouse_id,product_draft_hash,request_hash,
       result_hash,outcome,correlation_id,direct_health_evidence_id)
      VALUES ('attempt-a','account-a','job-b','item-b','link-new','account-a','DIRECT_UPLOAD',1,
        'store-a','warehouse-a','draft','request','result','SUCCEEDED','corr-a','health-a')`);
    await assert.rejects(client.query(
      "UPDATE auto_listing_submission_links SET direct_health_evidence_id=NULL WHERE id='link-new'",
    ), (error) => error?.code === "23514");
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    client.release();
    await pool.end();
  }
});
