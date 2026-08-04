import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresRichContentRepository } from "../auto-listing-rich-content-repository.mjs";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hash = (character) => character.repeat(64);

export async function runRichContentPostgresFixture({ connectionString } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new Error("A dedicated PostgreSQL connection string is required");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `rich_content_031_${suffix}`;
  const accountId = `account-${suffix}`;
  const storeId = `store-${suffix}`;
  const warehouseId = `warehouse-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  const strategyId = `strategy-${suffix}`;
  const jobId = `job-${suffix}`;
  const itemId = `item-${suffix}`;
  const profileId = `profile-${suffix}`;
  const planId = `plan-${suffix}`;
  const legacyId = `legacy-rich-${suffix}`;
  try {
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 30)
      .sort();
    for (const migration of migrations) {
      await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }

    await client.query(
      "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
      [accountId, `user-${suffix}`],
    );
    await client.query(
      "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
      [storeId, `Store ${suffix}`, `client-${suffix}`, accountId],
    );
    await client.query(
      "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
      [warehouseId, storeId, `platform-${suffix}`],
    );
    await client.query(
      "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
      [strategyId, accountId, `strategy-${suffix}`, hash("a")],
    );
    await client.query(
      "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)",
      [snapshotId, accountId, `record-${suffix}`, hash("b")],
    );
    await client.query(
      "INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)",
      [jobId, accountId, `job-key-${suffix}`, hash("c"), strategyId],
    );
    await client.query(
      "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [itemId, jobId, accountId, snapshotId, storeId, warehouseId],
    );
    await client.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version
       ) VALUES ($1,$2,'Primary','https://gateway.invalid','AI_GATEWAY_KEY','SUB2API_RESPONSES',
         'SUB2API_OPENAI_IMAGES','text-model','image-model',1)`,
      [profileId, accountId],
    );
    await client.query(
      `INSERT INTO ai_content_plans (
         id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
         strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
         prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planner',1,'plan-v1','{}'::jsonb,
         $12,$13,'{"sourceHash":"source","groups":[],"reasonCodes":[],"visualGroupsHash":"hash"}'::jsonb,'plan-request')`,
      [planId, accountId, jobId, itemId, snapshotId, strategyId, profileId,
        hash("d"), hash("e"), hash("f"), hash("0"), hash("1"), hash("2")],
    );

    const legacyContent = { version: "LEGACY", blocks: [{ type: "TEXT", text: "история" }] };
    await client.query(
      `INSERT INTO ai_rich_content_results (
         id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,
         attempt_no,model_name,profile_version,prompt_template_version,rich_content,output_hash,
         checker_result,status,accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'legacy-source','legacy-assets','legacy-input',1,'legacy-model',1,
         'legacy-v1',$7::jsonb,'legacy-output','{"accepted":true}'::jsonb,'ACCEPTED',NOW())`,
      [legacyId, accountId, jobId, itemId, planId, profileId, JSON.stringify(legacyContent)],
    );
    const before = await client.query("SELECT * FROM ai_rich_content_results WHERE id=$1", [legacyId]);
    const migration031 = await readFile(path.join(migrationsDir, "031_auto_listing_rich_content_attempt_evidence.sql"), "utf8");
    await client.query(migration031);
    await client.query(migration031);
    const after = await client.query("SELECT * FROM ai_rich_content_results WHERE id=$1", [legacyId]);
    const legacyTerminalPreserved = before.rows[0].status === after.rows[0].status
      && JSON.stringify(before.rows[0].rich_content) === JSON.stringify(after.rows[0].rich_content)
      && before.rows[0].accepted_at.getTime() === after.rows[0].accepted_at.getTime()
      && after.rows[0].plan_hash === null && after.rows[0].lease_token === null;

    let nullAcceptedRejected = false;
    try {
      await client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,
           attempt_no,model_name,profile_version,prompt_template_version,rich_content,output_hash,
           checker_result,status,accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'text-model',1,'rich-v1','{"version":"x"}'::jsonb,
           $10,'{"accepted":true}'::jsonb,'ACCEPTED',NOW())`,
        [`null-accepted-${suffix}`, accountId, jobId, itemId, planId, profileId,
          hash("3"), hash("4"), hash("5"), hash("6")],
      );
    } catch (error) {
      nullAcceptedRejected = error?.code === "23514";
    }

    const inputHash = hash("7");
    const reservation = {
      accountId, jobId, itemId, planId, inputHash,
      planHash: hash("1"), sourceHash: hash("2"), factRegistryHash: hash("3"),
      assetHash: hash("4"), promptHash: hash("5"), profileId, profileVersion: 1,
      modelName: "text-model", promptTemplateVersion: "rich-v1",
      sourceFactEvidence: [{ factId: "fact.capacity", field: "capacity", kind: "CAPACITY", value: "500 мл", numericValue: 500, unit: "мл" }],
      assetEvidence: [
        { assetId: "asset-main", role: "MAIN", contentHash: hash("8"), objectKey: "immutable/main.png", objectKeyVersion: "v1" },
        ...Array.from({ length: 5 }, (_, index) => ({
          assetId: `asset-extra-${index + 1}`, role: "DETAIL", contentHash: hash(String(index + 10)),
          objectKey: `immutable/extra-${index + 1}.png`, objectKeyVersion: "v1",
        })),
      ],
      requestEvidence: { requestKey: `rich-${inputHash}`, schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1" },
      maxAttempts: 3,
    };
    const repository = createPostgresRichContentRepository({
      pool: client, token: () => `lease-${suffix}`, id: () => `rich-${suffix}`,
    });
    const lease = await repository.reserveRichContentAttempt(reservation);
    const concurrent = await repository.reserveRichContentAttempt(reservation);
    let wrongScopeRejected = false;
    try {
      await repository.completeRichContentAttempt({
        ...reservation, ...lease, accountId: `wrong-${accountId}`,
        richContent: { version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru", blocks: [] },
        outputHash: hash("9"), checkerResult: { accepted: true, validator: "AUTO_LISTING_RICH_CONTENT_V1", sourceFactIds: ["fact.capacity"], assetIds: ["asset-main"] }, gatewayRequestId: "gateway-rich",
        modelEvidence: { requestedTextModel: "text-model", gatewayReportedTextModel: "text-model", gatewayReportedTextModelPresent: true },
      });
    } catch (error) {
      wrongScopeRejected = error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID";
    }
    const accepted = await repository.completeRichContentAttempt({
      ...reservation, ...lease,
      richContent: { version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru", blocks: [{ type: "HERO_IMAGE", assetId: "asset-main" }] },
      outputHash: hash("9"), checkerResult: { accepted: true, validator: "AUTO_LISTING_RICH_CONTENT_V1", sourceFactIds: ["fact.capacity"], assetIds: ["asset-main"] }, gatewayRequestId: "gateway-rich",
      modelEvidence: { requestedTextModel: "text-model", gatewayReportedTextModel: "text-model", gatewayReportedTextModelPresent: true },
    });
    const replay = await repository.reserveRichContentAttempt(reservation);
    let duplicateRejected = false;
    try {
      await client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,source_fact_evidence,
           asset_evidence,gateway_request_id,accepted_at
         ) SELECT $1,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no+1,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,source_fact_evidence,
           asset_evidence,gateway_request_id,NOW()
         FROM ai_rich_content_results WHERE id=$2`,
        [`rich-duplicate-${suffix}`, accepted.id],
      );
    } catch (error) {
      duplicateRejected = error?.code === "23505";
    }

    return {
      migrationAppliedTwice: true,
      legacyTerminalPreserved,
      nullAcceptedRejected,
      fullScopeLeaseCas: lease.status === "RESERVED" && concurrent.status === "IN_PROGRESS" && wrongScopeRejected,
      acceptedReplayUnique: replay.status === "EXISTING_ACCEPTED" && duplicateRejected,
    };
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  }
}
