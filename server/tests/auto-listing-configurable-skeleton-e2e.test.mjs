import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { applyAutoListingAiPhaseOutcome } from "../auto-listing-ai-workflow-postgres.mjs";
import { orchestrateAutoListingAiPhase } from "../auto-listing-ai-orchestrator.mjs";
import { createContentPlan, buildPlannerInput } from "../auto-listing-content-planner.mjs";
import { buildContentPlanFillSchema, buildFixedSkeleton } from "../auto-listing-fixed-skeleton.mjs";
import { selectAutoListingPlanningContract } from "../auto-listing-planning-contract.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import { buildVisualGroups } from "../auto-listing-visual-groups.mjs";

const databaseUrl = process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
const enabled = process.env.AUTO_LISTING_CONFIGURABLE_SKELETON_PG_TESTS === "1" && Boolean(databaseUrl);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const H = (digit) => digit.repeat(64);
const gatewayExecution = Object.freeze({
  channelId: "channel-a",
  connectionId: "connection-a",
  connectionVersion: 3,
  idleTimeoutMs: 300_000,
});
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("configurable fixed-skeleton migration suite tracks the latest migration without weakening its 074 upgrade coverage", async () => {
  const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
  assert.equal(migrations.includes("076_auto_listing_category_strategy_analysis_edits.sql"), true);
  assert.equal(migrations.at(-1), "101_manual_category_confirmation_product_revision.sql");
});

const roles = Object.freeze({
  six: Object.freeze({ main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 }),
  eight: Object.freeze({ main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 }),
  thirteen: Object.freeze({ main: 1, sellingPoint: 5, detail: 2, scene: 2, specification: 1, infographic: 2 }),
});

function sourceCapture({ reliableDimensions = true } = {}) {
  return buildAutoListingSourceSnapshot({
    accountId: "account-a",
    sourceType: "COLLECT_BOX",
    sourceRecordId: "collect-pilot",
    sourceVersion: "draft:7",
    targetStoreId: "store-a",
    targetStoreCurrency: "RUB",
    categoryEvidence: {
      id: "category-evidence-a", accountId: "account-a",
      sourceDescriptionCategoryId: 170, sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
    },
    sharedCategory: {
      id: "shared-category-a", accountId: "account-a", version: 4,
      evidenceId: "category-evidence-a", status: "ACTIVE", source: "SOURCE_DIRECT",
      sourceDescriptionCategoryId: 170, sourceTypeId: 99,
      currentDescriptionCategoryId: 170, currentTypeId: 99,
      taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null,
    },
    collectItem: { id: "collect-pilot", accountId: "account-a", listingDraft: {
      sku: "sku-a", title: "Термокружка", brand: "Бренд",
      descriptionCategoryId: "170", typeId: "99", currency: "RUB",
      blackKopecks: "10000", greenKopecks: "8000", attributes: [],
      categoryResolution: { status: "MATCHED", method: "taxonomy", target: {
        storeId: "store-a", descriptionCategoryId: "170", typeId: "99",
      } },
      logistics: { length: 220, width: 80, height: 80, dimensionUnit: "mm" },
      productMeasurements: reliableDimensions
        ? { reliable: true, heightCm: 22, unit: "cm", source: "manufacturer" } : {},
      images: [{ assetId: "source-a", contentHash: H("a") }],
      variants: [{
        sku: "sku-a", offerId: "offer-a", name: "Термокружка",
        images: [{ assetId: "source-a", contentHash: H("a") }],
        evidence: {
          contractVersion: 1, variantId: "variant-a", appearanceStatus: "COMPLETE",
          appearanceFacts: [
            { factId: "fact.color.red", kind: "COLOR", value: "красный" },
            { factId: "fact.material.steel", kind: "MATERIAL", value: "сталь" },
          ],
          sizeFacts: reliableDimensions
            ? [{ factId: "fact.size.a", kind: "SIZE", value: "средний" }] : [],
        },
      }],
    } },
    productDraft: { id: "draft-a", version: 7 },
    rawResponseRef: "raw-a", rawResponseHash: H("b"),
  });
}

