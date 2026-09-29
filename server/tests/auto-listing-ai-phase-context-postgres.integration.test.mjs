import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import {
  createPostgresAutoListingAiPhaseContextLoader,
  projectAutoListingGenerationReferences,
} from "../auto-listing-ai-phase-context-postgres.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const connectionString = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_POSTGRES_TESTS === "1" && Boolean(connectionString);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const H = (character) => character.repeat(64);

function message(ids, phase, overrides = {}) {
  return { message: {
    contractVersion: "V1", accountId: ids.accountA, itemId: ids.item, phase,
    expectedStatusVersion: 7, correlationId: `correlation-${ids.suffix}`,
    ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: "source-a" } : {}),
    ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: "main-1" } : {}),
    ...overrides,
  }, execution: null };
}

const inert = () => ({ name: "inert" });

if (!enabled) {
  test("phase-context PostgreSQL integration requires both explicit nonproduction gates", {
    skip: "requires AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("production phase-context loader is closed and scoped through all five phases", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const adminPool = new Pool({ connectionString, max: 1 });
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `auto_listing_phase_context_${suffix}`;
    const schemaSql = quote(schema);
    const ids = Object.fromEntries(["accountA", "accountB", "store", "warehouse", "strategy", "snapshot", "job", "item", "profile", "parent", "derived"]
      .map((key) => [key, `${key}-${suffix}`]));
    ids.suffix = suffix;
    let scopedPool;
    try {
      await admin.query(`CREATE SCHEMA ${schemaSql}`);
      await admin.query(`SET search_path TO ${schemaSql}, public`);
      for (const migration of (await readdir(migrationsDir))
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort()) {
        await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      scopedPool = new Pool({
        connectionString,
        max: 4,
        options: `-c search_path=${schema},public`,
      });

      for (const accountId of [ids.accountA, ids.accountB]) {
        await admin.query(
          "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
          [accountId, `user-${accountId}`],
        );
      }
      await admin.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [ids.store, `Store ${suffix}`, `client-${suffix}`, ids.accountA],
      );
      await admin.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [ids.warehouse, ids.store, `platform-${suffix}`],
      );
      await admin.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'PUBLISHED','{}'::JSONB,$3)",
        [ids.strategy, ids.accountA, H("a")],
      );

      const source = buildAutoListingSourceSnapshot({
        accountId: ids.accountA, sourceType: "COLLECT_BOX", sourceRecordId: `record-${suffix}`, sourceVersion: "1",
        collectItem: { id: `record-${suffix}`, accountId: ids.accountA, listingDraft: {
          sku: "sku-a", title: "Товар A", brand: "Brand A",
          categoryResolution: { status: "MATCHED", method: "taxonomy", target: { storeId: ids.store, descriptionCategoryId: "170", typeId: "99" } },
          descriptionCategoryId: "170", typeId: "99", currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
          attributes: [], logistics: { length: 10, width: 10, height: 10, dimensionUnit: "mm" }, productMeasurements: {},
          images: [{ assetId: "source-a", contentHash: H("3") }],
          variants: [{ sku: "sku-a", offerId: "offer-a", name: "Товар A", images: [{ assetId: "source-a", contentHash: H("3") }] }],
        } },
        categoryEvidence: {
          id: `category-evidence-${suffix}`, accountId: ids.accountA,
          sourceDescriptionCategoryId: 170, sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
        },
        sharedCategory: {
          id: `shared-category-${suffix}`, accountId: ids.accountA, version: 1,
          evidenceId: `category-evidence-${suffix}`, status: "ACTIVE", source: "SOURCE_DIRECT",
          sourceDescriptionCategoryId: 170, sourceTypeId: 99,
          currentDescriptionCategoryId: 170, currentTypeId: 99,
          taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
        },
        targetStoreId: ids.store,
        targetStoreCurrency: "RUB",
        productDraft: { id: `draft-${suffix}`, version: 1 }, rawResponseRef: `raw-${suffix}`, rawResponseHash: H("9"),
      });
      const frozen = normalizeAndHashAutoListingConfig({
        targetStoreId: ids.store, targetWarehouseId: ids.warehouse, stock: 5, priceAdjustmentKopecks: "0",
        image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
          roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 } },
      });
      await admin.query(
        `INSERT INTO auto_listing_source_snapshots
           (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref)
         VALUES ($1,$2,'COLLECT_BOX',$3,'1',$4::JSONB,$5,$6)`,
        [ids.snapshot, ids.accountA, `record-${suffix}`, JSON.stringify(source.snapshot), source.snapshotHash, source.rawResponseRef],
      );
      await admin.query(
        `INSERT INTO ai_gateway_profiles
           (id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version,enabled)
         VALUES ($1,$2,'Profile','https://gateway.invalid','TEST_AI_KEY','SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model','image-model',3,TRUE)`,
        [ids.profile, ids.accountA],
      );
      await admin.query(
        `INSERT INTO auto_listing_jobs
           (id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,
            ai_profile_id,ai_profile_version,correlation_id)
         VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,$4::JSONB,$5,$6,$7,3,$8)`,
        [ids.job, ids.accountA, `idem-${suffix}`, JSON.stringify(frozen.config), frozen.configHash,
          ids.strategy, ids.profile, `correlation-${suffix}`],
      );
      await admin.query(
        `INSERT INTO auto_listing_job_items
           (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order)
         VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)`,
        [ids.item, ids.job, ids.accountA, ids.snapshot, ids.store, ids.warehouse],
      );
      const options = {
        pool: scopedPool,
        gateway: inert(), contentPlanRepository: inert(), contentPlanEvidenceRepository: inert(), sourceMaterializationRepository: inert(),
        generationRepository: inert(), richContentRepository: inert(), downloader: inert(), storage: inert(),
        sourceAssetLoader: inert(), logger: null, planPromptTemplateVersion: "planner-v1",
        referenceProjector: projectAutoListingGenerationReferences,
        prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
        maxAttempts: 3, richContentMaxAttempts: 5, richContentLeaseOwner: "rich-worker",
      };
      const countedPool = {
        calls: 0,
        async query(sql, values) { return scopedPool.query(sql, values); },
        async connect() {
          const client = await scopedPool.connect();
          return {
            query: async (sql, values) => {
              if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) countedPool.calls += 1;
              return client.query(sql, values);
            },
            release: () => client.release(),
          };
        },
      };
      const staleLoader = createPostgresAutoListingAiPhaseContextLoader({ ...options, pool: countedPool });
      const stale = await staleLoader(message(ids, "PLAN_CONTENT", { expectedStatusVersion: 6 }));
      assert.equal(countedPool.calls, 1, "stale reload must not read source, strategy, profile, or plan rows");
      assert.deepEqual(stale.phaseInput, {});
      assert.equal(await staleLoader(message(ids, "PLAN_CONTENT", { accountId: ids.accountB })), null);

      const loader = createPostgresAutoListingAiPhaseContextLoader(options);
      const planned = await loader(message(ids, "PLAN_CONTENT"));
      assert.equal(planned.phaseInput.sourceSnapshotId, ids.snapshot);
      assert.equal(planned.phaseInput.gatewayProfile.id, ids.profile);
      assert.equal(planned.phaseInput.configCapture.configHash, frozen.configHash);

      const v3 = {
        profile: `profile-v3-${suffix}`,
        connection: `connection-v3-${suffix}`,
        snapshot: `snapshot-v3-${suffix}`,
        job: `job-v3-${suffix}`,
        item: `item-v3-${suffix}`,
        channel: `channel-v3-${suffix}`,
        outbox: `outbox-v3-${suffix}`,
        leaseOwner: `worker-v3-${suffix}`,
        leaseToken: `lease-v3-${suffix}`,
      };
      await admin.query(
        `INSERT INTO ai_gateway_connection_versions (
           account_id,id,version,display_name,base_url,ciphertext,iv,auth_tag,algorithm,key_version,
           fingerprint,status,status_version,idempotency_key,request_hash,correlation_id,created_by
         ) VALUES ($1,$2,1,'V3 connection','https://leased-gateway.invalid','cipher','iv','tag',
           'aes-256-gcm','key-1',$3,'PENDING',1,$4,$5,$6,$1)`,
        [ids.accountA, v3.connection, H("c"), `connection-v3-key-${suffix}`, H("d"),
          `connection-v3-correlation-${suffix}`],
      );
      const v3Validation = { outcome: "PASSED", connectionId: v3.connection, connectionVersion: 1 };
      assert.equal((await admin.query(
        `UPDATE ai_gateway_connection_versions
            SET status='VALIDATED',status_version=2,validation_result=$3::JSONB,validation_hash=$4,
                validated_at=NOW(),validated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1 AND status='PENDING' AND status_version=1`,
        [ids.accountA, v3.connection, JSON.stringify(v3Validation),
          crypto.createHash("sha256").update(JSON.stringify(v3Validation)).digest("hex")],
      )).rowCount, 1);
      assert.equal((await admin.query(
        `UPDATE ai_gateway_connection_versions
            SET status='ACTIVE',status_version=3,activated_at=NOW(),activated_by=$1
          WHERE account_id=$1 AND id=$2 AND version=1 AND status='VALIDATED' AND status_version=2`,
        [ids.accountA, v3.connection],
      )).rowCount, 1);
      await admin.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled,connection_id,connection_version
         ) VALUES ($1,$2,'V3 Profile','https://profile-fallback.invalid','SUB2API_ENCRYPTED_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model-v3','image-model-v3',4,FALSE,$3,1)`,
        [v3.profile, ids.accountA, v3.connection],
      );
      await admin.query(
        `INSERT INTO auto_listing_source_snapshots
           (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref)
         VALUES ($1,$2,'COLLECT_BOX',$3,'1',$4::JSONB,$5,$6)`,
        [v3.snapshot, ids.accountA, `record-v3-${suffix}`, JSON.stringify(source.snapshot),
          source.snapshotHash, source.rawResponseRef],
      );
      await admin.query(
        `INSERT INTO auto_listing_jobs (
           id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,strategy_version_id,
           ai_profile_id,ai_profile_version,correlation_id
         ) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,$4::JSONB,$5,$6,$7,4,$8)`,
        [v3.job, ids.accountA, `idem-v3-${suffix}`, JSON.stringify(frozen.config), frozen.configHash,
          ids.strategy, v3.profile, `correlation-v3-${suffix}`],
      );
      await admin.query(
        `INSERT INTO auto_listing_job_items
           (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,source_order)
         VALUES ($1,$2,$3,$4,$5,$6,'PLANNING',7,1)`,
        [v3.item, v3.job, ids.accountA, v3.snapshot, ids.store, ids.warehouse],
      );
      await admin.query(
        `INSERT INTO auto_listing_ai_profile_channels (
           account_id,profile_id,profile_version,channel_id,display_name,connection_id,connection_version,
           channel_order,assigned_job_id,assigned_item_id,assigned_status_version,assigned_at,
           execution_lease_owner,execution_lease_token,execution_lease_expires_at
         ) VALUES ($1,$2,4,$3,'V3 Channel',$4,1,1,$5,$6,7,NOW(),$7,$8,'2099-01-01T00:00:00.000Z')`,
        [ids.accountA, v3.profile, v3.channel, v3.connection, v3.job, v3.item,
          v3.leaseOwner, v3.leaseToken],
      );
      const v3Message = {
        contractVersion: "V1", accountId: ids.accountA, itemId: v3.item, phase: "PLAN_CONTENT",
        expectedStatusVersion: 7, correlationId: `correlation-v3-${suffix}`,
      };
      const v3DedupeKey = H("e");
      await admin.query(
        `INSERT INTO auto_listing_ai_outbox (
           id,account_id,job_id,item_id,event_type,dedupe_key,state,contract_version,phase,
           expected_status_version,correlation_id,payload,next_retry_at,lease_owner,lease_token,
           lease_expires_at,dispatch_contract_version,dispatch_generation,publication_id,dispatch_queued_at
         ) VALUES ($1,$2,$3,$4,'PLAN_CONTENT',$5,'PROCESSING','V1','PLAN_CONTENT',7,$6,$7::JSONB,NOW(),
           $8,$9,'2099-01-01T00:00:00.000Z','CHANNEL_WORK_V1',4,$10,NOW())`,
        [v3.outbox, ids.accountA, v3.job, v3.item, v3DedupeKey, v3Message.correlationId,
          JSON.stringify(v3Message), v3.leaseOwner, v3.leaseToken, `${v3DedupeKey}:4`],
      );
      const v3Execution = {
        outboxId: v3.outbox, dispatchGeneration: 4, channelId: v3.channel,
        connectionId: v3.connection, connectionVersion: 1,
        leaseOwner: v3.leaseOwner, leaseToken: v3.leaseToken,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      };
      const exactV3 = await loader({ message: v3Message, execution: v3Execution });
      assert.equal(exactV3.phaseInput.gatewayProfile.id, v3.profile);
      assert.equal(exactV3.phaseInput.gatewayProfile.textModel, "text-model-v3");
      assert.equal(exactV3.phaseInput.gatewayProfile.imageModel, "image-model-v3");
      assert.equal(exactV3.phaseInput.gatewayProfile.baseUrl, "https://leased-gateway.invalid");
      assert.equal(exactV3.phaseInput.gatewayProfile.connectionId, v3.connection);
      assert.equal(exactV3.phaseInput.gatewayProfile.connectionVersion, 1);
      assert.deepEqual(exactV3.phaseInput.gatewayExecution, {
        channelId: v3.channel, connectionId: v3.connection, connectionVersion: 1, idleTimeoutMs: 300_000,
      });
      const assertNoV3Fallback = async (executionOverrides = {}) => {
        await assert.rejects(loader({
          message: v3Message, execution: { ...v3Execution, ...executionOverrides },
        }), { code: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID", retryable: false });
      };
      assert.equal(await loader({
        message: { ...v3Message, accountId: ids.accountB }, execution: v3Execution,
      }), null);
      await assertNoV3Fallback({ channelId: `wrong-${v3.channel}` });
      await assertNoV3Fallback({ connectionId: `wrong-${v3.connection}` });
      await assertNoV3Fallback({ connectionVersion: 2 });
      await assertNoV3Fallback({ leaseOwner: `wrong-${v3.leaseOwner}` });
      await assertNoV3Fallback({ leaseToken: `wrong-${v3.leaseToken}` });
      await admin.query(
        "UPDATE auto_listing_ai_profile_channels SET assigned_status_version=6 WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
        [ids.accountA, v3.profile, v3.channel],
      );
      await assertNoV3Fallback();
      await admin.query(
        "UPDATE auto_listing_ai_profile_channels SET assigned_status_version=7 WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
        [ids.accountA, v3.profile, v3.channel],
      );
      await admin.query(
        `UPDATE auto_listing_ai_profile_channels
            SET assigned_job_id=$1,assigned_item_id=$2,assigned_status_version=7,assigned_at=NOW()
          WHERE account_id=$3 AND profile_id=$4 AND channel_id=$5`,
        [ids.job, ids.item, ids.accountA, v3.profile, v3.channel],
      );
      await assertNoV3Fallback();
      await admin.query(
        `UPDATE auto_listing_ai_profile_channels
            SET assigned_job_id=$1,assigned_item_id=$2,assigned_status_version=7,assigned_at=NOW()
          WHERE account_id=$3 AND profile_id=$4 AND channel_id=$5`,
        [v3.job, v3.item, ids.accountA, v3.profile, v3.channel],
      );
      await admin.query(
        "UPDATE auto_listing_ai_profile_channels SET execution_lease_expires_at=NOW()-INTERVAL '1 second' WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
        [ids.accountA, v3.profile, v3.channel],
      );
      await assertNoV3Fallback();
      await admin.query(
        "UPDATE auto_listing_ai_profile_channels SET execution_lease_expires_at='2099-01-01T00:00:00.000Z' WHERE account_id=$1 AND profile_id=$2 AND channel_id=$3",
        [ids.accountA, v3.profile, v3.channel],
      );
      await admin.query(
        `UPDATE auto_listing_ai_profile_channels SET profile_id=$1,profile_version=3
          WHERE account_id=$2 AND profile_id=$3 AND channel_id=$4`,
        [ids.profile, ids.accountA, v3.profile, v3.channel],
      );
      await assertNoV3Fallback();
      await admin.query(
        `UPDATE auto_listing_ai_profile_channels SET profile_id=$1,profile_version=4
          WHERE account_id=$2 AND profile_id=$3 AND channel_id=$4`,
        [v3.profile, ids.accountA, ids.profile, v3.channel],
      );

      const slots = [
        ["main-1", "MAIN", 1], ["sell-1", "SELLING_POINT", 2], ["sell-2", "SELLING_POINT", 3],
        ["detail-1", "DETAIL", 4], ["scene-1", "SCENE", 5], ["info-1", "INFOGRAPHIC", 6],
      ].map(([slotKey, role, order]) => ({
        slotKey, visualGroupKey: "group-a", role, order, textDensity: role === "MAIN" ? "NONE" : "LIGHT",
        claims: [], sourceFactIds: ["fact-a"], referenceAssetIds: ["source-a"], preserve: ["Товар A"],
        prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
      }));
      const planDocument = { version: 1, language: "ru", slots };
      const factRegistry = [{ factId: "fact-a", field: "identity.primaryName", kind: "IDENTITY_NAME", value: "Товар A",
        numericValue: null, unit: null, sourcePath: "identity.primaryName", dictionaryValueId: null, visualGroupKeys: ["group-a"] }];
      const parentVisual = { sourceHash: source.snapshotHash, reasonCodes: [], visualGroupsHash: H("4"), groups: [{
        visualGroupKey: "group-a", sourceSkus: ["sku-a"], variantIds: ["variant-a"], factEvidence: [], reasonCodes: [],
        referenceImages: [{ assetId: "source-a", sourceRefHash: H("8"), sourceRef: null, contentHash: null, evidenceKind: "SOURCE_REF_HASH" }],
      }] };
      await admin.query(
        `INSERT INTO ai_content_plans
           (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,strategy_hash,config_hash,
            source_hash,input_hash,planner_model,profile_version,prompt_template_version,plan,plan_hash,
            visual_groups_hash,visual_groups,fact_registry_hash,fact_registry,regeneration,gateway_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'text-model',3,'planner-v1',$12::JSONB,$13,$14,$15::JSONB,$16,$17::JSONB,NULL,$18)`,
        [ids.parent, ids.accountA, ids.job, ids.item, ids.snapshot, ids.strategy, ids.profile, H("2"), frozen.configHash,
          source.snapshotHash, H("5"), JSON.stringify(planDocument), H("6"), H("4"), JSON.stringify(parentVisual),
          H("7"), JSON.stringify(factRegistry), `gateway-plan-${suffix}`],
      );
      await admin.query(
        "UPDATE auto_listing_job_items SET active_content_plan_id=$1 WHERE account_id=$2 AND job_id=$3 AND id=$4",
        [ids.parent, ids.accountA, ids.job, ids.item],
      );
      const material = await loader(message(ids, "MATERIALIZE_SOURCE_ASSET"));
      assert.equal(material.phaseInput.parentPlan.id, ids.parent);
      assert.equal(material.phaseInput.sourceSnapshot.sourceSnapshotId, ids.snapshot);
      const finalize = await loader(message(ids, "FINALIZE_MATERIALIZED_PLAN"));
      assert.equal(finalize.phaseInput.parentPlan.id, ids.parent);

      const derivedVisual = structuredClone(parentVisual);
      derivedVisual.visualGroupsHash = H("b");
      derivedVisual.groups[0].referenceImages[0] = {
        assetId: "source-a", sourceRefHash: H("8"), sourceRef: null, contentHash: H("3"), evidenceKind: "CONTENT_HASH",
      };
      await admin.query(
        `INSERT INTO ai_content_plans
           (id,account_id,job_id,item_id,source_snapshot_id,strategy_version_id,profile_id,strategy_hash,config_hash,
            source_hash,input_hash,planner_model,profile_version,prompt_template_version,plan,plan_hash,
            visual_groups_hash,visual_groups,fact_registry_hash,fact_registry,regeneration,gateway_request_id,
            parent_plan_id,derivation_kind,materialization_set_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'text-model',3,'planner-v1',$12::JSONB,$13,$14,$15::JSONB,$16,$17::JSONB,NULL,$18,$19,'SOURCE_MATERIALIZATION',$20)`,
        [ids.derived, ids.accountA, ids.job, ids.item, ids.snapshot, ids.strategy, ids.profile, H("2"), frozen.configHash,
          source.snapshotHash, H("c"), JSON.stringify(planDocument), H("6"), H("b"), JSON.stringify(derivedVisual),
          H("7"), JSON.stringify(factRegistry), `gateway-plan-${suffix}`, ids.parent, H("d")],
      );
      await admin.query(
        "UPDATE auto_listing_job_items SET active_content_plan_id=$1,status='GENERATING' WHERE account_id=$2 AND job_id=$3 AND id=$4",
        [ids.derived, ids.accountA, ids.job, ids.item],
      );
      const image = await loader(message(ids, "GENERATE_IMAGE_SLOT"));
      assert.equal(image.phaseInput.plan.id, ids.derived);
      assert.equal(image.phaseInput.slot.slotKey, "main-1");
      assert.equal(image.phaseInput.size, "768x1024");

      async function insertAccepted(index, { duplicateSlot = false } = {}) {
        const slot = slots[duplicateSlot ? 0 : index];
        const marker = duplicateSlot ? "f" : String(index + 1);
        const attemptIdentityHash = H(marker);
        const inputHash = H(duplicateSlot ? "e" : String.fromCharCode(97 + index));
        const contentHash = H(duplicateSlot ? "d" : "c");
        const objectKey = buildGeneratedAssetObjectKey({
          accountId: ids.accountA, jobId: ids.job, itemId: ids.item, planId: ids.derived,
          visualGroupKey: slot.visualGroupKey, slotKey: slot.slotKey, attemptIdentityHash, attemptNo: duplicateSlot ? 2 : 1,
          inputHash, contentHash,
        });
        await admin.query(
          `INSERT INTO ai_generation_assets
             (id,account_id,job_id,item_id,plan_id,profile_id,visual_group_key,slot_key,role,input_hash,
              attempt_no,status,gateway_request_id,model_name,profile_version,prompt_hash,object_key,content_hash,
              content_type,width,height,checker_result,accepted_at,plan_hash,source_hash,strategy_hash,config_hash,
              visual_groups_hash,prompt_template_version,source_asset_evidence,checker_request_id,model_evidence,
              regeneration,size_bytes,attempt_identity_hash,generation_size,final_input_bound_at,object_key_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACCEPTED',$12,'image-model',3,$13,$14,$15,
             'image/png',768,1024,$16::JSONB,NOW(),$17,$18,$19,$20,$21,'planner-v1',$22::JSONB,$23,$24::JSONB,
             NULL,1024,$25,'768x1024',NOW(),'ATTEMPT_V2')`,
          [`asset-${marker}-${suffix}`, ids.accountA, ids.job, ids.item, ids.derived, ids.profile,
            slot.visualGroupKey, slot.slotKey, slot.role, inputHash, duplicateSlot ? 2 : 1,
            `gateway-${marker}`, H("9"), objectKey, contentHash, JSON.stringify({ accepted: true }),
            H("6"), source.snapshotHash, H("2"), frozen.configHash, H("b"),
            JSON.stringify([{ assetId: "source-a", contentHash: H("3"), contentType: "image/png", width: 768, height: 1024, size: 1024 }]),
            `checker-${marker}`, JSON.stringify({ requestedImageModel: "image-model" }), attemptIdentityHash],
        );
      }
      for (let index = 0; index < slots.length; index += 1) await insertAccepted(index);
      const rich = await loader(message(ids, "GENERATE_RICH_CONTENT"));
      assert.equal(rich.phaseInput.plan.id, ids.derived);
      assert.equal(rich.phaseInput.acceptedAssets.length, 6);
      assert.ok(rich.phaseInput.acceptedAssets.every((asset) => asset.accountId === ids.accountA
        && asset.jobId === ids.job && asset.itemId === ids.item && asset.planId === ids.derived));

      await insertAccepted(0, { duplicateSlot: true });
      const retriedRich = await loader(message(ids, "GENERATE_RICH_CONTENT"));
      assert.equal(retriedRich.phaseInput.acceptedAssets.length, 6);
      assert.deepEqual(Object.fromEntries(retriedRich.phaseInput.acceptedAssets.map((asset) => [asset.slotKey, asset.id])), {
        "main-1": `asset-f-${suffix}`,
        "sell-1": `asset-2-${suffix}`,
        "sell-2": `asset-3-${suffix}`,
        "detail-1": `asset-4-${suffix}`,
        "scene-1": `asset-5-${suffix}`,
        "info-1": `asset-6-${suffix}`,
      });
    } finally {
      try {
        await scopedPool?.end();
        await admin.query("SET search_path TO public");
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      } finally {
        admin.release();
        await adminPool.end();
      }
    }
  });
}
