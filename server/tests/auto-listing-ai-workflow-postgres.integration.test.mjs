import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPostgresAutoListingAiWorkflow,
  stageInitialPlanWork,
} from "../auto-listing-ai-workflow-postgres.mjs";
import { createPostgresAiOutboxRepository } from "../auto-listing-ai-outbox-postgres.mjs";
import { autoListingAiMessageDedupeKey } from "../auto-listing-ai-message.mjs";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createPostgresGenerationAttemptRepository } from "../auto-listing-generation-attempt-postgres.mjs";
import {
  buildImageGenerationAttemptIdentity,
  buildImageGenerationInput,
} from "../auto-listing-image-generator.mjs";
import { createPostgresRichContentRepository } from "../auto-listing-rich-content-repository.mjs";
import {
  buildRichContentAttemptInputHash,
  buildRichContentEvidenceIdentity,
} from "../auto-listing-rich-content.mjs";
import { evaluateGeneratedCheckerEvidence } from "../auto-listing-result-checker.mjs";
import {
  buildSourceMaterializationObjectKey,
  createPostgresSourceMaterializationRepository,
} from "../auto-listing-source-materialization-repository.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function acceptedOutcome(phase, outcome, correlationId, failureCode = null) {
  return Object.freeze({
    contractVersion: "V1", disposition: "ACK", phase, outcome,
    retryable: false, failureCode, correlationId,
    failureScope: null, deliveryState: null, retryAfterMs: null,
  });
}

