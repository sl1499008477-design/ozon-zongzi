import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dedicatedDatabaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(dedicatedDatabaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

if (!enabled) {
  test("AI content PostgreSQL behavior requires both explicit gates and a dedicated database URL", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL enforces AI content provenance, terminal evidence, leases, and retry uniqueness", { timeout: 20_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dedicatedDatabaseUrl });
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_ai_task1_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const account = `account-${suffix}`;
    const store = `store-${suffix}`;
    const warehouse = `warehouse-${suffix}`;
    const jobA = `job-a-${suffix}`;
    const jobB = `job-b-${suffix}`;
    const itemA = `item-a-${suffix}`;
    const itemB = `item-b-${suffix}`;
    const snapshotA = `snapshot-a-${suffix}`;
    const snapshotB = `snapshot-b-${suffix}`;
    const strategyA = `strategy-a-${suffix}`;
    const strategyB = `strategy-b-${suffix}`;
    const profile = `profile-${suffix}`;
    const plan = `plan-${suffix}`;

    const insertPlan = (overrides = {}) => client.query(
      `INSERT INTO ai_content_plans (
         id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
         strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
         prompt_template_version,plan,plan_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'strategy-hash','config-hash','source-hash',$8,'planner',1,'template-v1','{"slots":[]}'::jsonb,'plan-hash')`,
      [
        overrides.id || plan,
        account,
        overrides.jobId || jobA,
        overrides.itemId || itemA,
        overrides.snapshotId || snapshotA,
        overrides.strategyId || strategyA,
        profile,
        overrides.inputHash || `input-${overrides.id || plan}`,
      ],
    );

    const insertAsset = (overrides = {}) => client.query(
      `INSERT INTO ai_generation_assets (
         id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,
         input_hash,attempt_no,status,model_name,profile_version,prompt_hash,object_key,
         content_hash,content_type,width,height,checker_result,error_code,error_retryable,accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'visual-a',$7,'SELLING_POINT',$8,$9,$10,'image-model',$11,'prompt-hash',$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20)`,
      [
        overrides.id,
        account,
        jobA,
        itemA,
        plan,
        profile,
        overrides.slotKey || "selling-point-1",
        overrides.inputHash || "asset-input",
        overrides.attemptNo || 1,
        overrides.status || "PENDING",
        overrides.profileVersion || 1,
        overrides.objectKey ?? null,
        overrides.contentHash ?? null,
        overrides.contentType ?? null,
        overrides.width ?? null,
        overrides.height ?? null,
        JSON.stringify(overrides.checkerResult ?? {}),
        overrides.errorCode ?? null,
        overrides.errorRetryable ?? null,
        overrides.acceptedAt ?? null,
      ],
    );

    const insertResult = (overrides = {}) => client.query(
      `INSERT INTO ai_rich_content_results (
         id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,
         attempt_no,model_name,profile_version,prompt_template_version,rich_content,output_hash,
         checker_result,status,error_code,error_retryable,accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'text-model',$11,'template-v1',$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18)`,
      [
        overrides.id,
        account,
        jobA,
        itemA,
        plan,
        profile,
        overrides.sourceHash ?? "source-hash",
        overrides.assetHash ?? "asset-hash",
        overrides.inputHash || "rich-input",
        overrides.attemptNo || 1,
        overrides.profileVersion || 1,
        JSON.stringify(overrides.richContent ?? {}),
        overrides.outputHash ?? "",
        JSON.stringify(overrides.checkerResult ?? {}),
        overrides.status || "PENDING",
        overrides.errorCode ?? null,
        overrides.errorRetryable ?? null,
        overrides.acceptedAt ?? null,
      ],
    );

    try {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
      await client.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort()) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }

      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [account, `user-${suffix}`],
      );
      await client.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [store, `Store ${suffix}`, `client-${suffix}`, account],
      );
      await client.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [warehouse, store, `platform-${suffix}`],
      );
      for (const [id, key] of [[strategyA, "a"], [strategyB, "b"]]) {
        await client.query(
          "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
          [id, account, `strategy-${key}`, `strategy-hash-${key}`],
        );
      }
      for (const [id, record] of [[snapshotA, "a"], [snapshotB, "b"]]) {
        await client.query(
          "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)",
          [id, account, `record-${record}`, `snapshot-hash-${record}`],
        );
      }
      for (const [id, strategy, key] of [[jobA, strategyA, "a"], [jobB, strategyB, "b"]]) {
        await client.query(
          "INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)",
          [id, account, `job-key-${key}`, `config-${key}`, strategy],
        );
      }
      for (const [id, job, snapshot] of [[itemA, jobA, snapshotA], [itemB, jobB, snapshotB]]) {
        await client.query(
          "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, job, account, snapshot, store, warehouse],
        );
      }
      await client.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version
         ) VALUES ($1,$2,'Primary','https://gateway.invalid','AI_GATEWAY_KEY','SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1)`,
        [profile, account],
      );

      await assert.rejects(insertPlan({ id: `cross-job-${suffix}`, jobId: jobA, itemId: itemB, snapshotId: snapshotB, strategyId: strategyA }), { code: "23503" });
      await assert.rejects(insertPlan({ id: `cross-snapshot-${suffix}`, snapshotId: snapshotB }), { code: "23503" });
      await assert.rejects(insertPlan({ id: `cross-strategy-${suffix}`, strategyId: strategyB }), { code: "23503" });
      await assert.rejects(client.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'s','c','x','profile-version-input','planner',2,'v1','{}'::jsonb,'h')`,
        [`cross-profile-version-${suffix}`, account, jobA, itemA, snapshotA, strategyA, profile],
      ), { code: "23503" });

      await insertPlan();
      await assert.rejects(client.query("UPDATE ai_gateway_profiles SET base_url='https://changed.invalid' WHERE id=$1", [profile]), /referenced AI gateway profile configuration is immutable/i);
      await client.query(
        "UPDATE ai_gateway_profiles SET capability_result=$2::jsonb,capability_checked_at=NOW(),enabled=TRUE WHERE id=$1",
        [profile, JSON.stringify({ ok: true })],
      );

      await assert.rejects(insertAsset({ id: `asset-wrong-profile-${suffix}`, profileVersion: 2 }), { code: "23503" });
      await assert.rejects(insertResult({ id: `rich-wrong-profile-${suffix}`, profileVersion: 2 }), { code: "23503" });
      await assert.rejects(insertAsset({ id: `asset-incomplete-${suffix}`, status: "ACCEPTED", acceptedAt: new Date() }), { code: "23514" });
      await insertAsset({ id: `asset-failed-${suffix}`, status: "FAILED", errorCode: "GATEWAY", errorRetryable: true });
      await assert.rejects(client.query("UPDATE ai_generation_assets SET status='PENDING' WHERE id=$1", [`asset-failed-${suffix}`]), /terminal AI generation assets are immutable/i);
      await assert.rejects(client.query("DELETE FROM ai_generation_assets WHERE id=$1", [`asset-failed-${suffix}`]), /terminal AI generation assets are immutable/i);
      await assert.rejects(insertAsset({ id: `asset-failed-duplicate-${suffix}`, status: "FAILED", errorCode: "GATEWAY", errorRetryable: true }), { code: "23505" });
      await insertAsset({
        id: `asset-accepted-${suffix}`, attemptNo: 2, status: "ACCEPTED", objectKey: "objects/a.png",
        contentHash: "content-hash", contentType: "image/png", width: 768, height: 1024,
        checkerResult: { ok: true }, acceptedAt: new Date(),
      });
      await assert.rejects(insertAsset({
        id: `asset-second-accepted-${suffix}`, attemptNo: 3, status: "ACCEPTED", objectKey: "objects/b.png",
        contentHash: "content-hash-2", contentType: "image/png", width: 768, height: 1024,
        checkerResult: { ok: true }, acceptedAt: new Date(),
      }), { code: "23505" });

      await assert.rejects(insertResult({ id: `rich-incomplete-${suffix}`, status: "ACCEPTED", acceptedAt: new Date() }), { code: "23514" });
      await insertResult({ id: `rich-rejected-${suffix}`, status: "REJECTED", errorCode: "CHECKER", errorRetryable: false });
      await assert.rejects(client.query("UPDATE ai_rich_content_results SET status='PENDING' WHERE id=$1", [`rich-rejected-${suffix}`]), /terminal AI rich-content results are immutable/i);
      await insertResult({
        id: `rich-accepted-${suffix}`, attemptNo: 2, status: "ACCEPTED", richContent: { blocks: [{ text: "RU" }] },
        outputHash: "output-hash", checkerResult: { ok: true }, acceptedAt: new Date(),
      });
      await assert.rejects(insertResult({
        id: `rich-second-accepted-${suffix}`, attemptNo: 3, status: "ACCEPTED",
        richContent: { blocks: [{ text: "RU2" }] }, outputHash: "output-hash-2",
        checkerResult: { ok: true }, acceptedAt: new Date(),
      }), { code: "23505" });
      await assert.rejects(insertResult({
        id: `rich-duplicate-attempt-${suffix}`, attemptNo: 2, status: "FAILED",
        errorCode: "GATEWAY", errorRetryable: true,
      }), { code: "23505" });

      await assert.rejects(client.query(
        "INSERT INTO auto_listing_ai_outbox (id,account_id,job_id,item_id,event_type,dedupe_key,state) VALUES ($1,$2,$3,$4,'GENERATE','lease-missing','LEASED')",
        [`outbox-invalid-lease-${suffix}`, account, jobA, itemA],
      ), { code: "23514" });
      await assert.rejects(client.query(
        "INSERT INTO auto_listing_ai_outbox (id,account_id,job_id,item_id,event_type,dedupe_key,state,lease_owner,lease_expires_at) VALUES ($1,$2,$3,$4,'GENERATE','pending-has-lease','PENDING','worker',NOW())",
        [`outbox-invalid-pending-${suffix}`, account, jobA, itemA],
      ), { code: "23514" });
      await client.query(
        "INSERT INTO auto_listing_ai_outbox (id,account_id,job_id,item_id,event_type,dedupe_key,state,lease_owner,lease_expires_at) VALUES ($1,$2,$3,$4,'GENERATE','valid-lease','LEASED','worker',NOW()+INTERVAL '1 minute')",
        [`outbox-valid-${suffix}`, account, jobA, itemA],
      );
      await assert.rejects(client.query(
        "INSERT INTO auto_listing_ai_outbox (id,account_id,job_id,item_id,event_type,dedupe_key) VALUES ($1,$2,$3,$4,'GENERATE','valid-lease')",
        [`outbox-duplicate-${suffix}`, account, jobA, itemA],
      ), { code: "23505" });
      await assert.rejects(client.query("UPDATE auto_listing_ai_outbox SET state='PENDING' WHERE id=$1", [`outbox-valid-${suffix}`]), { code: "23514" });
      await client.query("UPDATE auto_listing_ai_outbox SET state='PENDING',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [`outbox-valid-${suffix}`]);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`).catch(() => {});
      client.release();
      await pool.end();
    }
  });
}
