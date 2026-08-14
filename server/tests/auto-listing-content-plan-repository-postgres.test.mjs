import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPostgresContentPlanRepository } from "../auto-listing-content-plan-repository.mjs";
import { createPostgresContentPlanEvidenceRepository } from "../auto-listing-content-plan-evidence-postgres.mjs";

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
        "INSERT INTO auto_listing_job_items (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7)",
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
        leaseMs: 50,
        token: (() => { let next = 0; return () => `lease-${++next}-${suffix}`; })(),
        id: (() => { let next = 0; return () => `attempt-${++next}-${suffix}`; })(),
        planId: () => `plan-parent-${suffix}`,
        derivationId: () => `derivation-${suffix}`,
      });
      const request = {
        accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
        profileId: ids.profile, profileVersion: 3, inputHash: "a".repeat(64), expectedStatusVersion: 7,
        planningContract: "LEGACY_FULL_PLAN_V3",
        requestKey: `auto-listing-plan-${"b".repeat(64)}`,
      };
      const claimed = await Promise.all([repository.reserveContentPlan(request), repository.reserveContentPlan(request)]);
      assert.deepEqual(claimed.map((entry) => entry.status).sort(), ["IN_PROGRESS", "RESERVED"]);
      let owner = claimed.find((entry) => entry.status === "RESERVED");
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
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
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
      });
      await evidenceRepository.recordValidation({
        accountId: ids.account, responseId: recordedResponse.id, status: "ACCEPTED",
        validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1", issues: [],
      });
      const recordedOutcome = await evidenceRepository.loadOutcome({
        accountId: ids.account, jobId: ids.job, itemId: ids.item, sourceSnapshotId: ids.snapshot,
        owner: { kind: "ATTEMPT", id: owner.attemptId }, planningContract: "LEGACY_FULL_PLAN_V3",
        inputHash: request.inputHash, skeletonHash: null, profileId: ids.profile, profileVersion: 3,
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