function plannerArgs(roleCounts, source = sourceCapture()) {
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5,
    priceAdjustmentKopecks: "0",
    image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru", roles: roleCounts },
  });
  const strategySnapshot = {
    strategyId: "strategy-a", strategyVersionId: "strategy-version-a", ruleId: null,
    matchedBy: "DEFAULT", style: "BALANCED_DEFAULT", textDensityByRole: {
      main: "NONE", sellingPoint: "MEDIUM", detail: "LIGHT", scene: "LIGHT",
      specification: "HEAVY", infographic: "MEDIUM",
    },
    evidence: { targetDescriptionCategoryId: "170", matchedValue: "BALANCED_DEFAULT" },
  };
  return {
    sourceCapture: source,
    strategyCapture: { strategySnapshot, strategyHash: hash(strategySnapshot) },
    configCapture: { configSnapshot: config, configHash },
    visualGroupsCapture: buildVisualGroups({ sourceCapture: source }),
    promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_V3",
    prohibitedClaims: ["CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY"],
    regeneration: null,
  };
}

function validFill(skeleton) {
  const schema = buildContentPlanFillSchema(skeleton);
  return {
    version: 1,
    language: "ru",
    fills: Object.fromEntries(skeleton.plan.slots.map((slot) => {
      const minimum = schema.properties.fills.properties[slot.slotKey].properties.claims.minItems;
      const allowed = skeleton.allowedClaimsBySlot[slot.slotKey];
      const ordered = slot.role === "SPECIFICATION"
        ? [...allowed].sort((left, right) => Number(!/DIMENSION_|размер/iu.test(`${left.kind} ${left.value}`))
          - Number(!/DIMENSION_|размер/iu.test(`${right.kind} ${right.value}`)))
        : allowed;
      return [slot.slotKey, { claims: ordered.slice(0, minimum).map((fact) => ({
        text: fact.value,
        claimType: fact.kind,
        sourceFactIds: [fact.factId],
      })) }];
    })),
  };
}

async function planFixed(roleCounts, counters, mutateFill = (value) => value, source = sourceCapture()) {
  const args = plannerArgs(roleCounts, source);
  const context = buildPlannerInput({
    ...args,
    profileRef: { id: "profile-a", configVersion: 3, textModel: "text-model-a" },
    promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
  });
  const skeleton = buildFixedSkeleton({ plannerContext: context });
  const fill = mutateFill(structuredClone(validFill(skeleton)));
  const evidence = { response: null, validation: null };
  const repository = {
    async reserveContentPlan(input) {
      counters.reservations += 1;
      return {
        status: "RESERVED", attemptId: `attempt-${counters.reservations}`, attemptNo: 1,
        reservationToken: `lease-${counters.reservations}`, inputHash: input.inputHash,
        planningContract: "FIXED_SKELETON_V1", skeletonHash: input.skeletonHash,
        plannerStage: "BUILDING_SKELETON",
      };
    },
    async advanceContentPlanStage(input) { return { plannerStage: input.toStage }; },
    async saveContentPlan(input) { counters.savedPlans += 1; return { id: `plan-${counters.savedPlans}`, ...input }; },
    async releaseContentPlanReservation() { counters.releases += 1; },
    async releaseContentPlanChannelReservation() { return { released: true }; },
  };
  const evidenceRepository = {
    async loadOutcome() { return evidence.response ? evidence : null; },
    async recordResponse(input) {
      counters.textCalls += 0;
      evidence.response = { id: `response-${counters.reservations}`, response: structuredClone(input.response), gatewayRequestId: "gateway-a" };
      return evidence.response;
    },
    async recordValidation(input) { evidence.validation = { id: `validation-${counters.reservations}`, ...input }; return evidence.validation; },
  };
  return createContentPlan({
    accountId: "account-a", jobId: `job-${counters.reservations + 1}`, itemId: `item-${counters.reservations + 1}`,
    sourceSnapshotId: `snapshot-${counters.reservations + 1}`, expectedStatusVersion: 7,
    planningContract: "FIXED_SKELETON_V1", ...args,
    gatewayProfile: { id: "profile-a", accountId: "account-a", configVersion: 3, textModel: "text-model-a", enabled: true },
    gateway: { async createTextResponse(input) {
      counters.textCalls += 1;
      assert.equal(input.jsonSchema.properties.fills.required.length, skeleton.plan.slots.length);
      return { requestId: "gateway-a", value: fill };
    } },
    repository, evidenceRepository,
  });
}

