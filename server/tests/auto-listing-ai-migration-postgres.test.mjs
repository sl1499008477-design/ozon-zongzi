import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPostgresAssetCleanupRepository } from "../auto-listing-asset-cleanup-repository.mjs";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";

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
         prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,regeneration,gateway_request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'strategy-hash','config-hash','source-hash',$8,'planner',1,'template-v1','{"slots":[]}'::jsonb,'plan-hash',$9,$10::jsonb,$11::jsonb,$12)`,
      [
        overrides.id || plan,
        account,
        overrides.jobId || jobA,
        overrides.itemId || itemA,
        overrides.snapshotId || snapshotA,
        overrides.strategyId || strategyA,
        profile,
        overrides.inputHash || `input-${overrides.id || plan}`,
        overrides.visualGroupsHash || "a".repeat(64),
        JSON.stringify(overrides.visualGroups || { sourceHash: "source-hash", groups: [], reasonCodes: [], visualGroupsHash: "a".repeat(64) }),
        overrides.regeneration === undefined ? null : JSON.stringify(overrides.regeneration),
        overrides.gatewayRequestId === undefined ? "gateway-plan-1" : overrides.gatewayRequestId,
      ],
    );

    const insertAsset = (overrides = {}) => {
      const status = overrides.status || "PENDING";
      const attemptIdentityHash = overrides.attemptIdentityHash !== undefined ? overrides.attemptIdentityHash
        : status === "PENDING" ? null : overrides.inputHash || "a".repeat(64);
      const generationSize = overrides.generationSize !== undefined ? overrides.generationSize : status === "PENDING" ? null : "768x1024";
      const finalInputBoundAt = overrides.finalInputBoundAt !== undefined ? overrides.finalInputBoundAt
        : ["ACCEPTED", "REJECTED"].includes(status) ? new Date() : null;
      const inputHash = overrides.inputHash || (status === "PENDING" ? "asset-input" : attemptIdentityHash);
      return client.query(
      `INSERT INTO ai_generation_assets (
         id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,
         input_hash,attempt_no,status,gateway_request_id,checker_request_id,model_name,profile_version,prompt_hash,object_key_version,object_key,
         content_hash,content_type,width,height,checker_result,error_code,error_retryable,accepted_at,
         plan_hash,source_hash,strategy_hash,config_hash,visual_groups_hash,prompt_template_version,
         source_asset_evidence,model_evidence,regeneration,size_bytes,lease_token,lease_expires_at,
         attempt_identity_hash,generation_size,final_input_bound_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'visual-a',$7,'SELLING_POINT',$8,$9,$10,$11,$12,'image-model',$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb,$32::jsonb,$33::jsonb,$34,$35,$36,$37,$38,$39)`,
      [
        overrides.id,
        account,
        jobA,
        itemA,
        plan,
        profile,
        overrides.slotKey || "selling-point-1",
        inputHash,
        overrides.attemptNo || 1,
        status,
        overrides.gatewayRequestId ?? null,
        overrides.checkerRequestId ?? null,
        overrides.profileVersion || 1,
        overrides.promptHash ?? "prompt-hash",
        overrides.objectKeyVersion ?? null,
        overrides.objectKey ?? null,
        overrides.contentHash ?? null,
        overrides.contentType ?? null,
        overrides.width ?? null,
        overrides.height ?? null,
        JSON.stringify(overrides.checkerResult ?? {}),
        overrides.errorCode ?? null,
        overrides.errorRetryable ?? null,
        overrides.acceptedAt ?? null,
        overrides.planHash ?? null,
        overrides.sourceHash ?? null,
        overrides.strategyHash ?? null,
        overrides.configHash ?? null,
        overrides.visualGroupsHash ?? null,
        overrides.promptTemplateVersion ?? null,
        overrides.sourceAssetEvidence === undefined ? null : JSON.stringify(overrides.sourceAssetEvidence),
        overrides.modelEvidence === undefined ? null : JSON.stringify(overrides.modelEvidence),
        overrides.regeneration === undefined ? null : JSON.stringify(overrides.regeneration),
        overrides.sizeBytes ?? null,
        overrides.leaseToken ?? null,
        overrides.leaseExpiresAt ?? null,
        attemptIdentityHash,
        generationSize,
        finalInputBoundAt,
      ],
      );
    };

    const completeAcceptedAsset = (overrides = {}) => {
      const value = {
      status: "ACCEPTED",
      inputHash: "1".repeat(64),
      promptHash: "2".repeat(64),
      objectKeyVersion: "ATTEMPT_V2",
      contentHash: "3".repeat(64),
      contentType: "image/png",
      width: 768,
      height: 1024,
      checkerResult: { accepted: true },
      gatewayRequestId: "generation-request-1",
      checkerRequestId: "checker-request-1",
      planHash: "4".repeat(64),
      sourceHash: "5".repeat(64),
      strategyHash: "6".repeat(64),
      configHash: "7".repeat(64),
      visualGroupsHash: "8".repeat(64),
      promptTemplateVersion: "image-v1",
      sourceAssetEvidence: [{ assetId: "source-1", contentHash: "9".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123 }],
      modelEvidence: { requestedImageModel: "image-model" },
      regeneration: null,
      sizeBytes: 123,
      acceptedAt: new Date(),
      ...overrides,
      };
      value.attemptIdentityHash ??= value.inputHash;
      value.attemptNo ??= 1;
      value.objectKey ??= buildGeneratedAssetObjectKey({
        accountId: account, jobId: jobA, itemId: itemA, planId: plan,
        visualGroupKey: "visual-a", slotKey: value.slotKey || "selling-point-1",
        attemptIdentityHash: value.attemptIdentityHash, attemptNo: value.attemptNo,
        inputHash: value.inputHash, contentHash: value.contentHash,
      });
      return value;
    };

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
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/.test(file) && !file.startsWith("029_")).sort()) {
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
      const legacyCleanupInputHash = "b".repeat(64);
      const legacyCleanupContentHash = "c".repeat(64);
      const legacyCleanupObjectKey = `auto-listing/${[account, jobA, itemA, plan, "visual-a", "legacy-cleanup-slot"].map((value) => Buffer.from(value).toString("base64url")).join("/")}/${legacyCleanupInputHash}/${legacyCleanupContentHash}.png`;
      const legacyAcceptedInputHash = "f".repeat(64);
      await client.query(
        `INSERT INTO ai_generation_assets (
          id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
          attempt_no,status,gateway_request_id,model_name,profile_version,prompt_hash,object_key,content_hash,
          content_type,width,height,checker_result,accepted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'visual-a','upgrade-slot','SELLING_POINT',$7,1,'ACCEPTED',
          'legacy-gateway','image-model',1,'legacy-prompt','legacy/object.png',$8,'image/png',768,1024,'{"accepted":true}'::jsonb,NOW())`,
        [`legacy-accepted-${suffix}`, account, jobA, itemA, plan, profile, legacyAcceptedInputHash, "e".repeat(64)],
      );
      await client.query(
        `INSERT INTO ai_generation_assets (
          id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
          attempt_no,status,gateway_request_id,model_name,profile_version,prompt_hash,object_key,content_hash,
          content_type,width,height,checker_result,accepted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'visual-a','legacy-cleanup-slot','SELLING_POINT',$7,1,'ACCEPTED',
          'legacy-cleanup-gateway','image-model',1,'legacy-cleanup-prompt',$8,$9,'image/png',768,1024,'{"accepted":true}'::jsonb,NOW())`,
        [`legacy-cleanup-asset-${suffix}`, account, jobA, itemA, plan, profile, legacyCleanupInputHash, legacyCleanupObjectKey, legacyCleanupContentHash],
      );
      const legacyGeneratingInputHash = "0".repeat(64);
      for (const attemptNo of [1, 2, 3]) {
        await client.query(
          `INSERT INTO ai_generation_assets (
            id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
            attempt_no,status,model_name,profile_version,prompt_hash
          ) VALUES ($1,$2,$3,$4,$5,$6,'visual-a','legacy-generating-slot','SELLING_POINT',$7,$8,
            'GENERATING','image-model',1,'legacy-prompt')`,
          [`legacy-generating-${attemptNo}-${suffix}`, account, jobA, itemA, plan, profile, legacyGeneratingInputHash, attemptNo],
        );
      }
      await client.query(await readFile(path.join(migrationsDir, "029_auto_listing_ai_generation_evidence.sql"), "utf8"));
      await client.query(
        `INSERT INTO auto_listing_asset_cleanup_obligations (
           id,dedupe_key,account_id,job_id,item_id,plan_id,visual_group_key,slot_key,
           attempt_identity_hash,input_hash,attempt_no,object_key,content_hash,reason,original_error_code
         ) VALUES ($1,$2,$3,$4,$5,$6,'visual-a','legacy-cleanup-slot',$7,$8,1,$9,$10,'READBACK_FAILED','AUTO_LISTING_ASSET_STORAGE_UNVERIFIED')`,
        [`legacy-cleanup-${suffix}`, "d".repeat(64), account, jobA, itemA, plan, "a".repeat(64), legacyCleanupInputHash, legacyCleanupObjectKey, legacyCleanupContentHash],
      );
      const attemptIsolationMigration = await readFile(path.join(migrationsDir, "030_auto_listing_generated_asset_attempt_isolation.sql"), "utf8");
      await client.query(attemptIsolationMigration);
      await client.query(attemptIsolationMigration);
      const migratedLegacyAccepted = await client.query(
        "SELECT object_key_version,object_key FROM ai_generation_assets WHERE id=$1",
        [`legacy-accepted-${suffix}`],
      );
      assert.deepEqual(migratedLegacyAccepted.rows[0], { object_key_version: "LEGACY_V1", object_key: "legacy/object.png" });
      const migratedLegacyCleanup = await client.query(
        "SELECT object_key_version,status,object_key FROM auto_listing_asset_cleanup_obligations WHERE id=$1",
        [`legacy-cleanup-${suffix}`],
      );
      assert.deepEqual(migratedLegacyCleanup.rows[0], { object_key_version: "LEGACY_V1", status: "PENDING", object_key: legacyCleanupObjectKey });
      await assert.rejects(client.query(
        `INSERT INTO auto_listing_asset_cleanup_obligations (
           id,dedupe_key,account_id,job_id,item_id,plan_id,visual_group_key,slot_key,
           attempt_identity_hash,input_hash,attempt_no,object_key_version,object_key,content_hash,reason,original_error_code
         ) SELECT $1,$2,account_id,job_id,item_id,plan_id,visual_group_key,slot_key,
                  attempt_identity_hash,input_hash,attempt_no,'LEGACY_V1',object_key,content_hash,reason,original_error_code
           FROM auto_listing_asset_cleanup_obligations WHERE id=$3`,
        [`new-legacy-cleanup-${suffix}`, "e".repeat(64), `legacy-cleanup-${suffix}`],
      ), { code: "23514" });
      const cleanupRepository = createPostgresAssetCleanupRepository({ pool: client });
      const [legacyCleanupClaim] = await cleanupRepository.claimAssetCleanupObligations({
        accountId: account, workerId: "legacy-cleanup-worker", limit: 1, leaseMs: 60_000,
      });
      await assert.rejects(cleanupRepository.adoptAssetCleanupIfReferenced({
        accountId: `wrong-${account}`, id: legacyCleanupClaim.id, workerId: "legacy-cleanup-worker", claimToken: legacyCleanupClaim.claimToken,
      }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
      const legacyAdopted = await cleanupRepository.adoptAssetCleanupIfReferenced({
        accountId: account, id: legacyCleanupClaim.id, workerId: "legacy-cleanup-worker", claimToken: legacyCleanupClaim.claimToken,
      });
      assert.equal(legacyAdopted.status, "ADOPTED");
      assert.equal(legacyAdopted.record.adoptedGenerationAssetId, `legacy-cleanup-asset-${suffix}`);
      assert.equal(legacyAdopted.record.adoptedGenerationAssetStatus, "ACCEPTED");
      assert.equal(legacyAdopted.record.claimToken, null);
      const migratedLegacyGenerating = await client.query(
        `SELECT id,status,error_code,error_retryable,lease_token,lease_expires_at,attempt_identity_hash
         FROM ai_generation_assets WHERE slot_key='legacy-generating-slot' ORDER BY attempt_no`,
      );
      assert.deepEqual(migratedLegacyGenerating.rows, [1, 2, 3].map((attemptNo) => ({
        id: `legacy-generating-${attemptNo}-${suffix}`,
        status: "FAILED",
        error_code: "MIGRATION_029_LEGACY_GENERATING_TERMINATED",
        error_retryable: true,
        lease_token: null,
        lease_expires_at: null,
        attempt_identity_hash: null,
      })));
      await insertAsset({
        id: `new-after-legacy-${suffix}`, slotKey: "legacy-generating-slot", status: "GENERATING",
        inputHash: "1".repeat(64), attemptIdentityHash: "1".repeat(64), attemptNo: 1,
        leaseToken: "lease-new-after-legacy", leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await assert.rejects(insertAsset({
        id: `bound-collides-legacy-${suffix}`, slotKey: "upgrade-slot", status: "GENERATING",
        inputHash: legacyAcceptedInputHash, attemptIdentityHash: "d".repeat(64), attemptNo: 2, finalInputBoundAt: new Date(),
        leaseToken: "lease-upgrade", leaseExpiresAt: new Date(Date.now() + 60_000),
      }), { code: "23505" });
      const planEvidence = await client.query(
        "SELECT visual_groups_hash,visual_groups,regeneration,gateway_request_id FROM ai_content_plans WHERE id=$1",
        [plan],
      );
      assert.deepEqual(planEvidence.rows[0], {
        visual_groups_hash: "a".repeat(64),
        visual_groups: { sourceHash: "source-hash", groups: [], reasonCodes: [], visualGroupsHash: "a".repeat(64) },
        regeneration: null,
        gateway_request_id: "gateway-plan-1",
      });
      await assert.rejects(insertPlan({
        id: `invalid-plan-evidence-${suffix}`, visualGroupsHash: "not-a-hash",
      }), { code: "23514" });
      await assert.rejects(insertPlan({
        id: `invalid-plan-request-${suffix}`, gatewayRequestId: " request-with-space ",
      }), { code: "23514" });
      await assert.rejects(client.query(
        "UPDATE ai_content_plans SET gateway_request_id='changed' WHERE id=$1", [plan],
      ), /AI content plans are immutable/i);
      await assert.rejects(client.query("UPDATE ai_gateway_profiles SET base_url='https://changed.invalid' WHERE id=$1", [profile]), /referenced AI gateway profile configuration is immutable/i);
      await client.query(
        "UPDATE ai_gateway_profiles SET capability_result=$2::jsonb,capability_checked_at=NOW(),enabled=TRUE WHERE id=$1",
        [profile, JSON.stringify({ ok: true })],
      );

      await assert.rejects(insertAsset({ id: `asset-wrong-profile-${suffix}`, profileVersion: 2 }), { code: "23503" });
      await assert.rejects(insertResult({ id: `rich-wrong-profile-${suffix}`, profileVersion: 2 }), { code: "23503" });
      await assert.rejects(insertAsset({ id: `asset-incomplete-${suffix}`, status: "ACCEPTED", acceptedAt: new Date() }), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-wrong-v2-key-${suffix}`, objectKey: "auto-listing/v2/wrong/path.png" })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-attempt-identity-null-${suffix}`, attemptIdentityHash: null })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-generation-size-null-${suffix}`, generationSize: null })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-width-null-${suffix}`, width: null })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-height-null-${suffix}`, height: null })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-hash-invalid-${suffix}`, configHash: "not-a-hash" })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-source-empty-${suffix}`, sourceAssetEvidence: [] })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({
        id: `asset-source-null-type-${suffix}`,
        sourceAssetEvidence: [{ assetId: "source-1", contentHash: "9".repeat(64), contentType: null, width: 768, height: 1024, size: 123 }],
      })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({
        id: `asset-source-too-many-${suffix}`,
        sourceAssetEvidence: Array.from({ length: 8 }, (_, index) => ({ assetId: `source-${index + 1}`, contentHash: "9".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123 })),
      })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({
        id: `asset-source-duplicate-${suffix}`,
        sourceAssetEvidence: [
          { assetId: "source-1", contentHash: "9".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123 },
          { assetId: "source-1", contentHash: "a".repeat(64), contentType: "image/jpeg", width: 640, height: 640, size: 456 },
        ],
      })), { code: "23514" });
      await assert.rejects(insertAsset(completeAcceptedAsset({
        id: `asset-source-open-${suffix}`,
        sourceAssetEvidence: [{ assetId: "source-1", contentHash: "9".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123, unexpected: true }],
      })), { code: "23514" });
      await assert.rejects(insertAsset({ id: `asset-generating-no-lease-${suffix}`, status: "GENERATING", inputHash: "a".repeat(64) }), { code: "23514" });
      await assert.rejects(insertAsset({ id: `asset-generating-blank-lease-${suffix}`, status: "GENERATING", inputHash: "c".repeat(64), leaseToken: "   ", leaseExpiresAt: new Date(Date.now() + 60_000) }), { code: "23514" });
      await assert.rejects(insertAsset({ id: `asset-failed-null-binding-${suffix}`, status: "FAILED", inputHash: "d".repeat(64), attemptIdentityHash: null, generationSize: null, errorCode: "GATEWAY", errorRetryable: true }), { code: "23514" });
      await insertAsset({ id: `asset-generating-${suffix}`, status: "GENERATING", inputHash: "b".repeat(64), attemptNo: 1, leaseToken: "lease-1", leaseExpiresAt: new Date(Date.now() + 60_000) });
      await assert.rejects(insertAsset({ id: `asset-generating-duplicate-${suffix}`, status: "GENERATING", inputHash: "b".repeat(64), attemptNo: 2, leaseToken: "lease-2", leaseExpiresAt: new Date(Date.now() + 60_000) }), { code: "23505" });
      await assert.rejects(insertAsset({ id: `asset-terminal-has-lease-${suffix}`, status: "FAILED", inputHash: "c".repeat(64), errorCode: "GATEWAY", errorRetryable: true, leaseToken: "lease-3", leaseExpiresAt: new Date(Date.now() + 60_000) }), { code: "23514" });
      await insertAsset({ id: `asset-failed-${suffix}`, status: "FAILED", errorCode: "GATEWAY", errorRetryable: true });
      await assert.rejects(client.query("UPDATE ai_generation_assets SET status='PENDING' WHERE id=$1", [`asset-failed-${suffix}`]), /terminal AI generation assets are immutable/i);
      await assert.rejects(client.query("DELETE FROM ai_generation_assets WHERE id=$1", [`asset-failed-${suffix}`]), /terminal AI generation assets are immutable/i);
      await assert.rejects(insertAsset({ id: `asset-failed-duplicate-${suffix}`, status: "FAILED", errorCode: "GATEWAY", errorRetryable: true }), { code: "23505" });
      await insertAsset(completeAcceptedAsset({ id: `asset-accepted-${suffix}`, attemptNo: 2 }));
      await assert.rejects(insertAsset(completeAcceptedAsset({ id: `asset-second-accepted-${suffix}`, attemptNo: 3, contentHash: "a".repeat(64) })), { code: "23505" });

      const cleanupInput = {
        accountId: account, jobId: jobA, itemId: itemA, planId: plan, visualGroupKey: "visual-a", slotKey: "cleanup-slot",
        attemptIdentityHash: "a".repeat(64), inputHash: "b".repeat(64), attemptNo: 1, contentHash: "c".repeat(64),
        objectKeyVersion: "ATTEMPT_V2",
        reason: "RECORD_STORED_FAILED", originalErrorCode: "AUTO_LISTING_ASSET_REPOSITORY_FAILED",
      };
      cleanupInput.objectKey = buildGeneratedAssetObjectKey(cleanupInput);
      const cleanupFirst = await cleanupRepository.recordAssetCleanupRequired(cleanupInput);
      const cleanupRepeated = await cleanupRepository.recordAssetCleanupRequired(cleanupInput);
      assert.equal(cleanupRepeated.id, cleanupFirst.id);
      assert.equal((await cleanupRepository.listAssetCleanupObligations({ accountId: account })).length, 1);
      assert.deepEqual(await cleanupRepository.listAssetCleanupObligations({ accountId: `wrong-${account}` }), []);
      await assert.rejects(cleanupRepository.recordAssetCleanupRequired({ ...cleanupInput, reason: "OTHER_REASON" }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CONFLICT");
      const crossScopeCleanup = { ...cleanupInput, jobId: jobB, itemId: itemB, slotKey: "wrong-scope" };
      crossScopeCleanup.objectKey = buildGeneratedAssetObjectKey(crossScopeCleanup);
      await assert.rejects(cleanupRepository.recordAssetCleanupRequired(crossScopeCleanup), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_REPOSITORY_FAILED" && error?.retryable === true);

      const [cleanupClaim] = await cleanupRepository.claimAssetCleanupObligations({
        accountId: account, workerId: "cleanup-worker-a", limit: 1, leaseMs: 60_000,
      });
      assert.equal(cleanupClaim.id, cleanupFirst.id);
      assert.equal(cleanupClaim.status, "PROCESSING");
      assert.equal(cleanupClaim.attemptCount, 1);
      assert.deepEqual(await cleanupRepository.claimAssetCleanupObligations({
        accountId: account, workerId: "cleanup-worker-b", limit: 1, leaseMs: 60_000,
      }), []);
      assert.deepEqual(await cleanupRepository.claimAssetCleanupObligations({
        accountId: `wrong-${account}`, workerId: "cleanup-worker-b", limit: 1, leaseMs: 60_000,
      }), []);
      const cleanupFailed = await cleanupRepository.failAssetCleanup({
        accountId: account, id: cleanupClaim.id, workerId: "cleanup-worker-a", claimToken: cleanupClaim.claimToken,
        errorCode: "AUTO_LISTING_ASSET_REMOVE_FAILED",
      });
      assert.equal(cleanupFailed.status, "PENDING");
      assert.equal(cleanupFailed.attemptCount, 1);
      assert.equal(cleanupFailed.lastErrorCode, "AUTO_LISTING_ASSET_REMOVE_FAILED");
      assert.equal(new Date(cleanupFailed.nextRetryAt).getTime() - new Date(cleanupFailed.updatedAt).getTime(), 5 * 60_000);
      assert.deepEqual(await cleanupRepository.claimAssetCleanupObligations({
        accountId: account, workerId: "cleanup-worker-b", limit: 1, leaseMs: 60_000,
      }), []);
      await client.query(
        "UPDATE auto_listing_asset_cleanup_obligations SET next_retry_at=NOW()-INTERVAL '1 millisecond' WHERE account_id=$1 AND id=$2",
        [account, cleanupClaim.id],
      );
      const [cleanupReclaim] = await cleanupRepository.claimAssetCleanupObligations({
        accountId: account, workerId: "cleanup-worker-b", limit: 1, leaseMs: 60_000,
      });
      assert.equal(cleanupReclaim.attemptCount, 2);
      await assert.rejects(cleanupRepository.completeAssetCleanup({
        accountId: account, id: cleanupClaim.id, workerId: "cleanup-worker-a", claimToken: cleanupClaim.claimToken,
      }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");
      const cleanupCompleted = await cleanupRepository.completeAssetCleanup({
        accountId: account, id: cleanupReclaim.id, workerId: "cleanup-worker-b", claimToken: cleanupReclaim.claimToken,
      });
      assert.equal(cleanupCompleted.status, "COMPLETED");
      await assert.rejects(cleanupRepository.failAssetCleanup({
        accountId: account, id: cleanupReclaim.id, workerId: "cleanup-worker-b", claimToken: cleanupReclaim.claimToken,
        errorCode: "AUTO_LISTING_ASSET_REMOVE_FAILED",
      }), (error) => error?.code === "AUTO_LISTING_ASSET_CLEANUP_CLAIM_REJECTED");

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