if (!enabled) {
  test("workflow PostgreSQL concurrency requires an explicitly disposable database", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("real PostgreSQL serializes exact staging replay and rolls back a crash after state CAS", { timeout: 30_000 }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 2 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_workflow_${suffix}`;
    const schemaSql = quote(schema);
    let pool;
    const ids = Object.fromEntries([
      "account", "store", "warehouse", "strategy", "snapshot", "profile", "policy", "job", "item", "correlation",
    ].map((key) => [key, `${key}-${suffix}`]));
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
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
        [ids.strategy, ids.account, "a".repeat(64)],
      );
      await admin.query(
        `INSERT INTO auto_listing_upload_policy_versions (
           id,account_id,mode,enabled,version,publication_reason,created_by,published_by,published_at,
           publication_origin,publication_base_url,publication_prefix,publication_version,
           publication_policy_hash
         ) VALUES ($1,$2,'REVIEW',TRUE,1,'workflow integration',$2,$2,NOW(),
           'https://media.example.com','https://media.example.com/ozon/','listing-media/v1',
           'LISTING_MEDIA_V1',$3)`,
        [ids.policy, ids.account, "c".repeat(64)],
      );
      await admin.query(
        "INSERT INTO auto_listing_source_snapshots (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash) VALUES ($1,$2,'COLLECT_BOX',$3,'1','{}'::JSONB,$4)",
        [ids.snapshot, ids.account, `record-${suffix}`, "b".repeat(64)],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled
         ) VALUES ($1,$2,'Profile','https://gateway.invalid','TEST_AI_KEY','SUB2API_RESPONSES',
           'SUB2API_OPENAI_IMAGES','text-model','image-model',1,TRUE)`,
        [ids.profile, ids.account],
      );
      await admin.query(
        `INSERT INTO auto_listing_jobs (
           id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
           strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,correlation_id
         ) VALUES ($1,$2,'COLLECT_BOX','CREATED',$3,'{}'::JSONB,$4,$5,$6,$7,1,$2,$8)`,
        [ids.job, ids.account, `idem-${suffix}`, "c".repeat(64), ids.strategy, ids.policy, ids.profile, ids.correlation],
      );
      await admin.query(
        `INSERT INTO auto_listing_job_items (
           id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
         ) VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_READY',1,1)`,
        [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );

      const command = (client) => stageInitialPlanWork({
        client, accountId: ids.account, jobId: ids.job, itemId: ids.item,
        actorAccountId: ids.account, expectedStatusVersion: 1, correlationId: ids.correlation,
      });

      const crashClient = await pool.connect();
      await crashClient.query("BEGIN");
      assert.deepEqual(await command(crashClient), { status: "PLANNING", statusVersion: 2 });
      await crashClient.query("ROLLBACK");
      crashClient.release();
      assert.deepEqual((await admin.query(
        "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, ids.item],
      )).rows[0], { status: "SOURCE_READY", status_version: 1 });
      assert.equal((await admin.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_outbox WHERE account_id=$1 AND item_id=$2",
        [ids.account, ids.item],
      )).rows[0].count, 0);

      const first = await pool.connect();
      const second = await pool.connect();
      await first.query("BEGIN");
      await second.query("BEGIN");
      const firstResult = command(first);
      const secondResult = command(second);
      assert.deepEqual(await firstResult, { status: "PLANNING", statusVersion: 2 });
      await first.query("COMMIT");
      assert.deepEqual(await secondResult, { status: "PLANNING", statusVersion: 2 });
      await second.query("COMMIT");
      first.release();
      second.release();

      const evidence = await admin.query(
        `SELECT
           (SELECT COUNT(*)::INTEGER FROM auto_listing_events
             WHERE account_id=$1 AND item_id=$2 AND event_type='START_PLANNING') AS events,
           (SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox
             WHERE account_id=$1 AND item_id=$2 AND phase='PLAN_CONTENT') AS outbox`,
        [ids.account, ids.item],
      );
      assert.deepEqual(evidence.rows[0], { events: 1, outbox: 1 });

      await admin.query(
        `INSERT INTO auto_listing_events (
           id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
           correlation_id,details,transition_version
         ) VALUES ($1,$2,$3,$4,$2,'PLANNING','GENERATING','PLAN_READY',$5,'{}'::JSONB,3)`,
        [`collision-${suffix}`, ids.account, ids.job, ids.item, ids.correlation],
      );
      const workflow = createPostgresAutoListingAiWorkflow({ pool });
      await assert.rejects(workflow.applyPhaseOutcome({
        message: {
          contractVersion: "V1", accountId: ids.account, itemId: ids.item, phase: "PLAN_CONTENT",
          expectedStatusVersion: 2, correlationId: ids.correlation,
        },
        outcome: {
          contractVersion: "V1", disposition: "FAIL", phase: "PLAN_CONTENT", outcome: "FAILED",
          retryable: false, failureCode: "AUTO_LISTING_CONTENT_PLAN_FAILED", correlationId: ids.correlation,
          failureScope: "BUSINESS", deliveryState: null, retryAfterMs: null,
        },
      }), { code: "AUTO_LISTING_AI_WORKFLOW_DATABASE_FAILED", retryable: true });
      assert.deepEqual((await admin.query(
        "SELECT status,status_version,failure_code FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, ids.item],
      )).rows[0], { status: "PLANNING", status_version: 2, failure_code: null });

      const imageItem = `image-item-${suffix}`;
      const parentPlan = `parent-plan-${suffix}`;
      const derivedPlan = `derived-plan-${suffix}`;
      const slots = [
        { slotKey: "slot-main", role: "MAIN" }, { slotKey: "slot-2", role: "DETAIL" },
        { slotKey: "slot-3", role: "SCENE" }, { slotKey: "slot-4", role: "INFOGRAPHIC" },
        { slotKey: "slot-5", role: "SELLING_POINT" }, { slotKey: "slot-6", role: "DETAIL" },
      ];
      await admin.query(
        `INSERT INTO auto_listing_job_items (
           id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
         ) VALUES ($1,$2,$3,$4,$5,$6,'GENERATING',3,2)`,
        [imageItem, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );
      const insertPlan = (planId, inputHash, parentId = null) => admin.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id,
           parent_plan_id,derivation_kind,materialization_set_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,'planner',1,'plan-v1',$10::JSONB,$8,$8,
           '{"groups":[]}'::JSONB,'gateway-request',$11,$12,$13)`,
        [planId, ids.account, ids.job, imageItem, ids.snapshot, ids.strategy, ids.profile,
          "d".repeat(64), inputHash, JSON.stringify({ slots }), parentId,
          parentId ? "SOURCE_MATERIALIZATION" : null, parentId ? "f".repeat(64) : null],
      );
      await insertPlan(parentPlan, "e".repeat(64));
      await insertPlan(derivedPlan, "f".repeat(64), parentPlan);
      await admin.query(
        "UPDATE auto_listing_job_items SET active_content_plan_id=$3 WHERE account_id=$1 AND id=$2",
        [ids.account, imageItem, derivedPlan],
      );
      const imageMessage = (slotKey) => ({
        contractVersion: "V1", accountId: ids.account, itemId: imageItem, phase: "GENERATE_IMAGE_SLOT",
        expectedStatusVersion: 3, correlationId: ids.correlation, slotKey,
      });
      const skippedOutcome = {
        contractVersion: "V1", disposition: "ACK", phase: "GENERATE_IMAGE_SLOT",
        outcome: "IMAGE_SLOT_SKIPPED", retryable: false,
        failureCode: "AUTO_LISTING_IMAGE_POLICY_REJECTED", correlationId: ids.correlation,
        failureScope: null, deliveryState: null, retryAfterMs: null,
      };
      const concurrent = await Promise.all([
        workflow.applyPhaseOutcome({ message: imageMessage("slot-2"), outcome: skippedOutcome }),
        workflow.applyPhaseOutcome({ message: imageMessage("slot-3"), outcome: skippedOutcome }),
      ]);
      assert.equal(concurrent.every((result) => result.disposition === "APPLIED" && result.enqueued === 0), true);
      assert.equal((await workflow.applyPhaseOutcome({
        message: imageMessage("slot-2"), outcome: skippedOutcome,
      })).disposition, "APPLIED");
      const imageAudits = await admin.query(
        `SELECT id,details FROM auto_listing_events
          WHERE account_id=$1 AND item_id=$2 AND event_type='AI_IMAGE_SLOT_SKIPPED'
          ORDER BY details->>'slotKey'`,
        [ids.account, imageItem],
      );
      assert.deepEqual(imageAudits.rows.map(({ details }) => details.slotKey), ["slot-2", "slot-3"]);
      assert.equal(new Set(imageAudits.rows.map(({ id }) => id)).size, 2);
      assert.deepEqual((await admin.query(
        "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, imageItem],
      )).rows[0], { status: "GENERATING", status_version: 3 });

      const journeyItem = `journey-item-${suffix}`;
      const journeyCorrelation = `journey-correlation-${suffix}`;
      const journeyParentPlan = `journey-parent-${suffix}`;
      const journeyDerivedPlan = `journey-derived-${suffix}`;
      const journeySourceAsset = `journey-source-${suffix}`;
      const sourceRefHash = hash(`source-ref-${suffix}`);
      const sourceInputHash = hash(`source-input-${suffix}`);
      const sourceContentHash = hash(`source-content-${suffix}`);
      const planHash = hash(`plan-${suffix}`);
      const sourceHash = hash(`source-${suffix}`);
      const strategyHash = hash(`strategy-${suffix}`);
      const configHash = hash(`config-${suffix}`);
      const visualGroupsHash = hash(`visual-groups-${suffix}`);
      const journeySlots = [
        { slotKey: "main-01", visualGroupKey: "main", role: "MAIN", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [journeySourceAsset] },
        { slotKey: "selling-01", visualGroupKey: "main", role: "SELLING_POINT", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [journeySourceAsset] },
        { slotKey: "detail-01", visualGroupKey: "main", role: "DETAIL", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [journeySourceAsset] },
        { slotKey: "scene-01", visualGroupKey: "main", role: "SCENE", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [journeySourceAsset] },
        { slotKey: "info-01", visualGroupKey: "main", role: "INFOGRAPHIC", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [journeySourceAsset] },
        { slotKey: "detail-02", visualGroupKey: "main", role: "DETAIL", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: [journeySourceAsset] },
      ];
      const parentVisualGroups = {
        groups: [{
          visualGroupKey: "main",
          referenceImages: [{
            evidenceKind: "SOURCE_REF_HASH", assetId: journeySourceAsset,
            sourceRefHash, contentHash: null,
          }],
        }],
      };
      await admin.query(
        `INSERT INTO auto_listing_job_items (
           id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
         ) VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_READY',1,3)`,
        [journeyItem, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );
      const stagedClient = await pool.connect();
      await stagedClient.query("BEGIN");
      assert.deepEqual(await stageInitialPlanWork({
        client: stagedClient, accountId: ids.account, jobId: ids.job, itemId: journeyItem,
        actorAccountId: ids.account, expectedStatusVersion: 1, correlationId: journeyCorrelation,
      }), { status: "PLANNING", statusVersion: 2 });
      await stagedClient.query("COMMIT");
      stagedClient.release();

      await admin.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planner',1,'image-v1',$12::JSONB,$13,$14,$15::JSONB,$16)`,
        [journeyParentPlan, ids.account, ids.job, journeyItem, ids.snapshot, ids.strategy, ids.profile,
          strategyHash, configHash, sourceHash, hash(`parent-input-${suffix}`), JSON.stringify({ slots: journeySlots }),
          planHash, visualGroupsHash, JSON.stringify(parentVisualGroups), `parent-gateway-${suffix}`],
      );
      await admin.query(
        "UPDATE auto_listing_job_items SET active_content_plan_id=$3 WHERE account_id=$1 AND id=$2",
        [ids.account, journeyItem, journeyParentPlan],
      );
      const messageFor = (phase, extra = {}) => ({
        contractVersion: "V1", accountId: ids.account, itemId: journeyItem, phase,
        expectedStatusVersion: phase === "GENERATE_IMAGE_SLOT" || phase === "GENERATE_RICH_CONTENT" ? 3 : 2,
        correlationId: journeyCorrelation, ...extra,
      });
      assert.deepEqual(await workflow.applyPhaseOutcome({
        message: messageFor("PLAN_CONTENT"),
        outcome: acceptedOutcome("PLAN_CONTENT", "PLAN_READY", journeyCorrelation),
      }), { disposition: "APPLIED", status: "PLANNING", statusVersion: 2, enqueued: 1 });

      const sourceRepository = createPostgresSourceMaterializationRepository({
        pool, token: () => `source-lease-${suffix}`, id: () => `source-attempt-${suffix}`,
      });
      const sourceScope = {
        accountId: ids.account, jobId: ids.job, itemId: journeyItem,
        parentPlanId: journeyParentPlan, sourceAssetId: journeySourceAsset,
        sourceRefHash, inputHash: sourceInputHash, expectedStatusVersion: 2,
      };
      const sourceLease = await sourceRepository.reserveSourceMaterialization({ ...sourceScope, maxAttempts: 3 });
      assert.equal(sourceLease.status, "RESERVED");
      const sourceEvidence = {
        ...sourceScope,
        attemptId: sourceLease.attemptId,
        attemptNo: sourceLease.attemptNo,
        leaseToken: sourceLease.leaseToken,
        objectKeyVersion: "SOURCE_V1",
        objectKey: buildSourceMaterializationObjectKey({
          ...sourceScope, attemptNo: sourceLease.attemptNo,
          contentHash: sourceContentHash, contentType: "image/png",
        }),
        contentHash: sourceContentHash,
        contentType: "image/png",
        width: 768,
        height: 1024,
        sizeBytes: 2048,
      };
      assert.equal((await sourceRepository.recordStoredSourceMaterialization(sourceEvidence)).status, "STORED");
      assert.equal((await sourceRepository.completeSourceMaterialization(sourceEvidence)).status, "ACCEPTED");
      assert.deepEqual(await workflow.applyPhaseOutcome({
        message: messageFor("MATERIALIZE_SOURCE_ASSET", { sourceAssetId: journeySourceAsset }),
        outcome: acceptedOutcome("MATERIALIZE_SOURCE_ASSET", "SOURCE_ASSET_ACCEPTED", journeyCorrelation),
      }), { disposition: "APPLIED", status: "PLANNING", statusVersion: 2, enqueued: 1 });

      const derivedVisualGroups = {
        groups: [{
          visualGroupKey: "main",
          referenceImages: [{
            evidenceKind: "CONTENT_HASH", assetId: journeySourceAsset,
            sourceRefHash, contentHash: sourceContentHash,
          }],
        }],
      };
      await admin.query(
        `INSERT INTO ai_content_plans (
           id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,
           strategy_hash,config_hash,source_hash,input_hash,planner_model,profile_version,
           prompt_template_version,plan,plan_hash,visual_groups_hash,visual_groups,gateway_request_id,
           parent_plan_id,derivation_kind,materialization_set_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planner',1,'image-v1',$12::JSONB,$13,$14,$15::JSONB,$16,
           $17,'SOURCE_MATERIALIZATION',$18)`,
        [journeyDerivedPlan, ids.account, ids.job, journeyItem, ids.snapshot, ids.strategy, ids.profile,
          strategyHash, configHash, sourceHash, hash(`derived-input-${suffix}`), JSON.stringify({ slots: journeySlots }),
          planHash, visualGroupsHash, JSON.stringify(derivedVisualGroups), `derived-gateway-${suffix}`,
          journeyParentPlan, hash(`materialization-set-${suffix}`)],
      );
      await admin.query(
        "UPDATE auto_listing_job_items SET active_content_plan_id=$3 WHERE account_id=$1 AND id=$2",
        [ids.account, journeyItem, journeyDerivedPlan],
      );
      assert.deepEqual(await workflow.applyPhaseOutcome({
        message: messageFor("FINALIZE_MATERIALIZED_PLAN"),
        outcome: acceptedOutcome("FINALIZE_MATERIALIZED_PLAN", "MATERIALIZED_PLAN_READY", journeyCorrelation),
      }), { disposition: "APPLIED", status: "GENERATING", statusVersion: 3, enqueued: 6 });

      let generationSequence = 0;
      const generationRepository = createPostgresGenerationAttemptRepository({
        pool,
        token: () => `generation-lease-${suffix}`,
        id: () => `generation-${++generationSequence}-${suffix}`,
      });
      const sourceReference = {
        assetId: journeySourceAsset, contentHash: sourceContentHash, contentType: "image/png",
        width: 768, height: 1024, size: 2048,
      };
      const fact = {
        factId: "fact.capacity", field: "attributes.capacity", kind: "CAPACITY", value: "500 мл",
        numericValue: 500, unit: "мл", sourcePath: "attributes.capacity",
      };
      const checkerResult = {
        matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS",
        prohibitedContent: false, reasons: [],
        evidence: {
          identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: [journeySourceAsset] },
          claims: [{
            text: "Объём 500 мл", sourceFactId: fact.factId, field: fact.field, value: fact.value,
            numericValue: fact.numericValue, unit: fact.unit,
          }],
          detectedTexts: ["Объём 500 мл"], language: "ru", qualityFlags: [], prohibitedFlags: [],
        },
      };
      const checkerModelEvidence = {
        requestedTextModel: "text-model", gatewayReportedTextModel: "text-model",
        gatewayReportedTextModelPresent: true,
      };
      const generationProfile = {
        id: ids.profile, accountId: ids.account, configVersion: 1,
        textModel: "text-model", imageModel: "image-model",
      };
      const generationPlan = { planHash, sourceHash, strategyHash, configHash, visualGroupsHash };
      const acceptedAssets = [];
      for (let index = 0; index < journeySlots.length; index += 1) {
        const slot = journeySlots[index];
        const generation = { ratio: "3:4", resolution: "1K", size: "768x1024", quality: "medium" };
        const generationScope = {
          accountId: ids.account, jobId: ids.job, itemId: journeyItem, planId: journeyDerivedPlan,
          visualGroupKey: slot.visualGroupKey, slotKey: slot.slotKey, expectedStatusVersion: 3,
        };
        const attemptIdentityHash = buildImageGenerationAttemptIdentity({
          scope: generationScope, plan: generationPlan, slot,
          preliminaryEvidence: [{
            assetId: journeySourceAsset, evidenceKind: "CONTENT_HASH", evidenceRefHash: sourceContentHash,
          }],
          profile: generationProfile, imageModel: "image-model", ...generation,
          templateVersion: "image-v1", regeneration: null,
        });
        const generationInput = buildImageGenerationInput({
          plan: generationPlan, slot, references: [sourceReference], profile: generationProfile,
          imageModel: "image-model", ...generation, templateVersion: "image-v1", regeneration: null,
        });
        const lease = await generationRepository.reserveGenerationAttempt({
          ...generationScope, attemptIdentityHash, generationSize: generation.size, maxAttempts: 3,
        });
        assert.equal(lease.status, "RESERVED");
        assert.equal((await generationRepository.bindGenerationAttemptInput({
          ...generationScope, attemptIdentityHash, inputHash: generationInput.inputHash,
          generationSize: generation.size, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
        })).status, "BOUND");
        const generatedContentHash = hash(`generated-${index}-${suffix}`);
        const checkerEvidence = evaluateGeneratedCheckerEvidence({
          checkerResult, references: [sourceReference], facts: [fact], checkerModel: "text-model",
          profile: { id: ids.profile, accountId: ids.account, configVersion: 1 },
          templateVersion: "image-v1", requestId: `checker-${index}-${suffix}`,
          generatedHash: generatedContentHash, checkerModelEvidence, textRequired: true,
        }).evidence;
        const modelEvidence = {
          requestedImageModel: "image-model", gatewayReportedImageModel: "image-model",
          gatewayReportedImageModelPresent: true, orchestratorModel: "",
        };
        const objectKey = buildGeneratedAssetObjectKey({
          ...generationScope, attemptIdentityHash, attemptNo: lease.attemptNo,
          inputHash: generationInput.inputHash, contentHash: generatedContentHash,
        });
        assert.equal((await generationRepository.recordStoredGenerationAsset({
          ...generationScope, attemptIdentityHash, inputHash: generationInput.inputHash,
          generationSize: generation.size, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
          objectKeyVersion: "ATTEMPT_V2", objectKey, contentHash: generatedContentHash,
          contentType: "image/png", width: 768, height: 1024, size: 2048,
        })).status, "GENERATING");
        const completed = await generationRepository.completeGenerationAttempt({
          ...generationScope, attemptIdentityHash, inputHash: generationInput.inputHash,
          generationSize: generation.size, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
          role: slot.role, objectKeyVersion: "ATTEMPT_V2", objectKey,
          contentHash: generatedContentHash, contentType: "image/png", width: 768, height: 1024, size: 2048,
          checkerEvidence, gatewayRequestId: `image-gateway-${index}-${suffix}`,
          checkerRequestId: `checker-${index}-${suffix}`, modelEvidence,
          profileId: ids.profile, profileVersion: 1, modelName: "image-model",
          promptHash: generationInput.promptHash, planHash, sourceHash, strategyHash, configHash,
          visualGroupsHash, promptTemplateVersion: "image-v1",
          sourceAssetEvidence: [sourceReference], regeneration: null,
        });
        assert.equal(completed.status, "ACCEPTED");
        acceptedAssets.push({
          assetId: completed.id, status: "ACCEPTED", accountId: ids.account, jobId: ids.job,
          itemId: journeyItem, planId: journeyDerivedPlan, visualGroupKey: slot.visualGroupKey,
          slotKey: slot.slotKey, role: slot.role, attemptIdentityHash, attemptNo: lease.attemptNo,
          inputHash: generationInput.inputHash, generationSize: generation.size,
          contentHash: generatedContentHash, objectKeyVersion: "ATTEMPT_V2", objectKey,
          contentType: "image/png", width: 768, height: 1024, size: 2048,
          gatewayRequestId: `image-gateway-${index}-${suffix}`,
          checkerRequestId: `checker-${index}-${suffix}`, modelEvidence,
          profileId: ids.profile, profileVersion: 1, modelName: "image-model",
          planHash, sourceHash, strategyHash, configHash, visualGroupsHash,
          promptTemplateVersion: "image-v1", promptHash: generationInput.promptHash,
          checkerEvidence, sourceAssetEvidence: [sourceReference], regeneration: null,
        });
        const imageResult = await workflow.applyPhaseOutcome({
          message: messageFor("GENERATE_IMAGE_SLOT", { slotKey: slot.slotKey }),
          outcome: acceptedOutcome("GENERATE_IMAGE_SLOT", "IMAGE_SLOT_ACCEPTED", journeyCorrelation),
        });
        assert.equal(imageResult.disposition, "APPLIED");
        assert.equal(imageResult.enqueued, index === journeySlots.length - 1 ? 1 : 0);
      }

      const richScope = {
        accountId: ids.account, jobId: ids.job, itemId: journeyItem, planId: journeyDerivedPlan,
      };
      const richIdentity = buildRichContentEvidenceIdentity({
        scope: richScope, planHash, sourceHash, sourceFactEvidence: [fact], assetEvidence: acceptedAssets,
        profileId: ids.profile, profileVersion: 1, modelName: "text-model", promptTemplateVersion: "rich-v1",
      });
      const richInputHash = buildRichContentAttemptInputHash(richIdentity.inputHash, 3);
      const richReservation = {
        ...richScope, expectedStatusVersion: 3,
        planHash, sourceHash, profileId: ids.profile, profileVersion: 1,
        modelName: "text-model", promptTemplateVersion: "rich-v1", sourceFactEvidence: [fact],
        assetEvidence: acceptedAssets, factRegistryHash: richIdentity.factRegistryHash,
        assetHash: richIdentity.assetHash, promptHash: richIdentity.promptHash, inputHash: richInputHash,
        requestEvidence: {
          requestKey: `auto-listing-rich-${richInputHash}`,
          schemaVersion: "AUTO_LISTING_RICH_CONTENT_V1",
        },
        maxAttempts: 3,
      };
      let richLeaseSequence = 0;
      const richRepository = createPostgresRichContentRepository({
        pool, token: () => `rich-lease-${++richLeaseSequence}-${suffix}`,
        id: () => `rich-result-${suffix}`,
      });
      const originalRichLease = await richRepository.reserveRichContentAttempt(richReservation);
      assert.equal(originalRichLease.status, "RESERVED");
      assert.equal((await richRepository.releaseRichContentAttempt({
        ...richReservation, ...originalRichLease,
        errorCode: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
      })).status, "GENERATING");
      await assert.rejects(richRepository.releaseRichContentAttempt({
        ...richReservation, ...originalRichLease,
        errorCode: "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED",
      }), (error) => error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID");
      const concurrentRich = await Promise.all([
        richRepository.reserveRichContentAttempt(richReservation),
        richRepository.reserveRichContentAttempt(richReservation),
      ]);
      const richLease = concurrentRich.find(({ status }) => status === "RESERVED");
      assert.ok(richLease);
      assert.equal(richLease.attemptNo, 1);
      assert.notEqual(richLease.leaseToken, originalRichLease.leaseToken);
      assert.equal(concurrentRich.filter(({ status }) => status === "IN_PROGRESS").length, 1);
      assert.deepEqual((await admin.query(
        `SELECT attempt_no,status,lease_token,error_code FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND input_hash=$4`,
        [ids.account, ids.job, journeyItem, richInputHash],
      )).rows, [{
        attempt_no: 1, status: "GENERATING", lease_token: richLease.leaseToken, error_code: null,
      }]);
      const richContent = {
        version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru",
        blocks: [
          { type: "HERO_IMAGE", assetId: acceptedAssets[0].assetId },
          { type: "HEADING", text: "Объём 500 мл", sourceFactIds: [fact.factId], factBindings: [{
            sourceFactId: fact.factId, field: fact.field, value: fact.value,
            numericValue: fact.numericValue, unit: fact.unit,
          }] },
          { type: "TEXT", text: "Объём 500 мл", sourceFactIds: [fact.factId], factBindings: [{
            sourceFactId: fact.factId, field: fact.field, value: fact.value,
            numericValue: fact.numericValue, unit: fact.unit,
          }] },
        ],
      };
      assert.equal((await richRepository.completeRichContentAttempt({
        ...richReservation, attemptNo: richLease.attemptNo, leaseToken: richLease.leaseToken,
        richContent, outputHash: digest(richContent),
        checkerResult: {
          accepted: true, validator: "AUTO_LISTING_RICH_CONTENT_V1",
          sourceFactIds: [fact.factId], assetIds: [acceptedAssets[0].assetId],
        },
        gatewayRequestId: `rich-gateway-${suffix}`,
        modelEvidence: {
          requestedTextModel: "text-model", gatewayReportedTextModel: "text-model",
          gatewayReportedTextModelPresent: true,
        },
      })).status, "ACCEPTED");
      assert.deepEqual(await workflow.applyPhaseOutcome({
        message: messageFor("GENERATE_RICH_CONTENT"),
        outcome: acceptedOutcome("GENERATE_RICH_CONTENT", "CONTENT_READY_FOR_REVIEW", journeyCorrelation),
      }), { disposition: "APPLIED", status: "READY_FOR_REVIEW", statusVersion: 4, enqueued: 0 });

      assert.deepEqual((await admin.query(
        "SELECT status,status_version FROM auto_listing_job_items WHERE account_id=$1 AND id=$2",
        [ids.account, journeyItem],
      )).rows[0], { status: "READY_FOR_REVIEW", status_version: 4 });
      assert.deepEqual((await admin.query(
        `SELECT phase,COUNT(*)::INTEGER AS count FROM auto_listing_ai_outbox
          WHERE account_id=$1 AND item_id=$2 GROUP BY phase ORDER BY phase`,
        [ids.account, journeyItem],
      )).rows, [
        { phase: "FINALIZE_MATERIALIZED_PLAN", count: 1 },
        { phase: "GENERATE_IMAGE_SLOT", count: 6 },
        { phase: "GENERATE_RICH_CONTENT", count: 1 },
        { phase: "MATERIALIZE_SOURCE_ASSET", count: 1 },
        { phase: "PLAN_CONTENT", count: 1 },
      ]);
      assert.equal((await admin.query(
        "SELECT COUNT(*)::INTEGER AS count FROM auto_listing_ai_outbox WHERE account_id=$1 AND item_id=$2 AND phase LIKE '%UPLOAD%'",
        [ids.account, journeyItem],
      )).rows[0].count, 0);

      const connected = {
        connection: `connection-${suffix}`, profile: `connected-profile-${suffix}`,
        job: `connected-job-${suffix}`, item: `connected-item-${suffix}`,
        outbox: `connected-outbox-${suffix}`, correlation: `connected-correlation-${suffix}`,
        channel: `connected-channel-${suffix}`,
      };
      await admin.query(
        `INSERT INTO ai_gateway_connection_versions (
           account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
           fingerprint,status,idempotency_key,request_hash,correlation_id,created_by
         ) VALUES ($1,$2,1,'Connected','https://gateway.invalid','ciphertext','iv','tag','aes-256-gcm','local-v1',
           $3,'PENDING',$4,$5,$6,$1)`,
        [ids.account, connected.connection, `fingerprint-${suffix}`, `connection-key-${suffix}`,
          "d".repeat(64), connected.correlation],
      );
      await admin.query(
        `UPDATE ai_gateway_connection_versions
            SET status='VALIDATED',status_version=2,validation_result='{"outcome":"PASSED"}'::JSONB,
                validation_hash=$3,validated_at=NOW(),validated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1`,
        [ids.account, connected.connection, "e".repeat(64)],
      );
      await admin.query(
        `UPDATE ai_gateway_connection_versions
            SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1`,
        [ids.account, connected.connection],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,connection_id,connection_version
         ) VALUES ($1,$2,'Connected','https://gateway.invalid','SUB2API_ENCRYPTED_KEY','SUB2API_RESPONSES',
           'SUB2API_OPENAI_IMAGES','text-model','image-model',1,FALSE,$3,1)`,
        [connected.profile, ids.account, connected.connection],
      );
      await admin.query(
        `INSERT INTO auto_listing_ai_profile_channels (
           account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,channel_order
         ) VALUES ($1,$2,1,$3,'Connected',$4,1,1)`,
        [ids.account, connected.profile, connected.channel, connected.connection],
      );
      await admin.query(
        `INSERT INTO auto_listing_jobs (
           id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
           strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,correlation_id
         ) VALUES ($1,$2,'COLLECT_BOX','CREATED',$3,'{}'::JSONB,$4,$5,$6,$7,1,$2,$8)`,
        [connected.job, ids.account, `connected-${suffix}`, "f".repeat(64), ids.strategy,
          ids.policy, connected.profile, connected.correlation],
      );
      await admin.query(
        `INSERT INTO auto_listing_job_items (
           id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order
         ) VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',2,1)`,
        [connected.item, connected.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );
      const connectedMessage = {
        contractVersion: "V1", accountId: ids.account, itemId: connected.item, phase: "PLAN_CONTENT",
        expectedStatusVersion: 2, correlationId: connected.correlation,
      };
      await admin.query(
        `INSERT INTO auto_listing_ai_outbox (
           id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
           expected_status_version,correlation_id,payload,next_retry_at
         ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PENDING','V1','PLAN_CONTENT',2,$6,$7::JSONB,NOW())`,
        [connected.outbox, ids.account, connected.job, connected.item,
          autoListingAiMessageDedupeKey(connectedMessage), connected.correlation, JSON.stringify(connectedMessage)],
      );
      const outboxRepository = createPostgresAiOutboxRepository({ pool });
      const adopt = async (relayOwner, workerOwner, workerToken) => {
        const [claim] = await outboxRepository.claimAutoListingAiWork({
          accountId: ids.account, workerId: relayOwner, limit: 1, leaseMs: 60_000,
        });
        assert.ok(claim);
        await outboxRepository.markAutoListingAiWorkPublished({
          accountId: claim.accountId, itemId: claim.itemId, id: claim.id,
          workerId: claim.leaseOwner, leaseToken: claim.leaseToken, publicationId: claim.publicationId,
        });
        return outboxRepository.adoptAutoListingAiWork({
          accountId: claim.accountId, itemId: claim.itemId, id: claim.id,
          publicationId: claim.publicationId,
          dispatchGeneration: claim.workMessage.execution.dispatchGeneration,
          relayOwner: claim.leaseOwner, relayToken: claim.leaseToken,
          workerId: workerOwner, workerLeaseToken: workerToken, leaseMs: 60_000,
        });
      };
      const firstAdopted = await adopt("relay-one", "worker-one", "worker-token-one");
      assert.deepEqual(await workflow.requeueChannelFailure({
        message: connectedMessage,
        outcome: {
          contractVersion: "V1", disposition: "RETRY", phase: "PLAN_CONTENT", outcome: "FAILED",
          retryable: true, failureCode: "AI_GATEWAY_UNAUTHORIZED", correlationId: connected.correlation,
          failureScope: "CHANNEL_REVALIDATION", deliveryState: "NOT_SENT", retryAfterMs: null,
        },
        execution: firstAdopted.workMessage.execution,
      }), { disposition: "REQUEUED", status: "PLANNING", statusVersion: 2,
        enqueued: 0, uncertainResultCount: 0 });
      assert.deepEqual((await admin.query(
        `SELECT o.state,o.uncertain_result_count,o.publication_id,c.requires_revalidation,
                c.assigned_item_id,c.execution_lease_owner
           FROM auto_listing_ai_outbox o
           JOIN auto_listing_ai_profile_channels c ON c.account_id=o.account_id AND c.channel_id=$3
          WHERE o.account_id=$1 AND o.id=$2`,
        [ids.account, connected.outbox, connected.channel],
      )).rows[0], {
        state: "PENDING", uncertain_result_count: 0, publication_id: null,
        requires_revalidation: true, assigned_item_id: null, execution_lease_owner: null,
      });

      await admin.query(
        `UPDATE auto_listing_ai_profile_channels
            SET requires_revalidation=FALSE,cooldown_until=NULL
          WHERE account_id=$1 AND channel_id=$2`,
        [ids.account, connected.channel],
      );
      await admin.query(
        "UPDATE auto_listing_ai_outbox SET uncertain_result_count=1 WHERE account_id=$1 AND id=$2",
        [ids.account, connected.outbox],
      );
      const secondAdopted = await adopt("relay-two", "worker-two", "worker-token-two");
      assert.deepEqual(await workflow.requeueChannelFailure({
        message: connectedMessage,
        outcome: {
          contractVersion: "V1", disposition: "RETRY", phase: "PLAN_CONTENT", outcome: "FAILED",
          retryable: true, failureCode: "INVALID_GATEWAY_RESPONSE", correlationId: connected.correlation,
          failureScope: "CHANNEL_TRANSIENT", deliveryState: "POSSIBLY_SENT", retryAfterMs: null,
        },
        execution: secondAdopted.workMessage.execution,
      }), { disposition: "APPLIED", status: "RETRYABLE_ERROR", statusVersion: 3, enqueued: 0 });
      assert.deepEqual((await admin.query(
        `SELECT i.status,i.failure_code,o.state,o.uncertain_result_count,c.assigned_item_id,c.execution_lease_owner
           FROM auto_listing_job_items i
           JOIN auto_listing_ai_outbox o ON o.account_id=i.account_id AND o.item_id=i.id
           JOIN auto_listing_ai_profile_channels c ON c.account_id=i.account_id AND c.channel_id=$3
          WHERE i.account_id=$1 AND i.id=$2`,
        [ids.account, connected.item, connected.channel],
      )).rows[0], {
        status: "RETRYABLE_ERROR", failure_code: "AUTO_LISTING_AI_RESULT_UNCERTAIN",
        state: "COMPLETED", uncertain_result_count: 2,
        assigned_item_id: null, execution_lease_owner: null,
      });
    } finally {
      await pool?.end();
      try { await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`); } catch {}
      admin.release();
      await adminPool.end();
    }
  });
}