function services(counters) {
  const never = async () => { throw new Error("unexpected phase"); };
  return {
    planContent: never,
    materializeSourceAsset: never,
    finalizeMaterializedPlan: never,
    async generateImageSlot(input) {
      counters.imageCalls += 1;
      return {
        status: "ACCEPTED", accountId: input.scope.accountId, jobId: input.scope.jobId,
        itemId: input.scope.itemId, planId: input.scope.planId,
        slotKey: input.scope.slotKey, role: input.plan.plan.slots.find((slot) => slot.slotKey === input.scope.slotKey).role,
      };
    },
    async generateRichContent(input) {
      counters.richCalls += 1;
      return { status: "ACCEPTED", accountId: input.accountId, jobId: input.jobId,
        itemId: input.itemId, planId: input.planId };
    },
  };
}

async function generateConfiguredImages(planRecord, counters) {
  const derived = {
    ...planRecord,
    id: `${planRecord.id}-derived`, sourceAccountId: "account-a", jobId: planRecord.jobId, itemId: planRecord.itemId,
    parentPlanId: planRecord.id, derivationKind: "SOURCE_MATERIALIZATION", materializationSetHash: H("d"),
    planHash: planRecord.planHash, sourceHash: planRecord.sourceHash,
    visualGroups: { groups: [{ visualGroupKey: planRecord.plan.slots[0].visualGroupKey, referenceImages: [{
      assetId: "source-a", evidenceKind: "CONTENT_HASH", contentHash: H("e"), sourceRefHash: H("f"), sourceRef: null,
    }] }] },
  };
  const configured = services(counters);
  const accepted = [];
  for (const slot of derived.plan.slots) {
    const message = { contractVersion: "V1", accountId: "account-a", itemId: derived.itemId,
      phase: "GENERATE_IMAGE_SLOT", slotKey: slot.slotKey, expectedStatusVersion: 8, correlationId: "corr-a" };
    const context = {
      accountId: "account-a", jobId: derived.jobId, itemId: derived.itemId,
      status: "GENERATING", statusVersion: 8, activeContentPlanId: derived.id,
      phaseInput: {
        plan: derived, slot, categoryStyle: null, categoryStyleReferences: [],
        sourceAssetLoader: {}, repository: {}, gateway: {}, profile: {},
        imageModel: "image-model-a", ratio: "3:4", resolution: "1K", size: "768x1024",
        quality: "medium", templateVersion: "image-v1", regeneration: null, storage: {}, logger: null, maxAttempts: 3,
        gatewayExecution,
      },
    };
    const result = await orchestrateAutoListingAiPhase({ message, context }, configured);
    assert.equal(result.outcome, "IMAGE_SLOT_ACCEPTED");
    accepted.push({ id: `asset-${accepted.length + 1}`, status: "ACCEPTED", accountId: "account-a",
      jobId: derived.jobId, itemId: derived.itemId, planId: derived.id, slotKey: slot.slotKey,
      visualGroupKey: slot.visualGroupKey, role: slot.role });
  }
  const rich = await orchestrateAutoListingAiPhase({
    message: { contractVersion: "V1", accountId: "account-a", itemId: derived.itemId,
      phase: "GENERATE_RICH_CONTENT", expectedStatusVersion: 8, correlationId: "corr-a" },
    context: {
      accountId: "account-a", jobId: derived.jobId, itemId: derived.itemId,
      status: "GENERATING", statusVersion: 8, activeContentPlanId: derived.id,
      phaseInput: { plan: derived, profile: {}, gateway: {}, repository: {}, factRegistry: planRecord.factRegistry,
        acceptedAssets: accepted, planHash: derived.planHash, sourceHash: derived.sourceHash,
        promptTemplateVersion: "rich-v1", maxAttempts: 3, leaseOwner: "worker-a", gatewayExecution },
    },
  }, configured);
  assert.equal(rich.outcome, "CONTENT_READY_FOR_REVIEW");
  return { derived, accepted };
}

function scriptedClient(steps) {
  const calls = [];
  return { calls, async query(sql, values = []) {
    calls.push({ sql, values });
    const step = steps.shift();
    assert.ok(step, `unexpected query: ${sql}`);
    return step;
  } };
}

