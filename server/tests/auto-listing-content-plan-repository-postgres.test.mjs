import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresContentPlanRepository } from "../auto-listing-content-plan-repository.mjs";
import { createPostgresContentPlanEvidenceRepository } from "../auto-listing-content-plan-evidence-postgres.mjs";
import { createPostgresAutoListingPlanDiagnosticRepository } from "../auto-listing-plan-diagnostic-postgres.mjs";

const dedicatedDatabaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(dedicatedDatabaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

if (!enabled) {
  test("content-plan repository PostgreSQL behavior requires both explicit nonproduction gates", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("PostgreSQL serializes planning, fences ABA/version, and atomically activates explicit parent and derived plans", { timeout: 30_000 }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dedicatedDatabaseUrl, max: 1 });
    const admin = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_plan_repo_${suffix}`;
    const schemaSql = quoteIdentifier(schema);
    const ids = Object.fromEntries(["account", "store", "warehouse", "strategy", "snapshot", "job", "item", "profile"]
      .map((key) => [key, `${key}-${suffix}`]));
    ids.connectionA = `connection-a-${suffix}`;
    ids.connectionB = `connection-b-${suffix}`;
    let scopedPool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      scopedPool = new Pool({
        connectionString: dedicatedDatabaseUrl,
        max: 4,
        options: `-c search_path=${schema},public`,
      });
      await admin.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [ids.account, `user-${suffix}`],
      );
      for (const [connectionId, marker] of [[ids.connectionA, "a"], [ids.connectionB, "b"]]) {
        await admin.query(
          `INSERT INTO ai_gateway_connection_versions (
             account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
             fingerprint,status,status_version,idempotency_key,request_hash,correlation_id,created_by
           ) VALUES ($1,$2,1,$2,'https://gateway.invalid','cipher','iv','tag','aes-256-gcm','key-1',
             $3,'PENDING',1,$4,$5,$6,$1)`,
          [ids.account, connectionId, marker.repeat(64), `connection-key-${connectionId}`,
            hash({ connectionId }), `correlation-${connectionId}`],
        );
        const validation = { outcome: "PASSED", connectionId, connectionVersion: 1 };
        const validated = await admin.query(
          `UPDATE ai_gateway_connection_versions
              SET status='VALIDATED',status_version=2,validation_result=$3::JSONB,validation_hash=$4,
                  validated_at=NOW(),validated_by=$1
            WHERE account_id=$1 AND id=$2 AND version=1 AND status='PENDING' AND status_version=1`,
          [ids.account, connectionId, JSON.stringify(validation), hash(validation)],
        );
        assert.equal(validated.rowCount, 1);
      }
      const activated = await admin.query(
        `UPDATE ai_gateway_connection_versions
            SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1 AND status='VALIDATED' AND status_version=2`,
        [ids.account, ids.connectionA],
      );
      assert.equal(activated.rowCount, 1);
      await admin.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [ids.store, `Store ${suffix}`, `client-${suffix}`, ids.account],
      );
      await admin.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [ids.warehouse, ids.store, `platform-${suffix}`],
      );
      await admin.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3)",
        [ids.strategy, ids.account, "strategy-hash"],
      );
      await admin.query(
        "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
        [ids.snapshot, ids.account, `record-${suffix}`, "source-hash"],
      );
      await admin.query(
        "INSERT INTO auto_listing_jobs (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,correlation_id) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,'{}'::JSONB,$4,$5,$6)",
        [ids.job, ids.account, `idem-${suffix}`, "config-hash", ids.strategy, `corr-${suffix}`],
      );
      await admin.query(
        "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)",
        [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled
         ) VALUES ($1,$2,'Profile','http://127.0.0.1:3001','TEST_AI_KEY','SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','planner-model','image-model',3,TRUE)`,
        [ids.profile, ids.account],
      );

      const repository = createPostgresContentPlanRepository({
        pool: scopedPool,
        leaseMs: 60_000,
        token: (() => { let next = 0; return () => `lease-${++next}-${suffix}`; })(),
        id: (() => { let next = 0; return () => `attempt-${++next}-${suffix}`; })(),
        planId: () => `plan-parent-${suffix}`,
        derivationId: () => `derivation-${suffix}`,
      });
      const request = {
        accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
        profileId: ids.profile, profileVersion: 3, inputHash: "a".repeat(64), expectedStatusVersion: 7,
        planningContract: "LEGACY_FULL_PLAN_V3",
        skeletonHash: null,
        requestKey: `auto-listing-plan-${"b".repeat(64)}`,
        gatewayConnectionId: ids.connectionA,
        gatewayConnectionVersion: 1,
      };
      const claimed = await Promise.all([repository.reserveContentPlan(request), repository.reserveContentPlan(request)]);
      assert.deepEqual(claimed.map((entry) => entry.status).sort(), ["IN_PROGRESS", "RESERVED"]);
      let owner = claimed.find((entry) => entry.status === "RESERVED");
      const channelRelease = (lease, overrides = {}) => ({
        ...request,
        attemptId: lease.attemptId,
        reservationToken: lease.reservationToken,
        errorCode: "AUTO_LISTING_CONTENT_PLAN_CHANNEL_RELEASED",
        ...overrides,
      });
      for (const mutation of [
        { accountId: `foreign-${ids.account}` },
        { itemId: `foreign-${ids.item}` },
        { attemptId: `foreign-${owner.attemptId}` },
        { reservationToken: `stale-${owner.reservationToken}` },
        { profileVersion: 2 },
        { requestKey: `auto-listing-plan-${"c".repeat(64)}` },
      ]) {
        await assert.rejects(
          repository.releaseContentPlanChannelReservation(channelRelease(owner, mutation)),
          (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT",
        );
      }
      assert.deepEqual((await admin.query(
        `SELECT status,attempt_no,lease_owner,lease_token,error_code,error_retryable
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND input_hash=$4`,
        [ids.account, ids.job, ids.item, request.inputHash],
      )).rows, [{
        status: "PLANNING", attempt_no: 1, lease_owner: "auto-listing-content-planner",
        lease_token: owner.reservationToken, error_code: null, error_retryable: null,
      }]);
      assert.deepEqual(await repository.releaseContentPlanChannelReservation(channelRelease(owner)), {
        released: true, attemptId: owner.attemptId, attemptNo: 1,
      });
      const reclaimedConcurrently = await Promise.all([
        repository.reserveContentPlan(request), repository.reserveContentPlan(request),
      ]);
      assert.deepEqual(reclaimedConcurrently.map((entry) => entry.status).sort(), ["IN_PROGRESS", "RESERVED"]);
      owner = reclaimedConcurrently.find((entry) => entry.status === "RESERVED");
      assert.equal(owner.attemptNo, 1);
      for (let releaseNo = 1; releaseNo < 4; releaseNo += 1) {
        assert.equal((await repository.releaseContentPlanChannelReservation(channelRelease(owner))).released, true);
        const nextOwner = await repository.reserveContentPlan(request);
        assert.equal(nextOwner.status, "RESERVED");
        assert.equal(nextOwner.attemptId, owner.attemptId);
        assert.equal(nextOwner.attemptNo, 1);
        assert.notEqual(nextOwner.reservationToken, owner.reservationToken);
        owner = nextOwner;
      }
      assert.deepEqual((await admin.query(
        `SELECT status,attempt_no,lease_owner,lease_token,error_code,error_retryable
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND input_hash=$4`,
        [ids.account, ids.job, ids.item, request.inputHash],
      )).rows, [{
        status: "PLANNING", attempt_no: 1, lease_owner: "auto-listing-content-planner",
        lease_token: owner.reservationToken, error_code: null, error_retryable: null,
      }]);
      const businessIds = {
        snapshot: `snapshot-business-${suffix}`,
        job: `job-business-${suffix}`,
        item: `item-business-${suffix}`,
      };
      await admin.query(
        "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
        [businessIds.snapshot, ids.account, `record-business-${suffix}`, "source-hash-business"],
      );
      await admin.query(
        "INSERT INTO auto_listing_jobs (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,correlation_id) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,'{}'::JSONB,$4,$5,$6)",
        [businessIds.job, ids.account, `idem-business-${suffix}`, "config-hash-business", ids.strategy, `corr-business-${suffix}`],
      );
      await admin.query(
        "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)",
        [businessIds.item, businessIds.job, ids.account, businessIds.snapshot, ids.store, ids.warehouse],
      );
      let businessSequence = 0;
      const businessRepository = createPostgresContentPlanRepository({
        pool: scopedPool,
        token: () => `business-lease-${++businessSequence}-${suffix}`,
        id: () => `business-attempt-${businessSequence}-${suffix}`,
      });
      const businessRequest = {
        ...request,
        jobId: businessIds.job,
        itemId: businessIds.item,
        sourceSnapshotId: businessIds.snapshot,
        inputHash: "d".repeat(64),
        requestKey: `auto-listing-plan-${"e".repeat(64)}`,
      };
      for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
        const businessOwner = await businessRepository.reserveContentPlan(businessRequest);
        assert.equal(businessOwner.attemptNo, attemptNo);
        assert.deepEqual(await businessRepository.releaseContentPlanReservation({
          accountId: ids.account, jobId: businessIds.job, itemId: businessIds.item,
          inputHash: businessRequest.inputHash, expectedStatusVersion: 7,
          reservationToken: businessOwner.reservationToken,
          errorCode: "AUTO_LISTING_CONTENT_PLAN_BUSINESS_FAILED",
          gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
        }), { released: true });
      }
      await assert.rejects(
        businessRepository.reserveContentPlan(businessRequest),
        (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_ATTEMPTS_EXHAUSTED",
      );
      assert.deepEqual((await admin.query(
        `SELECT status,attempt_no,error_code FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 ORDER BY attempt_no`,
        [ids.account, businessIds.job, businessIds.item],
      )).rows, [1, 2, 3].map((attemptNo) => ({
        status: "FAILED", attempt_no: attemptNo,
        error_code: "AUTO_LISTING_CONTENT_PLAN_BUSINESS_FAILED",
      })));
      const plan = { version: 1, language: "ru", slots: [] };
      const facts = [{ factId: "fact-a", kind: "IDENTITY_NAME", value: "Товар", sourcePath: "identity.name", visualGroupKeys: [] }];
      const visualGroups = {
        sourceHash: "1".repeat(64),
        groups: [{
          visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"],
          referenceImages: [{
            assetId: "source-a", sourceRefHash: "9".repeat(64), sourceRef: null,
            contentHash: null, evidenceKind: "SOURCE_REF_HASH",
          }],
          factEvidence: [], reasonCodes: [],
        }],
        reasonCodes: [], visualGroupsHash: "4".repeat(64),
      };
      const evidenceRepository = createPostgresContentPlanEvidenceRepository({
        pool: scopedPool,
        responseId: () => `response-${suffix}`,
        validationId: () => `validation-${suffix}`,
      });
      const recordedResponse = await evidenceRepository.recordResponse({
        accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
        owner: { kind: "ATTEMPT", id: owner.attemptId }, planningContract: "LEGACY_FULL_PLAN_V3",
        inputHash: request.inputHash, skeletonHash: null, profileId: ids.profile, profileVersion: 3,
        modelName: "planner-model", promptTemplateVersion: "planner-v1",
        gatewayRequestId: "gateway-request-a", response: plan,
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      const expiredPlanLease = await admin.query(
        `UPDATE auto_listing_content_plan_attempts SET lease_expires_at=NOW()-INTERVAL '1 second'
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND input_hash=$4
            AND id=$5 AND lease_token=$6`,
        [ids.account, ids.job, ids.item, request.inputHash, owner.attemptId, owner.reservationToken],
      );
      assert.equal(expiredPlanLease.rowCount, 1);
      const resumed = await repository.reserveContentPlan(request);
      assert.equal(resumed.status, "RESERVED");
      assert.equal(resumed.attemptId, owner.attemptId);
      assert.equal(resumed.plannerStage, "FILLING_COPY");
      owner = resumed;
      await repository.advanceContentPlanStage({
        accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
        attemptId: owner.attemptId, inputHash: request.inputHash, expectedStatusVersion: 7,
        reservationToken: owner.reservationToken, planningContract: "LEGACY_FULL_PLAN_V3",
        skeletonHash: null, fromStage: "FILLING_COPY", toStage: "VALIDATING_COPY",
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      await evidenceRepository.recordValidation({
        accountId: ids.account, responseId: recordedResponse.id, status: "ACCEPTED",
        validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1", issues: [],
      });
      const diagnosticRepository = createPostgresAutoListingPlanDiagnosticRepository({ pool: scopedPool });
      const diagnostic = await diagnosticRepository.loadLatest({
        accountId: ids.account, jobId: ids.job, itemId: ids.item,
      });
      assert.deepEqual({
        responseId: diagnostic.responseId,
        attemptId: diagnostic.attemptId,
        planningContract: diagnostic.planningContract,
        validationStatus: diagnostic.validation.status,
      }, {
        responseId: recordedResponse.id,
        attemptId: owner.attemptId,
        planningContract: "LEGACY_FULL_PLAN_V3",
        validationStatus: "ACCEPTED",
      });
      assert.equal(await diagnosticRepository.loadLatest({
        accountId: `foreign-${suffix}`, jobId: ids.job, itemId: ids.item,
      }), null);
      assert.equal(await diagnosticRepository.loadLatest({
        accountId: ids.account, jobId: ids.job, itemId: `foreign-item-${suffix}`,
      }), null);
      const recordedOutcome = await evidenceRepository.loadOutcome({
        accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
        owner: { kind: "ATTEMPT", id: owner.attemptId }, planningContract: "LEGACY_FULL_PLAN_V3",
        inputHash: request.inputHash, skeletonHash: null, profileId: ids.profile, profileVersion: 3,
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      assert.equal(recordedOutcome.response.id, recordedResponse.id);
      assert.equal(recordedOutcome.validation.status, "ACCEPTED");
      const stored = await repository.saveContentPlan({
        ...request,
        reservationToken: owner.reservationToken,
        strategyVersionId: ids.strategy,
        sourceHash: "1".repeat(64),
        strategyHash: "2".repeat(64),
        configHash: "3".repeat(64),
        visualGroupsHash: "4".repeat(64),
        visualGroups,
        factRegistryHash: hash(facts),
        factRegistry: facts,
        plannerModel: "planner-model",
        promptTemplateVersion: "planner-v1",
        regeneration: null,
        gatewayRequestId: "gateway-request-a",
        plan,
        planHash: hash(plan),
      });
      assert.equal(stored.id, `plan-parent-${suffix}`);
      const frozenContract = await admin.query(
        `SELECT planning_contract,planner_stage,skeleton_hash
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3`,
        [ids.account, ids.job, ids.item],
      );
      assert.deepEqual(frozenContract.rows, [{
        planning_contract: "LEGACY_FULL_PLAN_V3", planner_stage: "COMPLETED", skeleton_hash: null,
      }]);
      await assert.rejects(admin.query(
        "UPDATE auto_listing_content_plan_responses SET gateway_request_id='forged' WHERE account_id=$1 AND id=$2",
        [ids.account, recordedResponse.id],
      ), (error) => error?.code === "23514");
      await assert.rejects(admin.query(
        `INSERT INTO auto_listing_content_plan_attempts (
           id,account_id,job_id,item_id,source_snapshot_id,profile_id,profile_version,input_hash,
           attempt_no,status,lease_owner,lease_token,lease_expires_at,expected_status_version,
           request_key,planning_contract,skeleton_hash,planner_stage
         ) VALUES ($1,$2,$3,$4,$5,$6,3,$7,2,'PLANNING','planner-forged','lease-forged',
           NOW()+INTERVAL '1 minute',7,$8,'FIXED_SKELETON_V1',$9,'BUILDING_SKELETON')`,
        [`attempt-forged-${suffix}`, ids.account, ids.job, ids.item, ids.snapshot, ids.profile,
          "f".repeat(64), `auto-listing-plan-${"e".repeat(64)}`, "d".repeat(64)],
      ), (error) => error?.code === "23514");
      const activeParent = await repository.loadActiveContentPlan({
        accountId: ids.account, jobId: ids.job, itemId: ids.item, expectedStatusVersion: 7,
      });
      assert.equal(activeParent.id, stored.id);

      await assert.rejects(repository.saveContentPlan({
        ...request,
        reservationToken: `stale-${suffix}`,
        strategyVersionId: ids.strategy,
        sourceHash: "1".repeat(64), strategyHash: "2".repeat(64), configHash: "3".repeat(64),
        visualGroupsHash: "4".repeat(64), visualGroups, factRegistryHash: hash(facts), factRegistry: facts,
        plannerModel: "planner-model", promptTemplateVersion: "planner-v1", regeneration: null,
        gatewayRequestId: "gateway-request-a", plan, planHash: hash(plan),
      }), (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT");

      const derivedVisualGroups = structuredClone(visualGroups);
      derivedVisualGroups.visualGroupsHash = "7".repeat(64);
      derivedVisualGroups.groups[0].referenceImages[0] = {
        assetId: "source-a", sourceRefHash: "9".repeat(64), sourceRef: null,
        contentHash: "5".repeat(64), evidenceKind: "CONTENT_HASH",
      };
      const derived = {
        id: `plan-derived-${suffix}`, sourceAccountId: ids.account, jobId: ids.job, itemId: ids.item,
        sourceSnapshotId: ids.snapshot, strategyVersionId: ids.strategy, profileId: ids.profile,
        strategyHash: "2".repeat(64), configHash: "3".repeat(64), sourceHash: "1".repeat(64),
        inputHash: "6".repeat(64), plannerModel: "planner-model", profileVersion: 3,
        promptTemplateVersion: "planner-v1", plan, planHash: hash(plan),
        visualGroupsHash: "7".repeat(64), visualGroups: derivedVisualGroups,
        factRegistry: facts, regeneration: null, gatewayRequestId: "gateway-request-a",
        planningContract: "LEGACY_FULL_PLAN_V3", skeletonHash: null,
        parentPlanId: stored.id, derivationKind: "SOURCE_MATERIALIZATION", materializationSetHash: "8".repeat(64),
      };
      const command = {
        scope: { accountId: ids.account, jobId: ids.job, itemId: ids.item, parentPlanId: stored.id, expectedStatusVersion: 7 },
        derivedPlan: derived,
      };
      assert.deepEqual(await repository.createDerivedMaterializedPlan(command), derived);
      assert.deepEqual(await repository.createDerivedMaterializedPlan(command), derived);
      const persisted = await admin.query(
        "SELECT active_content_plan_id,status_version FROM auto_listing_job_items WHERE account_id=$1 AND job_id=$2 AND id=$3",
        [ids.account, ids.job, ids.item],
      );
      assert.deepEqual(persisted.rows[0], { active_content_plan_id: derived.id, status_version: 7 });
      const counts = await admin.query(
        `SELECT
           (SELECT COUNT(*)::INTEGER FROM ai_content_plans WHERE account_id=$1 AND job_id=$2 AND item_id=$3) AS plans,
           (SELECT COUNT(*)::INTEGER FROM auto_listing_content_plan_derivations WHERE account_id=$1 AND job_id=$2 AND item_id=$3) AS derivations`,
        [ids.account, ids.job, ids.item],
      );
      assert.deepEqual(counts.rows[0], { plans: 2, derivations: 1 });

      const fixedIds = {
        snapshot: `snapshot-fixed-${suffix}`,
        job: `job-fixed-${suffix}`,
        item: `item-fixed-${suffix}`,
      };
      const skeletonHash = "d".repeat(64);
      await admin.query(
        "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
        [fixedIds.snapshot, ids.account, `record-fixed-${suffix}`, "source-hash-fixed"],
      );
      await admin.query(
        "INSERT INTO auto_listing_jobs (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,correlation_id) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,'{}'::JSONB,$4,$5,$6)",
        [fixedIds.job, ids.account, `idem-fixed-${suffix}`, "config-hash-fixed", ids.strategy, `corr-fixed-${suffix}`],
      );
      await admin.query(
         `INSERT INTO auto_listing_job_items (
           id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,planning_contract,source_order
         ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,'FIXED_SKELETON_V1',1)`,
        [fixedIds.item, fixedIds.job, ids.account, fixedIds.snapshot, ids.store, ids.warehouse],
      );
      const fixedRepository = createPostgresContentPlanRepository({
        pool: scopedPool,
        token: () => `lease-fixed-${suffix}`,
        id: () => `attempt-fixed-${suffix}`,
        planId: () => `plan-fixed-${suffix}`,
      });
      const fixedRequest = {
        accountId: ids.account, jobId: fixedIds.job, itemId: fixedIds.item,
        sourceSnapshotId: fixedIds.snapshot, profileId: ids.profile, profileVersion: 3,
        inputHash: "c".repeat(64), expectedStatusVersion: 7,
        planningContract: "FIXED_SKELETON_V1", skeletonHash,
        requestKey: `auto-listing-plan-${"e".repeat(64)}`,
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      };
      const fixedOwner = await fixedRepository.reserveContentPlan(fixedRequest);
      assert.deepEqual({ stage: fixedOwner.plannerStage, skeletonHash: fixedOwner.skeletonHash }, {
        stage: "BUILDING_SKELETON", skeletonHash,
      });
      await fixedRepository.advanceContentPlanStage({
        accountId: ids.account, jobId: fixedIds.job, itemId: fixedIds.item,
        sourceSnapshotId: fixedIds.snapshot, attemptId: fixedOwner.attemptId,
        inputHash: fixedRequest.inputHash, expectedStatusVersion: 7,
        reservationToken: fixedOwner.reservationToken, planningContract: "FIXED_SKELETON_V1",
        skeletonHash, fromStage: "BUILDING_SKELETON", toStage: "FILLING_COPY",
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      const fixedEvidence = createPostgresContentPlanEvidenceRepository({
        pool: scopedPool,
        responseId: () => `response-fixed-${suffix}`,
        validationId: () => `validation-fixed-${suffix}`,
      });
      const fixedResponse = await fixedEvidence.recordResponse({
        accountId: ids.account, jobId: fixedIds.job, itemId: fixedIds.item,
        sourceSnapshotId: fixedIds.snapshot, owner: { kind: "ATTEMPT", id: fixedOwner.attemptId },
        planningContract: "FIXED_SKELETON_V1", inputHash: fixedRequest.inputHash, skeletonHash,
        profileId: ids.profile, profileVersion: 3, modelName: "planner-model",
        promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V1", gatewayRequestId: "gateway-fixed",
        response: { version: 1, language: "ru", fills: {} },
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      await fixedRepository.advanceContentPlanStage({
        accountId: ids.account, jobId: fixedIds.job, itemId: fixedIds.item,
        sourceSnapshotId: fixedIds.snapshot, attemptId: fixedOwner.attemptId,
        inputHash: fixedRequest.inputHash, expectedStatusVersion: 7,
        reservationToken: fixedOwner.reservationToken, planningContract: "FIXED_SKELETON_V1",
        skeletonHash, fromStage: "FILLING_COPY", toStage: "VALIDATING_COPY",
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      await fixedEvidence.recordValidation({
        accountId: ids.account, responseId: fixedResponse.id, status: "ACCEPTED",
        validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1", issues: [],
      });
      const fixedPlan = { version: 1, language: "ru", slots: [] };
      const storedFixed = await fixedRepository.saveContentPlan({
        ...fixedRequest, reservationToken: fixedOwner.reservationToken,
        strategyVersionId: ids.strategy, sourceHash: "1".repeat(64), strategyHash: "2".repeat(64),
        configHash: "3".repeat(64), visualGroupsHash: "4".repeat(64), visualGroups,
        factRegistryHash: hash(facts), factRegistry: facts, plannerModel: "planner-model",
        promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V1", regeneration: null,
        gatewayRequestId: "gateway-fixed", plan: fixedPlan, planHash: hash(fixedPlan),
      });
      assert.equal(storedFixed.skeletonHash, skeletonHash);
      const fixedRows = await admin.query(
        `SELECT attempt.skeleton_hash,attempt.planner_stage,plan.skeleton_hash AS plan_skeleton_hash
           FROM auto_listing_content_plan_attempts AS attempt
           JOIN ai_content_plans AS plan ON plan.account_id=attempt.account_id AND plan.id=attempt.accepted_plan_id
          WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3`,
        [ids.account, fixedIds.job, fixedIds.item],
      );
      assert.deepEqual(fixedRows.rows, [{
        skeleton_hash: skeletonHash, planner_stage: "COMPLETED", plan_skeleton_hash: skeletonHash,
      }]);

      let provenanceSequence = 0;
      const provenanceRepository = createPostgresContentPlanRepository({
        pool: scopedPool,
        leaseMs: 60_000,
        token: () => `provenance-lease-${++provenanceSequence}-${suffix}`,
        id: () => `provenance-attempt-${++provenanceSequence}-${suffix}`,
      });
      const provenanceEvidence = createPostgresContentPlanEvidenceRepository({
        pool: scopedPool,
        responseId: () => `provenance-response-${++provenanceSequence}-${suffix}`,
        validationId: () => `provenance-validation-${++provenanceSequence}-${suffix}`,
      });
      const createProvenanceRequest = async (label) => {
        const snapshotId = `snapshot-${label}-${suffix}`;
        const jobId = `job-${label}-${suffix}`;
        const itemId = `item-${label}-${suffix}`;
        await admin.query(
          "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
          [snapshotId, ids.account, `record-${label}-${suffix}`, hash({ label, kind: "source" })],
        );
        await admin.query(
          "INSERT INTO auto_listing_jobs (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,correlation_id) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,'{}'::JSONB,$4,$5,$6)",
          [jobId, ids.account, `idem-${label}-${suffix}`, hash({ label, kind: "config" }), ids.strategy,
            `corr-${label}-${suffix}`],
        );
        await admin.query(
          "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)",
          [itemId, jobId, ids.account, snapshotId, ids.store, ids.warehouse],
        );
        return {
          accountId: ids.account, jobId, itemId, sourceSnapshotId: snapshotId,
          profileId: ids.profile, profileVersion: 3,
          inputHash: hash({ label, kind: "input" }), expectedStatusVersion: 7,
          planningContract: "LEGACY_FULL_PLAN_V3", skeletonHash: null,
          requestKey: `auto-listing-plan-${hash({ label, kind: "request" })}`,
          gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
        };
      };
      const plannerRows = async (requestInput) => (await admin.query(
        `SELECT id,attempt_no,status,planner_stage,error_code,lease_token,lease_expires_at,
                gateway_connection_id,gateway_connection_version
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND input_hash=$4
          ORDER BY attempt_no`,
        [requestInput.accountId, requestInput.jobId, requestInput.itemId, requestInput.inputHash],
      )).rows;
      const connectionBRequest = (requestInput) => ({
        ...requestInput, gatewayConnectionId: ids.connectionB, gatewayConnectionVersion: 1,
      });
      const plannerEvidenceScope = (requestInput, attemptId) => ({
        accountId: requestInput.accountId, jobId: requestInput.jobId, itemId: requestInput.itemId,
        sourceSnapshotId: requestInput.sourceSnapshotId, owner: { kind: "ATTEMPT", id: attemptId },
        planningContract: requestInput.planningContract, inputHash: requestInput.inputHash,
        skeletonHash: requestInput.skeletonHash, profileId: requestInput.profileId,
        profileVersion: requestInput.profileVersion,
        gatewayConnectionId: requestInput.gatewayConnectionId,
        gatewayConnectionVersion: requestInput.gatewayConnectionVersion,
      });

      const reusableRequest = await createProvenanceRequest("reusable-a-to-b");
      const reusableA = await provenanceRepository.reserveContentPlan(reusableRequest);
      const reusableResponse = await provenanceEvidence.recordResponse({
        ...plannerEvidenceScope(reusableRequest, reusableA.attemptId),
        modelName: "planner-model", promptTemplateVersion: "planner-v1",
        gatewayRequestId: `gateway-reusable-${suffix}`,
        response: { version: 1, language: "ru", slots: [] },
      });
      await provenanceEvidence.recordValidation({
        accountId: ids.account, responseId: reusableResponse.id, status: "ACCEPTED",
        validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1", issues: [],
      });
      await admin.query(
        "UPDATE auto_listing_content_plan_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
        [ids.account, reusableA.attemptId],
      );
      const reusableB = await provenanceRepository.reserveContentPlan(connectionBRequest(reusableRequest));
      assert.deepEqual({
        status: reusableB.status, attemptId: reusableB.attemptId, attemptNo: reusableB.attemptNo,
        gatewayConnectionId: reusableB.gatewayConnectionId,
        gatewayConnectionVersion: reusableB.gatewayConnectionVersion,
      }, {
        status: "RESERVED", attemptId: reusableA.attemptId, attemptNo: 1,
        gatewayConnectionId: ids.connectionA, gatewayConnectionVersion: 1,
      });
      const reusableOutcome = await provenanceEvidence.loadOutcome({
        ...plannerEvidenceScope(reusableRequest, reusableB.attemptId),
      });
      assert.equal(reusableOutcome.response.id, reusableResponse.id);
      assert.equal(reusableOutcome.validation.status, "ACCEPTED");

      const invalidRequest = await createProvenanceRequest("invalid-a-to-b");
      const invalidA = await provenanceRepository.reserveContentPlan(invalidRequest);
      const invalidResponse = await provenanceEvidence.recordResponse({
        ...plannerEvidenceScope(invalidRequest, invalidA.attemptId),
        modelName: "planner-model", promptTemplateVersion: "planner-v1",
        gatewayRequestId: `gateway-invalid-${suffix}`,
        response: { version: 1, language: "ru", slots: [] },
      });
      await provenanceEvidence.recordValidation({
        accountId: ids.account, responseId: invalidResponse.id, status: "REJECTED",
        validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
        issues: [{ code: "SLOTS_REQUIRED", slotKey: null, claimIndex: null, field: "slots", expected: "non-empty", actual: "empty" }],
      });
      const replaceInvalid = (overrides = {}) => ({
        ...invalidRequest, attemptId: invalidA.attemptId, reservationToken: invalidA.reservationToken,
        replacementGatewayConnectionId: ids.connectionB, replacementGatewayConnectionVersion: 1,
        ...overrides,
      });
      const invalidBaseline = await plannerRows(invalidRequest);
      for (const mutation of [
        { gatewayConnectionId: ids.connectionB },
        { reservationToken: `stale-${invalidA.reservationToken}` },
        { expectedStatusVersion: 8 },
      ]) {
        await assert.rejects(
          provenanceRepository.replaceContentPlanReservation(replaceInvalid(mutation)),
          (error) => ["AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT", "AUTO_LISTING_CONTENT_PLAN_STATUS_VERSION_CONFLICT"]
            .includes(error?.code),
        );
        assert.deepEqual(await plannerRows(invalidRequest), invalidBaseline);
      }
      await admin.query(
        "UPDATE auto_listing_job_items SET status='GENERATING' WHERE account_id=$1 AND job_id=$2 AND id=$3",
        [invalidRequest.accountId, invalidRequest.jobId, invalidRequest.itemId],
      );
      await assert.rejects(
        provenanceRepository.replaceContentPlanReservation(replaceInvalid()),
        (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_STATUS_VERSION_CONFLICT",
      );
      assert.deepEqual(await plannerRows(invalidRequest), invalidBaseline);
      await admin.query(
        "UPDATE auto_listing_job_items SET status='PLANNING' WHERE account_id=$1 AND job_id=$2 AND id=$3",
        [invalidRequest.accountId, invalidRequest.jobId, invalidRequest.itemId],
      );
      const invalidB = await provenanceRepository.replaceContentPlanReservation(replaceInvalid());
      assert.deepEqual({
        status: invalidB.status, attemptNo: invalidB.attemptNo,
        gatewayConnectionId: invalidB.gatewayConnectionId,
        gatewayConnectionVersion: invalidB.gatewayConnectionVersion,
      }, {
        status: "RESERVED", attemptNo: 2,
        gatewayConnectionId: ids.connectionB, gatewayConnectionVersion: 1,
      });
      assert.deepEqual((await plannerRows(invalidRequest)).map((row) => ({
        attempt_no: row.attempt_no, status: row.status, planner_stage: row.planner_stage,
        error_code: row.error_code, gateway_connection_id: row.gateway_connection_id,
        gateway_connection_version: row.gateway_connection_version,
      })), [
        { attempt_no: 1, status: "FAILED", planner_stage: "FAILED",
          error_code: "EVIDENCE_NOT_REUSABLE", gateway_connection_id: ids.connectionA,
          gateway_connection_version: 1 },
        { attempt_no: 2, status: "PLANNING", planner_stage: "FILLING_COPY",
          error_code: null, gateway_connection_id: ids.connectionB,
          gateway_connection_version: 1 },
      ]);

      const noEvidenceRequest = await createProvenanceRequest("no-evidence-a-to-b");
      const noEvidenceA = await provenanceRepository.reserveContentPlan(noEvidenceRequest);
      await admin.query(
        "UPDATE auto_listing_content_plan_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
        [ids.account, noEvidenceA.attemptId],
      );
      const noEvidenceB = await provenanceRepository.reserveContentPlan(connectionBRequest(noEvidenceRequest));
      assert.deepEqual({
        attemptId: noEvidenceB.attemptId, attemptNo: noEvidenceB.attemptNo,
        gatewayConnectionId: noEvidenceB.gatewayConnectionId,
        gatewayConnectionVersion: noEvidenceB.gatewayConnectionVersion,
      }, {
        attemptId: noEvidenceA.attemptId, attemptNo: 1,
        gatewayConnectionId: ids.connectionB, gatewayConnectionVersion: 1,
      });
      assert.equal((await plannerRows(noEvidenceRequest)).length, 1);

      const expiredRequest = await createProvenanceRequest("expired-replacement");
      const expiredA = await provenanceRepository.reserveContentPlan(expiredRequest);
      await admin.query(
        "UPDATE auto_listing_content_plan_attempts SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND id=$2",
        [ids.account, expiredA.attemptId],
      );
      const expiredBaseline = await plannerRows(expiredRequest);
      await assert.rejects(provenanceRepository.replaceContentPlanReservation({
        ...expiredRequest, attemptId: expiredA.attemptId, reservationToken: expiredA.reservationToken,
        replacementGatewayConnectionId: ids.connectionB, replacementGatewayConnectionVersion: 1,
      }), (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_LEASE_CONFLICT");
      assert.deepEqual(await plannerRows(expiredRequest), expiredBaseline);
    } finally {
      try {
        await scopedPool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await pool.end();
      }
    }
  });
}
