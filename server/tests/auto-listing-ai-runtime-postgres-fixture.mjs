import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import { buildSourceAssetObjectKey } from "../auto-listing-source-asset-store.mjs";
import { createPostgresSourceMaterializationRepository } from "../auto-listing-source-materialization-repository.mjs";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const hash = (character) => character.repeat(64);

async function rejectedCode(operation, code = "23514") {
  try { await operation(); } catch (error) { return error?.code === code; }
  return false;
}

export async function runAutoListingAiRuntimePostgresFixture({ connectionString } = {}) {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    throw new Error("A dedicated PostgreSQL connection string is required");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `auto_listing_runtime_032_${suffix}`;
  const accountA = `account-a-${suffix}`;
  const accountB = `account-b-${suffix}`;
  const storeA = `store-a-${suffix}`;
  const storeB = `store-b-${suffix}`;
  const warehouseA = `warehouse-a-${suffix}`;
  const warehouseB = `warehouse-b-${suffix}`;
  const snapshotA = `snapshot-a-${suffix}`;
  const snapshotB = `snapshot-b-${suffix}`;
  const strategyA = `strategy-a-${suffix}`;
  const strategyB = `strategy-b-${suffix}`;
  const jobA = `job-a-${suffix}`;
  const jobB = `job-b-${suffix}`;
  const itemA = `item-a-${suffix}`;
  const itemB = `item-b-${suffix}`;
  const profileA = `profile-a-${suffix}`;
  const profileB = `profile-b-${suffix}`;
  const planA = `plan-a-${suffix}`;
  const planB = `plan-b-${suffix}`;
  const legacyId = `legacy-${suffix}`;
  try {
    await clientA.query(`CREATE SCHEMA ${quote(schema)}`);
    for (const client of [clientA, clientB]) await client.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = (await readdir(migrationsDir))
      // 032 depends on the runtime tables/indexes present through 030. Migration
      // 031 owns the independent rich-content contract and is exercised by its
      // own disposable-PostgreSQL fixture.
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 30)
      .sort();
    for (const migration of migrations) {
      try {
        await clientA.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      } catch (error) {
        throw new Error(`fixture migration failed: ${migration} (${error?.code || "UNKNOWN"})`);
      }
    }

    for (const accountId of [accountA, accountB]) {
      await clientA.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [accountId, `user-${accountId}`],
      );
    }
    for (const values of [
      [accountA, storeA, warehouseA, snapshotA, strategyA, jobA, itemA, profileA, planA, "a"],
      [accountB, storeB, warehouseB, snapshotB, strategyB, jobB, itemB, profileB, planB, "b"],
    ]) {
      const [accountId, storeId, warehouseId, snapshotId, strategyId, jobId, itemId, profileId, planId, marker] = values;
      await clientA.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [storeId, `Store ${marker}`, `client-${marker}-${suffix}`, accountId],
      );
      await clientA.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [warehouseId, storeId, `warehouse-${marker}-${suffix}`],
      );
      await clientA.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,$3,1,'PUBLISHED','{}'::jsonb,$4)",
        [strategyId, accountId, `strategy-${marker}`, hash(marker)],
      );
      await clientA.query(
        "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::jsonb,$4)",
        [snapshotId, accountId, `record-${marker}`, hash(marker)],
      );
      await clientA.query(
        "INSERT INTO auto_listing_jobs (id,account_id,source_type,idempotency_key,config_hash,strategy_version_id) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5)",
        [jobId, accountId, `job-key-${marker}`, hash(marker), strategyId],
      );
      await clientA.query(
        "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version) VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_READY',3)",
        [itemId, jobId, accountId, snapshotId, storeId, warehouseId],
      );
      await clientA.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version
         ) VALUES ($1,$2,'Primary','https://gateway.invalid','AI_GATEWAY_KEY','SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',1)`,
        [profileId, accountId],
      );
      await clientA.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,strategy_hash,config_hash,
           source_hash,input_hash,planner_model,profile_version,prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8,'planner',1,'plan-v1','{}'::jsonb,$8,$8,
           '{"sourceHash":"source","groups":[],"reasonCodes":[],"visualGroupsHash":"hash"}'::jsonb,'request')`,
        [planId, accountId, jobId, itemId, snapshotId, strategyId, profileId, hash(marker)],
      );
    }

    await clientA.query(
      "INSERT INTO auto_listing_ai_outbox (id,account_id,job_id,item_id,event_type,dedupe_key,state) VALUES ($1,$2,$3,$4,'LEGACY_GENERATE',$5,'PENDING')",
      [legacyId, accountA, jobA, itemA, `legacy-${suffix}`],
    );
    const migration032 = await readFile(path.join(migrationsDir, "032_auto_listing_ai_runtime.sql"), "utf8");
    await clientA.query(migration032);
    await clientA.query(
      "ALTER TABLE auto_listing_source_object_cleanup_obligations DROP CONSTRAINT auto_listing_source_cleanup_materialization_asset_fkey",
    );
    await clientA.query(
      "ALTER TABLE auto_listing_source_materialization_attempts DROP CONSTRAINT auto_listing_source_materialization_attempt_scope_asset_key",
    );
    await clientA.query(migration032);
    const upgradedRuntimeConstraints = new Set((await clientA.query(
      `SELECT conname FROM pg_constraint WHERE conname IN (
         'auto_listing_source_materialization_attempt_scope_asset_key',
         'auto_listing_source_cleanup_materialization_asset_fkey'
       )`,
    )).rows.map((row) => row.conname));
    const migrationAppliedTwice = upgradedRuntimeConstraints.size === 2;
    const legacy = (await clientA.query("SELECT * FROM auto_listing_ai_outbox WHERE id=$1", [legacyId])).rows[0];
    const legacyOutboxPreserved = legacy.state === "PENDING" && legacy.contract_version === null && legacy.payload != null;
    const historicalProfiles = await clientA.query(
      "SELECT ai_profile_id,ai_profile_version FROM auto_listing_jobs WHERE id=ANY($1::text[]) ORDER BY id",
      [[jobA, jobB]],
    );
    const historicalJobProfilesPreserved = historicalProfiles.rows.length === 2
      && historicalProfiles.rows.every((row) => row.ai_profile_id === null && row.ai_profile_version === null);
    const jobProfilePairConstraint = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_jobs (
         id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id
       ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6)`,
      [`profile-half-${suffix}`, accountA, `profile-half-${suffix}`, hash("4"), strategyA, profileA],
    )) && await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_jobs (
         id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
       ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,0)`,
      [`profile-zero-${suffix}`, accountA, `profile-zero-${suffix}`, hash("4"), strategyA, profileA],
    ));
    const crossAccountProfileRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_jobs (
         id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
       ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
      [`profile-cross-${suffix}`, accountA, `profile-cross-${suffix}`, hash("4"), strategyA, profileB],
    ), "23503");
    const frozenProfileJob = `profile-frozen-${suffix}`;
    await clientA.query(
      `INSERT INTO auto_listing_jobs (
         id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
       ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
      [frozenProfileJob, accountA, `profile-frozen-${suffix}`, hash("4"), strategyA, profileA],
    );
    const frozenProfile = (await clientA.query(
      "SELECT ai_profile_id,ai_profile_version FROM auto_listing_jobs WHERE account_id=$1 AND id=$2",
      [accountA, frozenProfileJob],
    )).rows[0];
    const jobProfileAccountBoundary = crossAccountProfileRejected
      && frozenProfile?.ai_profile_id === profileA && frozenProfile?.ai_profile_version === 1;
    const jobProfileImmutable = await rejectedCode(() => clientA.query(
      "UPDATE auto_listing_jobs SET ai_profile_id=NULL,ai_profile_version=NULL WHERE account_id=$1 AND id=$2",
      [accountA, frozenProfileJob],
    ));
    const jobOnlyProfile = `profile-job-only-${suffix}`;
    await clientA.query(
      `INSERT INTO ai_gateway_profiles (
         id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
         text_model,image_model,config_version,enabled
       ) VALUES ($1,$2,'Job only','https://job-only.invalid','JOB_ONLY_AI_KEY',
         'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','job-text-model','job-image-model',1,TRUE)`,
      [jobOnlyProfile, accountA],
    );
    const jobOnlyProfileJob = `job-only-profile-${suffix}`;
    await clientA.query(
      `INSERT INTO auto_listing_jobs (
         id,account_id,source_type,idempotency_key,config_hash,strategy_version_id,ai_profile_id,ai_profile_version
       ) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5,$6,1)`,
      [jobOnlyProfileJob, accountA, `job-only-profile-${suffix}`, hash("5"), strategyA, jobOnlyProfile],
    );
    const jobReferencedProfileImmutable = await rejectedCode(() => clientA.query(
      "UPDATE ai_gateway_profiles SET base_url='https://changed.invalid' WHERE account_id=$1 AND id=$2 AND config_version=1",
      [accountA, jobOnlyProfile],
    )) && await rejectedCode(() => clientA.query(
      "DELETE FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
      [accountA, jobOnlyProfile],
    ), "23503");
    await clientA.query(
      `UPDATE ai_gateway_profiles
          SET capability_result='{"outcome":"PASSED"}'::jsonb,capability_checked_at=NOW(),enabled=FALSE
        WHERE account_id=$1 AND id=$2 AND config_version=1`,
      [accountA, jobOnlyProfile],
    );
    const operationalProfile = (await clientA.query(
      "SELECT capability_result,capability_checked_at,enabled FROM ai_gateway_profiles WHERE account_id=$1 AND id=$2 AND config_version=1",
      [accountA, jobOnlyProfile],
    )).rows[0];
    const jobReferencedProfileOperationalMutable = operationalProfile?.enabled === false
      && operationalProfile?.capability_checked_at != null
      && operationalProfile?.capability_result?.outcome === "PASSED";

    const nullPayloadRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,expected_status_version,correlation_id,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'null'::jsonb,'PENDING','V1','PLAN_CONTENT',3,'correlation',NOW())`,
      [`null-${suffix}`, accountA, jobA, itemA, hash("c")],
    ));
    const nullGuardPayload = {
      contractVersion: "V1", accountId: accountA, itemId: itemA, phase: "PLAN_CONTENT",
      expectedStatusVersion: 3, correlationId: `null-guard-${suffix}`,
    };
    const nullPhaseRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,
         expected_status_version,correlation_id,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,$6::JSONB,'PENDING','V1',NULL,3,$7,NOW())`,
      [`null-phase-${suffix}`, accountA, jobA, itemA, hash("1"), JSON.stringify(nullGuardPayload), nullGuardPayload.correlationId],
    ));
    const nullExpectedVersionRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,
         expected_status_version,correlation_id,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,$6::JSONB,'PENDING','V1','PLAN_CONTENT',NULL,$7,NOW())`,
      [`null-version-${suffix}`, accountA, jobA, itemA, hash("2"), JSON.stringify(nullGuardPayload), nullGuardPayload.correlationId],
    ));
    const nullCorrelationRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,
         expected_status_version,correlation_id,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,$6::JSONB,'PENDING','V1','PLAN_CONTENT',3,NULL,NOW())`,
      [`null-correlation-${suffix}`, accountA, jobA, itemA, hash("3"), JSON.stringify(nullGuardPayload)],
    ));
    const sqlNullRejected = nullPayloadRejected && nullPhaseRejected
      && nullExpectedVersionRejected && nullCorrelationRejected;
    const oversizedCorrelation = "界".repeat(81);
    const oversizedPayload = {
      contractVersion: "V1", accountId: accountA, itemId: itemA, phase: "PLAN_CONTENT",
      expectedStatusVersion: 3, correlationId: oversizedCorrelation,
    };
    const utf8BoundaryRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,
         expected_status_version,correlation_id,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,$6::JSONB,'PENDING','V1','PLAN_CONTENT',3,$7,NOW())`,
      [`utf8-${suffix}`, accountA, jobA, itemA, hash("d"), JSON.stringify(oversizedPayload), oversizedCorrelation],
    ));
    const unsafeCorrelation = "127.0.0.1";
    const unsafePayload = {
      contractVersion: "V1", accountId: accountA, itemId: itemA, phase: "PLAN_CONTENT",
      expectedStatusVersion: 3, correlationId: unsafeCorrelation,
    };
    const unsafeIdentifierRejected = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_ai_outbox (
         id,account_id,job_id,item_id,event_type,dedupe_key,payload,state,contract_version,phase,
         expected_status_version,correlation_id,next_retry_at
       ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,$6::JSONB,'PENDING','V1','PLAN_CONTENT',3,$7,NOW())`,
      [`unsafe-${suffix}`, accountA, jobA, itemA, hash("e"), JSON.stringify(unsafePayload), unsafeCorrelation],
    ));
    const accountBoundaryRejected = await rejectedCode(() => clientA.query(
      "UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND id=$3",
      [planB, accountA, itemA],
    ), "23503");

    const plannerAttemptId = `planner-attempt-${suffix}`;
    const materializationAttemptId = `materialization-attempt-${suffix}`;
    const materializationObjectKey = buildSourceAssetObjectKey({
      accountId: accountA, jobId: jobA, itemId: itemA, parentPlanId: planA, sourceAssetId: "source-a",
      sourceRefHash: hash("7"), inputHash: hash("8"), attemptNo: 1,
      contentHash: hash("a"), contentType: "image/png", objectKeyVersion: "SOURCE_V1",
    });
    const wrongSourceObjectKey = buildSourceAssetObjectKey({
      accountId: accountA, jobId: jobA, itemId: itemA, parentPlanId: planA, sourceAssetId: "source-b",
      sourceRefHash: hash("7"), inputHash: hash("8"), attemptNo: 1,
      contentHash: hash("a"), contentType: "image/png", objectKeyVersion: "SOURCE_V1",
    });
    const crossAccountObjectKey = buildSourceAssetObjectKey({
      accountId: accountB, jobId: jobB, itemId: itemB, parentPlanId: planB, sourceAssetId: "source-b",
      sourceRefHash: hash("7"), inputHash: hash("8"), attemptNo: 1,
      contentHash: hash("a"), contentType: "image/png", objectKeyVersion: "SOURCE_V1",
    });
    const runtimeTablesScoped = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_content_plan_attempts (
         id,account_id,job_id,item_id,source_snapshot_id,profile_id,profile_version,input_hash,attempt_no,
         expected_status_version,request_key,status,lease_owner,lease_token,lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,1,3,$8,'PLANNING','worker','lease',NOW()+INTERVAL '1 minute')`,
      [`cross-planner-${suffix}`, accountA, jobA, itemA, snapshotA, profileB, hash("6"), `auto-listing-plan-${hash("c")}`],
    ), "23503") && await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_source_materialization_attempts (
         id,account_id,job_id,item_id,parent_plan_id,source_asset_id,source_ref_hash,input_hash,attempt_no,
         status,lease_owner,lease_token,lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,'source-a',$6,$7,1,'MATERIALIZING','worker','lease',NOW()+INTERVAL '1 minute')`,
      [`cross-material-${suffix}`, accountA, jobA, itemA, planB, hash("7"), hash("8")],
    ), "23503");
    await clientA.query(
      `INSERT INTO auto_listing_content_plan_attempts (
         id,account_id,job_id,item_id,source_snapshot_id,profile_id,profile_version,input_hash,attempt_no,
         expected_status_version,request_key,status,lease_owner,lease_token,lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,1,3,$8,'PLANNING','worker','lease',NOW()+INTERVAL '1 minute')`,
      [plannerAttemptId, accountA, jobA, itemA, snapshotA, profileA, hash("6"), `auto-listing-plan-${hash("d")}`],
    );
    await clientA.query(
      `UPDATE auto_listing_content_plan_attempts
       SET status='FAILED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
         error_code='AUTO_LISTING_AI_PLAN_FAILED',error_retryable=TRUE,updated_at=NOW()
       WHERE id=$1`,
      [plannerAttemptId],
    );
    await clientA.query(
      `INSERT INTO auto_listing_source_materialization_attempts (
         id,account_id,job_id,item_id,parent_plan_id,source_asset_id,source_ref_hash,input_hash,attempt_no,
         status,lease_owner,lease_token,lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,'source-a',$6,$7,1,'MATERIALIZING','worker','lease',NOW()+INTERVAL '1 minute')`,
      [materializationAttemptId, accountA, jobA, itemA, planA, hash("7"), hash("8")],
    );
    await clientA.query(
      `UPDATE auto_listing_source_materialization_attempts
       SET status='FAILED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
         object_key_version='SOURCE_V1',object_key=$2,content_hash=$3,content_type='image/png',
         width=8,height=9,size_bytes=128,
         error_code='AUTO_LISTING_AI_MATERIALIZATION_FAILED',error_retryable=TRUE,updated_at=NOW()
       WHERE id=$1`,
      [materializationAttemptId, materializationObjectKey, hash("a")],
    );
    const terminalAttemptsImmutable = await rejectedCode(
      () => clientA.query("UPDATE auto_listing_content_plan_attempts SET updated_at=NOW() WHERE id=$1", [plannerAttemptId]),
    ) && await rejectedCode(
      () => clientA.query("UPDATE auto_listing_source_materialization_attempts SET updated_at=NOW() WHERE id=$1", [materializationAttemptId]),
    );

    const derivedPlanId = `derived-plan-${suffix}`;
    const materializationSetHash = hash("9");
    await clientA.query(
      `INSERT INTO ai_content_plans (
         id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,strategy_hash,config_hash,
         source_hash,input_hash,planner_model,profile_version,prompt_template_version,plan,plan_hash,
         visual_groups_hash,visual_groups,fact_registry_hash,fact_registry,regeneration,gateway_request_id,
         parent_plan_id,derivation_kind,materialization_set_hash
       )
       SELECT $1,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,strategy_hash,config_hash,
         source_hash,$2,planner_model,profile_version,prompt_template_version,plan,plan_hash,
         visual_groups_hash,visual_groups,fact_registry_hash,fact_registry,regeneration,gateway_request_id,
         id,'SOURCE_MATERIALIZATION',$3
       FROM ai_content_plans WHERE account_id=$4 AND id=$5`,
      [derivedPlanId, hash("0"), materializationSetHash, accountA, planA],
    );
    await clientA.query(
      `INSERT INTO auto_listing_content_plan_derivations (
         id,account_id,job_id,item_id,parent_plan_id,derived_plan_id,materialization_set_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`derivation-${suffix}`, accountA, jobA, itemA, planA, derivedPlanId, materializationSetHash],
    );
    await clientA.query(
      "UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND job_id=$3 AND id=$4",
      [derivedPlanId, accountA, jobA, itemA],
    );
    const activePlan = await clientA.query(
      "SELECT active_content_plan_id FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
      [accountA, itemA],
    );
    const derivedPlanActivated = activePlan.rows[0]?.active_content_plan_id === derivedPlanId;

    await clientA.query(
      `INSERT INTO auto_listing_source_object_cleanup_obligations (
         id,account_id,job_id,item_id,parent_plan_id,source_asset_id,materialization_attempt_id,
         source_ref_hash,input_hash,expected_status_version,attempt_no,lease_token,
         object_key_version,object_key,content_hash,content_type,width,height,size_bytes,
         reason_code,original_error_code
       ) VALUES ($1,$2,$3,$4,$5,'source-a',$6,$7,$8,1,1,'lease','SOURCE_V1',$9,$10,'image/png',8,9,128,
         'AUTO_LISTING_AI_SOURCE_ORPHANED','AUTO_LISTING_AI_MATERIALIZATION_FAILED')`,
      [`cleanup-${suffix}`, accountA, jobA, itemA, planA, materializationAttemptId,
        hash("7"), hash("8"), materializationObjectKey, hash("a")],
    );
    const cleanupRelationScoped = await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_source_object_cleanup_obligations (
         id,account_id,job_id,item_id,parent_plan_id,source_asset_id,materialization_attempt_id,
         source_ref_hash,input_hash,expected_status_version,attempt_no,lease_token,
         object_key_version,object_key,content_hash,content_type,width,height,size_bytes,
         reason_code,original_error_code
       ) VALUES ($1,$2,$3,$4,$5,'source-b',$6,$7,$8,1,1,'lease','SOURCE_V1',$9,$10,'image/png',8,9,128,
         'AUTO_LISTING_AI_SOURCE_ORPHANED','AUTO_LISTING_AI_MATERIALIZATION_FAILED')`,
      [`wrong-source-cleanup-${suffix}`, accountA, jobA, itemA, planA, materializationAttemptId,
        hash("7"), hash("8"), wrongSourceObjectKey, hash("a")],
    ), "23503") && await rejectedCode(() => clientA.query(
      `INSERT INTO auto_listing_source_object_cleanup_obligations (
         id,account_id,job_id,item_id,parent_plan_id,source_asset_id,materialization_attempt_id,
         source_ref_hash,input_hash,expected_status_version,attempt_no,lease_token,
         object_key_version,object_key,content_hash,content_type,width,height,size_bytes,
         reason_code,original_error_code
       ) VALUES ($1,$2,$3,$4,$5,'source-b',$6,$7,$8,1,1,'lease','SOURCE_V1',$9,$10,'image/png',8,9,128,
         'AUTO_LISTING_AI_SOURCE_ORPHANED','AUTO_LISTING_AI_MATERIALIZATION_FAILED')`,
      [`cross-cleanup-${suffix}`, accountB, jobB, itemB, planB, materializationAttemptId,
        hash("7"), hash("8"), crossAccountObjectKey, hash("a")],
    ), "23503");

    let sourceTokenSequence = 0;
    let sourceIdSequence = 0;
    let sourceDatabaseFailure = null;
    let sourceDatabaseStatement = null;
    const sourcePool = {
      async query(...arguments_) {
        try { return await clientA.query(...arguments_); } catch (error) {
          sourceDatabaseFailure = error;
          sourceDatabaseStatement = arguments_[0];
          throw error;
        }
      },
    };
    const sourceRepository = createPostgresSourceMaterializationRepository({
      pool: sourcePool,
      token: () => `source-lease-${++sourceTokenSequence}-${suffix}`,
      id: () => `source-record-${++sourceIdSequence}-${suffix}`,
    });
    const acceptedScope = {
      accountId: accountA, jobId: jobA, itemId: itemA, parentPlanId: planA,
      sourceAssetId: `repository-source-a-${suffix}`, sourceRefHash: hash("d"),
      inputHash: hash("e"), expectedStatusVersion: 3,
    };
    let acceptedLease;
    try {
      acceptedLease = await sourceRepository.reserveSourceMaterialization({ ...acceptedScope, maxAttempts: 3 });
    } catch {
      throw new Error(`source materialization fixture reserve failed (${sourceDatabaseFailure?.code || "UNKNOWN"}:${sourceDatabaseFailure?.constraint || "NONE"}:${sourceDatabaseFailure?.message || "NONE"}:${String(sourceDatabaseStatement).slice(0, 80)})`);
    }
    const acceptedEvidence = {
      ...acceptedScope, attemptId: acceptedLease.attemptId, attemptNo: acceptedLease.attemptNo,
      leaseToken: acceptedLease.leaseToken, objectKeyVersion: "SOURCE_V1", contentHash: hash("f"),
      contentType: "image/png", width: 9, height: 12, sizeBytes: 256,
    };
    acceptedEvidence.objectKey = buildSourceAssetObjectKey(acceptedEvidence);
    await sourceRepository.recordStoredSourceMaterialization(acceptedEvidence);
    const acceptedMaterialization = await sourceRepository.completeSourceMaterialization(acceptedEvidence);
    const acceptedReplay = await sourceRepository.reserveSourceMaterialization({ ...acceptedScope, maxAttempts: 3 });
    const acceptedList = await sourceRepository.listAcceptedSourceMaterializations({
      accountId: accountA, jobId: jobA, itemId: itemA, parentPlanId: planA,
      expectedStatusVersion: acceptedScope.expectedStatusVersion,
    });
    const sourceRepositoryAcceptedReplay = acceptedMaterialization.status === "ACCEPTED"
      && acceptedReplay.status === "EXISTING_ACCEPTED"
      && acceptedReplay.record.attemptId === acceptedMaterialization.attemptId
      && acceptedList.some((row) => row.attemptId === acceptedMaterialization.attemptId);

    const staleReservation = await sourceRepository.reserveSourceMaterialization({
      ...acceptedScope, sourceAssetId: `repository-stale-${suffix}`, expectedStatusVersion: 4, maxAttempts: 3,
    });
    const sourceRepositoryStaleBeforeAttempt = staleReservation.status === "STALE"
      && Number((await clientA.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_source_materialization_attempts WHERE account_id=$1 AND source_asset_id=$2",
        [accountA, `repository-stale-${suffix}`],
      )).rows[0].count) === 0;

    const abaScope = {
      ...acceptedScope, sourceAssetId: `repository-aba-${suffix}`, sourceRefHash: hash("b"), inputHash: hash("c"),
    };
    const firstAbaLease = await sourceRepository.reserveSourceMaterialization({ ...abaScope, maxAttempts: 3 });
    await clientA.query(
      "UPDATE auto_listing_source_materialization_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [firstAbaLease.attemptId],
    );
    const secondAbaLease = await sourceRepository.reserveSourceMaterialization({ ...abaScope, maxAttempts: 3 });
    let staleAbaRejected = false;
    try {
      await sourceRepository.failSourceMaterialization({
        ...abaScope, attemptId: firstAbaLease.attemptId, attemptNo: firstAbaLease.attemptNo,
        leaseToken: firstAbaLease.leaseToken, errorCode: "AUTO_LISTING_SOURCE_IMAGE_INVALID", errorRetryable: false,
      });
    } catch (error) {
      staleAbaRejected = error?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
    }
    const sourceRepositoryAbaFence = secondAbaLease.status === "RESERVED"
      && secondAbaLease.attemptNo === 2 && secondAbaLease.leaseToken !== firstAbaLease.leaseToken
      && staleAbaRejected;

    const cleanupScope = {
      ...acceptedScope, sourceAssetId: `repository-cleanup-${suffix}`, sourceRefHash: hash("1"), inputHash: hash("2"),
    };
    const cleanupLease = await sourceRepository.reserveSourceMaterialization({ ...cleanupScope, maxAttempts: 3 });
    const cleanupEvidence = {
      ...cleanupScope, materializationAttemptId: cleanupLease.attemptId, attemptNo: cleanupLease.attemptNo,
      leaseToken: cleanupLease.leaseToken, objectKeyVersion: "SOURCE_V1", contentHash: hash("3"),
      contentType: "image/png", width: 9, height: 12, sizeBytes: 256,
      reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
      originalErrorCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED",
    };
    cleanupEvidence.objectKey = buildSourceAssetObjectKey(cleanupEvidence);
    let cleanupRequired;
    try {
      cleanupRequired = await sourceRepository.recordSourceObjectCleanupRequired(cleanupEvidence);
    } catch {
      throw new Error(`source cleanup fixture failed (${sourceDatabaseFailure?.code || "UNKNOWN"}:${sourceDatabaseFailure?.constraint || "NONE"}:${sourceDatabaseFailure?.message || "NONE"}:${String(sourceDatabaseStatement).slice(0, 80)})`);
    }
    const cleanupReplay = await sourceRepository.recordSourceObjectCleanupRequired(cleanupEvidence);
    const untouchedAttempt = (await clientA.query(
      "SELECT status,object_key,content_hash FROM auto_listing_source_materialization_attempts WHERE id=$1",
      [cleanupLease.attemptId],
    )).rows[0];
    const sourceRepositoryOrphanCleanup = cleanupRequired.status === "PENDING"
      && cleanupReplay.id === cleanupRequired.id && untouchedAttempt.status === "MATERIALIZING"
      && untouchedAttempt.object_key === null && untouchedAttempt.content_hash === null;

    const message = { contractVersion: "V1", accountId: accountA, itemId: itemA, phase: "PLAN_CONTENT", expectedStatusVersion: 3, correlationId: `corr-${suffix}` };
    const payloadDiagnostic = await clientA.query(
      "SELECT auto_listing_ai_outbox_payload_valid($1::JSONB,'V1',$2,$3,'PLAN_CONTENT',NULL,3,$4) AS valid",
      [JSON.stringify(message), accountA, itemA, message.correlationId],
    );
    if (payloadDiagnostic.rows[0]?.valid !== true) {
      const parts = await clientA.query(
        `SELECT jsonb_typeof($1::JSONB) AS root_type,
          (SELECT COUNT(*) FROM jsonb_object_keys($1::JSONB)) AS key_count,
          jsonb_typeof($1::JSONB->'expectedStatusVersion') AS version_type,
          ($1::JSONB->>'expectedStatusVersion')::INTEGER AS version_value,
          OCTET_LENGTH('{"accountId":' || TO_JSONB($1::JSONB->>'accountId')::TEXT
            || ',"contractVersion":' || TO_JSONB($1::JSONB->>'contractVersion')::TEXT
            || ',"correlationId":' || TO_JSONB($1::JSONB->>'correlationId')::TEXT
            || ',"expectedStatusVersion":' || ($1::JSONB->>'expectedStatusVersion')
            || ',"itemId":' || TO_JSONB($1::JSONB->>'itemId')::TEXT
            || ',"phase":' || TO_JSONB($1::JSONB->>'phase')::TEXT || '}') AS canonical_size,
          auto_listing_ai_runtime_safe_identifier($2) AS account_safe,
          auto_listing_ai_runtime_safe_identifier($3) AS item_safe,
          auto_listing_ai_runtime_safe_identifier($4) AS correlation_safe`,
        [JSON.stringify(message), accountA, itemA, message.correlationId],
      );
      throw new Error(`valid fixture message was rejected by SQL payload validator: ${JSON.stringify(parts.rows[0])}`);
    }
    let lastDatabaseFailure = null;
    const diagnosticClient = (client) => ({
      async query(...args) {
        try { return await client.query(...args); } catch (error) { lastDatabaseFailure = error; throw error; }
      },
    });
    const repoA = createPostgresAiOutboxRepository({ pool: diagnosticClient(clientA), token: () => `token-a-${suffix}`, id: () => `outbox-${suffix}` });
    const repoB = createPostgresAiOutboxRepository({ pool: diagnosticClient(clientB), token: () => `token-b-${suffix}`, id: () => `other-${suffix}` });
    let inserted;
    try { inserted = await repoA.enqueueAutoListingAiMessage(message); } catch {
      throw new Error(`outbox fixture query failed (${lastDatabaseFailure?.code || "UNKNOWN"}:${lastDatabaseFailure?.constraint || "NONE"})`);
    }
    const replay = await repoB.enqueueAutoListingAiMessage(message);
    const deterministicReplay = inserted.id === replay.id && inserted.dedupeKey === replay.dedupeKey;
    const firstClaim = await repoA.claimAutoListingAiMessages({ accountId: accountA, workerId: "worker-a", limit: 10, leaseMs: 60_000 });
    const secondClaim = await repoB.claimAutoListingAiMessages({ accountId: accountA, workerId: "worker-b", limit: 10, leaseMs: 60_000 });
    const claimed = firstClaim.find((row) => row.id === inserted.id);
    const oneLeaseOnly = Boolean(claimed) && !secondClaim.some((row) => row.id === inserted.id);
    await clientA.query("UPDATE auto_listing_ai_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [inserted.id]);
    const reclaimed = (await repoB.claimAutoListingAiMessages({ accountId: accountA, workerId: "worker-b", limit: 10, leaseMs: 60_000 }))
      .find((row) => row.id === inserted.id);
    const expiredLeaseReclaimed = Boolean(reclaimed) && reclaimed.leaseToken !== claimed.leaseToken;
    let wrongItemRejected = false;
    try {
      await repoB.completeAutoListingAiMessage({ accountId: accountA, itemId: itemB, id: inserted.id, workerId: "worker-b", leaseToken: reclaimed.leaseToken });
    } catch (error) { wrongItemRejected = error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED"; }
    let staleLeaseRejected = false;
    try {
      await repoA.completeAutoListingAiMessage({ accountId: accountA, itemId: itemA, id: inserted.id, workerId: "worker-a", leaseToken: claimed.leaseToken });
    } catch (error) { staleLeaseRejected = error?.code === "AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED"; }
    let completed;
    try {
      completed = await repoB.completeAutoListingAiMessage({ accountId: accountA, itemId: itemA, id: inserted.id, workerId: "worker-b", leaseToken: reclaimed.leaseToken });
    } catch {
      throw new Error(`complete fixture query failed (${lastDatabaseFailure?.code || "UNKNOWN"}:${lastDatabaseFailure?.constraint || "NONE"})`);
    }
    const terminalImmutable = completed.status === "COMPLETED" && await rejectedCode(
      () => clientA.query("UPDATE auto_listing_ai_outbox SET correlation_id='changed' WHERE id=$1", [inserted.id]),
    );

    return {
      migrationAppliedTwice, legacyOutboxPreserved, sqlNullRejected, utf8BoundaryRejected, unsafeIdentifierRejected, accountBoundaryRejected,
      oneLeaseOnly, expiredLeaseReclaimed, staleLeaseRejected, wrongItemRejected, deterministicReplay, terminalImmutable,
      runtimeTablesScoped, terminalAttemptsImmutable, derivedPlanActivated, cleanupRelationScoped,
      sourceRepositoryAcceptedReplay, sourceRepositoryStaleBeforeAttempt,
      sourceRepositoryAbaFence, sourceRepositoryOrphanCleanup,
      historicalJobProfilesPreserved, jobProfilePairConstraint, jobProfileAccountBoundary,
      jobProfileImmutable,
      jobReferencedProfileImmutable, jobReferencedProfileOperationalMutable,
    };
  } finally {
    try { await clientA.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); } catch {}
    clientA.release();
    clientB.release();
    await pool.end();
  }
}