async function finishAtReview(planRecord) {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 8, active_content_plan_id: `${planRecord.id}-derived`, planning_contract: "FIXED_SKELETON_V1" }] },
    { rowCount: 1, rows: [{ id: `${planRecord.id}-derived`, parent_plan_id: planRecord.id,
      derivation_kind: "SOURCE_MATERIALIZATION", plan: planRecord.plan }] },
    { rowCount: 1, rows: [{ planned_group_count: "1", accepted_group_count: "1", invalid_result_count: "0", duplicate_group_count: "0" }] },
    { rowCount: 1, rows: [{ mode: "REVIEW", enabled: true }] },
    { rowCount: 1, rows: [{ status: "READY_FOR_REVIEW", status_version: 9 }] },
    { rowCount: 1, rows: [{ id: "review-event" }] },
  ]);
  const result = await applyAutoListingAiPhaseOutcome({
    client, accountId: "account-a", jobId: planRecord.jobId, itemId: planRecord.itemId,
    expectedStatusVersion: 8, correlationId: "corr-a", phase: "GENERATE_RICH_CONTENT", phaseTargetId: null,
    outcome: { contractVersion: "V1", disposition: "ACK", phase: "GENERATE_RICH_CONTENT",
      outcome: "CONTENT_READY_FOR_REVIEW", retryable: false, failureCode: null, correlationId: "corr-a",
      failureScope: null, deliveryState: null, retryAfterMs: null },
  }, { directUploadAllowed: true });
  assert.deepEqual(result, { disposition: "APPLIED", status: "READY_FOR_REVIEW", statusVersion: 9, enqueued: 0 });
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_upload_tasks/iu.test(sql)), false);
}

if (!enabled) {
  test("configurable fixed-skeleton E2E requires an explicit disposable PostgreSQL gate", {
    skip: "requires AUTO_LISTING_CONFIGURABLE_SKELETON_PG_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL",
  }, () => {});
} else {
  test("fresh PostgreSQL applies all migrations with the closed planning and diagnostic schema", { timeout: 30_000 }, async () => {
    const { Pool } = await import("pg");
    const root = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await root.connect();
    const schema = `fixed_skeleton_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      await client.query(`SET search_path TO ${quote(schema)}, public`);
      const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
      assert.equal(migrations.includes("076_auto_listing_category_strategy_analysis_edits.sql"), true);
      assert.equal(migrations.at(-1), "101_manual_category_confirmation_product_revision.sql");
      for (const migration of migrations) await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      const schemaRows = await client.query(
        `SELECT table_name,column_name FROM information_schema.columns
          WHERE table_schema=$1 AND ((table_name='auto_listing_job_items' AND column_name='planning_contract')
             OR table_name IN ('auto_listing_content_plan_diagnostic_runs','auto_listing_content_plan_responses','auto_listing_content_plan_validation_results'))`,
        [schema],
      );
      assert.equal(schemaRows.rows.some((row) => row.table_name === "auto_listing_job_items" && row.column_name === "planning_contract"), true);
      assert.deepEqual(new Set(schemaRows.rows.map((row) => row.table_name)), new Set([
        "auto_listing_job_items", "auto_listing_content_plan_diagnostic_runs",
        "auto_listing_content_plan_responses", "auto_listing_content_plan_validation_results",
      ]));
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      client.release();
      await root.end();
    }
  });

  test("074 upgrades existing terminal planner attempts without weakening their immutability", { timeout: 30_000 }, async () => {
    const { Pool } = await import("pg");
    const root = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await root.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `fixed_upgrade_${suffix}`;
    const migrations = (await readdir(migrationsDir)).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
    try {
      await client.query(`CREATE SCHEMA ${quote(schema)}`);
      await client.query(`SET search_path TO ${quote(schema)}, public`);
      for (const migration of migrations.filter((file) => file < "074_")) {
        await client.query(await readFile(path.join(migrationsDir, migration), "utf8"));
      }
      const ids = Object.fromEntries(["account", "store", "warehouse", "strategy", "snapshot", "job", "item", "profile", "attempt"]
        .map((name) => [name, `${name}-${suffix}`]));
      await client.query(
        "INSERT INTO accounts (id,username,display_name,role,status) VALUES ($1,$2,$2,'admin','active')",
        [ids.account, `admin-${suffix}`],
      );
      await client.query(
        "INSERT INTO stores (id,label,company_name,client_id,status,owner_account_id) VALUES ($1,$2,$2,$3,'active',$4)",
        [ids.store, `Store ${suffix}`, `client-${suffix}`, ids.account],
      );
      await client.query(
        "INSERT INTO warehouses (id,store_id,warehouse_id,warehouse_type,status,is_active,is_archived) VALUES ($1,$2,$3,'FBS','active',TRUE,FALSE)",
        [ids.warehouse, ids.store, `platform-${suffix}`],
      );
      await client.query(
        `INSERT INTO ai_gateway_profiles (
           id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,
           text_model,image_model,config_version,enabled
         ) VALUES ($1,$2,'Upgrade profile','https://gateway.example.test/tenant/v1','TEST_AI_KEY',
           'SUB2API_RESPONSES','SUB2API_OPENAI_IMAGES','text-model-a','image-model-a',3,TRUE)`,
        [ids.profile, ids.account],
      );
      await client.query(
        "INSERT INTO ai_content_strategy_versions (id,account_id,strategy_key,version,status,content,content_hash) VALUES ($1,$2,'default',1,'DRAFT','{}'::JSONB,$3)",
        [ids.strategy, ids.account, "strategy-hash"],
      );
      await client.query(
        "UPDATE ai_content_strategy_versions SET status='PUBLISHED',published_at=NOW(),published_by=$2 WHERE id=$1",
        [ids.strategy, ids.account],
      );
      const source = sourceCapture();
      const { config, configHash } = normalizeAndHashAutoListingConfig({
        targetStoreId: ids.store, targetWarehouseId: ids.warehouse, stock: 5, priceAdjustmentKopecks: "0",
        image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru", roles: roles.six },
      });
      await client.query(
        `INSERT INTO auto_listing_source_snapshots
           (id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref)
         VALUES ($1,$2,'COLLECT_BOX',$3,'draft:7',$4::JSONB,$5,$6)`,
        [ids.snapshot, ids.account, `collect-${suffix}`, JSON.stringify(source.snapshot), source.snapshotHash, `raw-${suffix}`],
      );
      await client.query(
        `INSERT INTO auto_listing_jobs (
           id,account_id,source_type,status,idempotency_key,config_snapshot,config_hash,
           strategy_version_id,ai_profile_id,ai_profile_version,correlation_id
         ) VALUES ($1,$2,'COLLECT_BOX','PLANNING',$3,$4::JSONB,$5,$6,$7,3,$8)`,
        [ids.job, ids.account, `job-intent-${suffix}`, JSON.stringify(config), configHash,
          ids.strategy, ids.profile, `job-correlation-${suffix}`],
      );
      await client.query(
        `INSERT INTO auto_listing_job_items
           (id,job_id,account_id,snapshot_id,target_store_id,target_warehouse_id,status,status_version,failure_code)
         VALUES ($1,$2,$3,$4,$5,$6,'BLOCKED',7,'AUTO_LISTING_CONTENT_PLAN_INVALID')`,
        [ids.item, ids.job, ids.account, ids.snapshot, ids.store, ids.warehouse],
      );
      await client.query(
        `INSERT INTO auto_listing_content_plan_attempts (
           id,account_id,job_id,item_id,source_snapshot_id,profile_id,profile_version,input_hash,
           attempt_no,status,error_code,error_retryable,expected_status_version,request_key
         ) VALUES ($1,$2,$3,$4,$5,$6,3,$7,1,'FAILED','AUTO_LISTING_CONTENT_PLAN_INVALID',FALSE,7,$8)`,
        [ids.attempt, ids.account, ids.job, ids.item, ids.snapshot, ids.profile, H("9"), `auto-listing-plan-${H("8")}`],
      );
      await client.query(await readFile(path.join(migrationsDir, migrations.find((file) => file.startsWith("074_"))), "utf8"));
      const upgraded = await client.query(
        "SELECT status,planning_contract,skeleton_hash,planner_stage FROM auto_listing_content_plan_attempts WHERE id=$1",
        [ids.attempt],
      );
      assert.deepEqual(upgraded.rows, [{
        status: "FAILED", planning_contract: "LEGACY_FULL_PLAN_V3", skeleton_hash: null, planner_stage: "FAILED",
      }]);
      await assert.rejects(client.query(
        "UPDATE auto_listing_content_plan_attempts SET planner_stage='FILLING_COPY' WHERE id=$1",
        [ids.attempt],
      ), (error) => error?.code === "23514");
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      client.release();
      await root.end();
    }
  });

  test("6, 8 and 13 configured slots each make one text fill, exact image calls, and stop at review", async () => {
    for (const [name, roleCounts] of Object.entries(roles)) {
      const expected = Object.values(roleCounts).reduce((sum, value) => sum + value, 0);
      const counters = { reservations: 0, savedPlans: 0, releases: 0, textCalls: 0, imageCalls: 0, richCalls: 0, ozonWrites: 0 };
      const plan = await planFixed(roleCounts, counters);
      assert.equal(plan.planningContract, "FIXED_SKELETON_V1", name);
      assert.equal(plan.plan.slots.length, expected, name);
      assert.deepEqual(plan.plan.slots.map(({ order }) => order), Array.from({ length: expected }, (_, index) => index + 1));
      const generated = await generateConfiguredImages(plan, counters);
      assert.equal(generated.accepted.length, expected, name);
      await finishAtReview(plan);
      assert.deepEqual({ text: counters.textCalls, images: counters.imageCalls, rich: counters.richCalls,
        ozon: counters.ozonWrites }, { text: 1, images: expected, rich: 1, ozon: 0 });
    }
  });

  test("invalid fill stops before images while missing dimensions and multiple visual groups remain supported", async () => {
    const invalid = { reservations: 0, savedPlans: 0, releases: 0, textCalls: 0, imageCalls: 0, richCalls: 0, ozonWrites: 0 };
    await assert.rejects(planFixed(roles.eight, invalid, (fill) => {
      fill.fills["forged:slot"] = { claims: [] };
      return fill;
    }), { code: "AUTO_LISTING_CONTENT_PLAN_INVALID" });
    assert.deepEqual({ saved: invalid.savedPlans, images: invalid.imageCalls, ozon: invalid.ozonWrites }, { saved: 0, images: 0, ozon: 0 });

    const missingDimensions = {
      reservations: 0, savedPlans: 0, releases: 0, textCalls: 0, imageCalls: 0, richCalls: 0, ozonWrites: 0,
    };
    const documentary = await planFixed(
      roles.eight,
      missingDimensions,
      undefined,
      sourceCapture({ reliableDimensions: false }),
    );
    const specification = documentary.plan.slots.find((slot) => slot.role === "SPECIFICATION");
    assert.equal(specification?.requestedRole, "SPECIFICATION");
    assert.equal(specification?.substitutionReasonCode, null);
    assert.equal(specification?.textDensity, "NONE");
    assert.deepEqual({
      saved: missingDimensions.savedPlans,
      text: missingDimensions.textCalls,
      images: missingDimensions.imageCalls,
      ozon: missingDimensions.ozonWrites,
    }, { saved: 1, text: 1, images: 0, ozon: 0 });

    const context = buildPlannerInput({
      ...plannerArgs(roles.six), profileRef: { id: "profile-a", configVersion: 3, textModel: "text-model-a" },
      promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_FILL_V6",
    });
    const hostile = structuredClone(context);
    hostile.plannerInput.visualGroups.push({ ...structuredClone(hostile.plannerInput.visualGroups[0]), visualGroupKey: "group-b" });
    const multipleGroups = buildFixedSkeleton({ plannerContext: hostile });
    assert.equal(multipleGroups.plan.slots.length, 12);
    assert.deepEqual(
      [...new Set(multipleGroups.plan.slots.map((slot) => slot.visualGroupKey))].sort(),
      [context.plannerInput.visualGroups[0].visualGroupKey, "group-b"].sort(),
    );
    for (const visualGroupKey of [context.plannerInput.visualGroups[0].visualGroupKey, "group-b"]) {
      assert.equal(multipleGroups.plan.slots.filter((slot) => slot.visualGroupKey === visualGroupKey).length, 6);
    }
  });

  test("the selector defaults collect-box and Excel items to the fixed skeleton", () => {
    for (const candidate of [
      { accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-a" },
      { accountId: "account-b", sourceType: "COLLECT_BOX", collectItemId: "collect-b" },
    ]) assert.equal(selectAutoListingPlanningContract(candidate), "FIXED_SKELETON_V1");
    assert.equal(selectAutoListingPlanningContract({
      accountId: "account-a", sourceType: "EXCEL_SKU", collectItemId: "excel-a",
    }), "FIXED_SKELETON_V1");
  });
}
