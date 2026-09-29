import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createPostgresAutoListingAiWorkflow,
  stageInitialPlanWork,
} from "../auto-listing-ai-workflow-postgres.mjs";
import { buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";
import { buildSourceImageAnalysisBatches } from "../auto-listing-source-image-analyzer.mjs";
import { enumerateSourceImageAssets } from "../auto-listing-source-image-intelligence-contract.mjs";

const accountId = "account-a";
const jobId = "job-a";
const itemId = "item-a";
const correlationId = "correlation-a";
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function sourceCapture(sourceAssetCount) {
  const images = Array.from({ length: sourceAssetCount }, (_, index) => ({
    assetId: `source-${index + 1}`,
    contentHash: hash(`source-content-${index + 1}`),
  }));
  return buildAutoListingSourceSnapshot({
    accountId, sourceType: "COLLECT_BOX", sourceRecordId: "collect-a", sourceVersion: "1",
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    categoryEvidence: {
      id: "category-evidence-a", accountId, sourceDescriptionCategoryId: 170,
      sourceTypeId: 99, taxonomyScope: "OZON:DEFAULT",
    },
    sharedCategory: {
      id: "shared-category-a", accountId, version: 1, evidenceId: "category-evidence-a",
      status: "ACTIVE", source: "SOURCE_DIRECT", sourceDescriptionCategoryId: 170, sourceTypeId: 99,
      currentDescriptionCategoryId: 170, currentTypeId: 99, taxonomyScope: "OZON:DEFAULT",
      taxonomyFingerprint: null,
    },
    collectItem: { id: "collect-a", accountId, listingDraft: {
      sku: "sku-a", title: "Термокружка", brand: "Brand", currency: "RUB",
      blackKopecks: "10000", greenKopecks: "8000",
      categoryResolution: {
        status: "MATCHED", method: "taxonomy",
        target: { storeId: "store-a", descriptionCategoryId: "170", typeId: "99" },
      },
      images,
      variants: [{
        sku: "sku-a", offerId: "offer-sku-a", name: "sku-a", currency: "RUB",
        blackKopecks: "10000", greenKopecks: "8000", images,
      }],
    } },
    productDraft: { id: "draft-a", version: 1 }, rawResponseRef: "raw-a",
    rawResponseHash: hash("raw-a"),
  });
}

function outcome(message, value) {
  return Object.freeze({
    contractVersion: "V1",
    disposition: "ACK",
    phase: message.phase,
    outcome: value,
    retryable: false,
    failureCode: null,
    correlationId,
    failureScope: null,
    deliveryState: null,
    retryAfterMs: null,
  });
}

function statefulPostgres({ planningContract = "FIXED_SKELETON_V1", sourceAssetCount = 1 } = {}) {
  const slots = ["main-1", "selling-1", "detail-1", "scene-1", "info-1", "info-2"];
  const state = {
    status: "SOURCE_READY",
    statusVersion: 1,
    activePlanId: "plan-parent",
    sourceAccepted: new Set(),
    imageAccepted: new Set(),
    richAccepted: false,
    planningContract,
    sourceCapture: sourceCapture(sourceAssetCount),
    sourceAssetCount,
    currentAnalysisRunId: null,
    analysisRunStatus: null,
    analysisSummaryHash: null,
    analysisBatches: [],
    analyzedBatches: new Set(),
    groupCheckAccepted: false,
    ozonWriteCalls: 0,
    events: new Map(),
    outbox: new Map(),
    transactions: [],
    releases: 0,
  };
  const sourceAssets = enumerateSourceImageAssets({ sourceCapture: state.sourceCapture });
  state.analysisBatches = buildSourceImageAnalysisBatches({
    materializedAssets: sourceAssets.map((asset) => ({
      sourceAssetId: asset.sourceAssetId,
      sourceOrdinal: asset.sourceOrdinal,
      sizeBytes: 1024,
      contentHash: hash(`materialized-${asset.sourceAssetId}`),
      objectKey: `source-images/${asset.sourceAssetId}.webp`,
      contentType: "image/webp",
    })),
    terminalAssessments: [],
  });
  const plans = {
    "plan-parent": {
      id: "plan-parent",
      parent_plan_id: null,
      derivation_kind: "ROOT",
      visual_groups: { groups: [{ visualGroupKey: "group-a", referenceImages: [{
        assetId: "source-a", sourceRefHash: "a".repeat(64),
        evidenceKind: "SOURCE_REF_HASH", contentHash: null,
      }] }] },
      plan: { slots: [] },
    },
    "plan-derived": {
      id: "plan-derived",
      parent_plan_id: "plan-parent",
      derivation_kind: "SOURCE_MATERIALIZATION",
      visual_groups: { groups: [{ visualGroupKey: "group-a", referenceImages: [{
        assetId: "source-a", sourceRefHash: "a".repeat(64),
        evidenceKind: "CONTENT_HASH", contentHash: "b".repeat(64),
      }] }] },
      plan: { slots: slots.map((slotKey, index) => ({
        slotKey, visualGroupKey: "group-a", role: index === 0 ? "MAIN" : "DETAIL",
      })) },
      source_image_analysis_run_id: null,
      source_image_intelligence_hash: null,
    },
  };
  state.plans = plans;

  const client = {
    async query(sql, values = []) {
      const statement = String(sql).replace(/\s+/gu, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
        state.transactions.push(statement);
        return { rowCount: null, rows: [] };
      }
      if (/set_config\('statement_timeout'/u.test(statement)) {
        assert.deepEqual(values, ["25000", "5000", "30000"]);
        return { rowCount: 1, rows: [{}] };
      }
      if (/SELECT i\.status,i\.status_version,i\.planning_contract,i\.snapshot_id/iu.test(statement)) {
        return { rowCount: 1, rows: [{
          status: state.status, status_version: state.statusVersion,
          ai_profile_id: "profile-a", ai_profile_version: 1,
          planning_contract: state.planningContract,
          snapshot_id: "snapshot-a",
          snapshot: state.sourceCapture.snapshot,
          snapshot_hash: state.sourceCapture.snapshotHash,
          current_source_image_analysis_run_id: state.currentAnalysisRunId,
          text_model: "text-model-a",
        }] };
      }
      if (/SET status='PLANNING',status_version=status_version\+1/iu.test(statement)) {
        assert.equal(state.status, "SOURCE_READY");
        state.status = "PLANNING";
        state.statusVersion += 1;
        return { rowCount: 1, rows: [{ status: state.status, status_version: state.statusVersion }] };
      }
      if (/INSERT INTO auto_listing_source_image_analysis_runs/iu.test(statement)) {
        state.currentAnalysisRunId = values[0];
        state.analysisRunStatus = "MATERIALIZING";
        return { rowCount: 1, rows: [{ id: values[0] }] };
      }
      if (/SET current_source_image_analysis_run_id=\$4/iu.test(statement)) {
        assert.equal(values[3], state.currentAnalysisRunId);
        return { rowCount: 1, rows: [{ id: itemId }] };
      }
      if (/INSERT INTO auto_listing_events/iu.test(statement)) {
        const id = values[0];
        if (state.events.has(id)) return { rowCount: 0, rows: [] };
        state.events.set(id, {
          id,
          eventType: values[7],
          details: JSON.parse(values[9]),
          transitionVersion: values[10],
        });
        return { rowCount: 1, rows: [{ id }] };
      }
      if (/INSERT INTO auto_listing_ai_outbox/iu.test(statement)) {
        const dedupeKey = values[5];
        if (state.outbox.has(dedupeKey)) return { rowCount: 0, rows: [] };
        const message = JSON.parse(values[7]);
        state.outbox.set(dedupeKey, message);
        return { rowCount: 1, rows: [{ id: values[0] }] };
      }
      if (/WITH requeued AS \( UPDATE auto_listing_ai_outbox/iu.test(statement)) {
        return state.outbox.has(values[3])
          ? { rowCount: 1, rows: [{ id: `requeued-${values[8]}` }] }
          : { rowCount: 0, rows: [] };
      }
      if (/SELECT job_id FROM auto_listing_job_items/iu.test(statement)) {
        return { rowCount: 1, rows: [{ job_id: jobId }] };
      }
      if (/SELECT i\.status,i\.status_version,i\.active_content_plan_id/iu.test(statement)) {
        return { rowCount: 1, rows: [{
          status: state.status, status_version: state.statusVersion,
          active_content_plan_id: state.activePlanId,
          planning_contract: state.planningContract,
          current_source_image_analysis_run_id: state.currentAnalysisRunId,
        }] };
      }
      if (/SELECT p\.id,p\.parent_plan_id,p\.derivation_kind,p\.visual_groups,p\.plan/iu.test(statement)) {
        return { rowCount: 1, rows: [{ ...plans[state.activePlanId] }] };
      }
      if (/SELECT \* FROM auto_listing_source_image_analysis_runs/iu.test(statement)) {
        const summaryHash = state.analysisSummaryHash;
        return { rowCount: 1, rows: [{
          id: state.currentAnalysisRunId,
          expected_asset_count: sourceAssets.length,
          status: state.analysisRunStatus,
          summary_hash: summaryHash,
          summary: summaryHash ? {
            summaryHash,
            eligibleAssetIds: sourceAssets.map(({ sourceAssetId }) => sourceAssetId),
          } : null,
        }] };
      }
      if (/FROM auto_listing_source_image_assessments/iu.test(statement)) {
        const acceptedIds = new Set(state.analysisBatches
          .filter(({ analysisBatchId }) => state.analyzedBatches.has(analysisBatchId))
          .flatMap(({ assets }) => assets.map(({ sourceAssetId }) => sourceAssetId)));
        const rows = sourceAssets
          .filter(({ sourceAssetId }) => state.sourceAccepted.has(sourceAssetId))
          .map((asset) => {
            const batch = state.analysisBatches.find(({ assets }) => assets
              .some(({ sourceAssetId }) => sourceAssetId === asset.sourceAssetId));
            return {
              source_asset_id: asset.sourceAssetId,
              source_ordinal: asset.sourceOrdinal,
              record_status: acceptedIds.has(asset.sourceAssetId) ? "ACCEPTED" : "MATERIALIZED",
              object_key: `source-images/${asset.sourceAssetId}.webp`,
              content_hash: hash(`materialized-${asset.sourceAssetId}`),
              content_type: "image/webp",
              size_bytes: 1024,
              terminal_status: null,
              analysis_batch_id: acceptedIds.has(asset.sourceAssetId) ? batch.analysisBatchId : null,
              result_hash: acceptedIds.has(asset.sourceAssetId) ? hash(`result-${asset.sourceAssetId}`) : null,
              assessment: null,
            };
          });
        return { rowCount: rows.length, rows };
      }
      if (/FROM auto_listing_jobs AS job[\s\S]*auto_listing_upload_policy_versions/iu.test(statement)) {
        return { rowCount: 1, rows: [{ mode: "REVIEW", enabled: true }] };
      }
      if (/SELECT DISTINCT source_asset_id/iu.test(statement)) {
        return { rowCount: state.sourceAccepted.size,
          rows: [...state.sourceAccepted].map((source_asset_id) => ({
            source_asset_id,
            source_ref_hash: "a".repeat(64),
          })) };
      }
      if (/SET status=\$5,status_version=status_version\+1/iu.test(statement)) {
        assert.equal(values[3], state.statusVersion);
        assert.equal(values[7], state.status);
        state.status = values[4];
        state.statusVersion += 1;
        return { rowCount: 1, rows: [{ status: state.status, status_version: state.statusVersion }] };
      }
      if (/AS planned_group_count[\s\S]*AS accepted_group_count/iu.test(statement)) {
        return { rowCount: 1, rows: [{
          planned_group_count: "1",
          accepted_group_count: state.richAccepted ? "1" : "0",
          invalid_result_count: "0",
          duplicate_group_count: "0",
        }] };
      }
      if (/WITH planned AS/iu.test(statement)) {
        const skipped = new Set([...state.events.values()]
          .filter((event) => event.eventType === "AI_IMAGE_SLOT_SKIPPED")
          .map((event) => event.details.slotKey));
        const rows = plans["plan-derived"].plan.slots.map((slot) => ({
          slot_key: slot.slotKey,
          role: slot.role,
          visual_group_key: slot.visualGroupKey,
          terminal_status: state.imageAccepted.has(slot.slotKey) ? "ACCEPTED"
            : skipped.has(slot.slotKey) ? "SKIPPED" : "PENDING",
        }));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT id FROM ai_rich_content_results/iu.test(statement)) {
        return state.richAccepted
          ? { rowCount: 1, rows: [{ id: "rich-a" }] }
          : { rowCount: 0, rows: [] };
      }
      if (/event_type='AI_IMAGE_GROUP_RETRY_EXHAUSTED'/iu.test(statement)) {
        return { rowCount: 0, rows: [] };
      }
      if (/FROM auto_listing_image_group_checks/iu.test(statement)) {
        return state.groupCheckAccepted
          ? { rowCount: 1, rows: [{ visual_group_key: "group-a",
            expected_status_version: values[4], status: "ACCEPTED", result: {} }] }
          : { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected SQL: ${statement}`);
    },
    release() { state.releases += 1; },
  };
  const pool = {
    async query() { throw new Error("workflow must use its transaction client"); },
    async connect() { return client; },
  };
  return { state, slots, client, pool };
}

function onePending(state, phase, target = null) {
  const matches = [...state.outbox.values()].filter((message) => message.phase === phase
    && (target === null || message.sourceAssetId === target || message.analysisBatchId === target
      || message.analysisRunId === target || message.slotKey === target || message.visualGroupKey === target));
  assert.equal(matches.length, 1, `expected one ${phase}:${target || ""} message`);
  return matches[0];
}

async function runJourney({ planningContract, sourceAssetCount }) {
  const { state, slots, client, pool } = statefulPostgres({ planningContract, sourceAssetCount });
  await stageInitialPlanWork({
    client, accountId, jobId, itemId, actorAccountId: accountId,
    expectedStatusVersion: 1, correlationId,
  });
  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  const processed = new Set();
  const phases = [];
  while (state.status !== "READY_FOR_REVIEW") {
    const entry = [...state.outbox.entries()].find(([key]) => !processed.has(key));
    assert.ok(entry, `journey stopped in ${state.status}`);
    const [key, message] = entry;
    processed.add(key);
    phases.push(message.phase);
    let value;
    if (message.phase === "MATERIALIZE_SOURCE_ASSET") {
      state.sourceAccepted.add(message.sourceAssetId);
      value = "SOURCE_ASSET_TERMINAL";
    } else if (message.phase === "ANALYZE_SOURCE_IMAGE_BATCH") {
      state.analyzedBatches.add(message.analysisBatchId);
      value = "SOURCE_IMAGE_BATCH_ACCEPTED";
    } else if (message.phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS") {
      state.analysisRunStatus = "ACCEPTED";
      state.analysisSummaryHash = hash("accepted-source-image-summary");
      value = "SOURCE_IMAGE_ANALYSIS_READY";
    } else if (message.phase === "PLAN_CONTENT") {
      state.plans["plan-parent"].source_image_analysis_run_id = state.currentAnalysisRunId;
      state.plans["plan-parent"].source_image_intelligence_hash = state.analysisSummaryHash;
      value = "PLAN_READY";
    } else if (message.phase === "FINALIZE_MATERIALIZED_PLAN") {
      state.activePlanId = "plan-derived";
      value = "MATERIALIZED_PLAN_READY";
    } else if (message.phase === "GENERATE_IMAGE_SLOT") {
      state.imageAccepted.add(message.slotKey);
      value = "IMAGE_SLOT_ACCEPTED";
    } else if (message.phase === "CHECK_IMAGE_GROUP") {
      state.groupCheckAccepted = true;
      value = "IMAGE_GROUP_ACCEPTED";
    } else if (message.phase === "GENERATE_RICH_CONTENT") {
      state.richAccepted = true;
      value = "CONTENT_READY_FOR_REVIEW";
    } else {
      assert.fail(`unexpected phase ${message.phase}`);
    }
    await workflow.applyPhaseOutcome({ message, outcome: outcome(message, value) });
  }
  return {
    phases,
    finalStatus: state.status,
    ozonWriteCalls: state.ozonWriteCalls,
    slots,
  };
}

test("intelligent items complete materialize analyze reconcile plan generate group-check rich journey", async () => {
  const journey = await runJourney({
    planningContract: "FIXED_SKELETON_SOURCE_IMAGE_V1", sourceAssetCount: 8,
  });
  assert.deepEqual(journey.phases, [
    ...Array(8).fill("MATERIALIZE_SOURCE_ASSET"),
    ...Array(4).fill("ANALYZE_SOURCE_IMAGE_BATCH"),
    "RECONCILE_SOURCE_IMAGE_ANALYSIS", "PLAN_CONTENT", "FINALIZE_MATERIALIZED_PLAN",
    ...Array(6).fill("GENERATE_IMAGE_SLOT"), "CHECK_IMAGE_GROUP", "GENERATE_RICH_CONTENT",
  ]);
  assert.equal(journey.finalStatus, "READY_FOR_REVIEW");
  assert.equal(journey.ozonWriteCalls, 0);
});

test("durable workflow wires the complete staged five-phase journey to READY_FOR_REVIEW without upload", async () => {
  const { state, slots, client, pool } = statefulPostgres();
  await stageInitialPlanWork({
    client, accountId, jobId, itemId, actorAccountId: accountId,
    expectedStatusVersion: 1, correlationId,
  });
  const workflow = createPostgresAutoListingAiWorkflow({ pool });

  const plan = onePending(state, "PLAN_CONTENT");
  await workflow.applyPhaseOutcome({ message: plan, outcome: outcome(plan, "PLAN_READY") });

  const materialize = onePending(state, "MATERIALIZE_SOURCE_ASSET", "source-a");
  state.sourceAccepted.add("source-a");
  await workflow.applyPhaseOutcome({
    message: materialize, outcome: outcome(materialize, "SOURCE_ASSET_ACCEPTED"),
  });

  state.activePlanId = "plan-derived";
  const finalize = onePending(state, "FINALIZE_MATERIALIZED_PLAN");
  await workflow.applyPhaseOutcome({
    message: finalize, outcome: outcome(finalize, "MATERIALIZED_PLAN_READY"),
  });

  for (const slotKey of slots) {
    const image = onePending(state, "GENERATE_IMAGE_SLOT", slotKey);
    state.imageAccepted.add(slotKey);
    await workflow.applyPhaseOutcome({
      message: image, outcome: outcome(image, "IMAGE_SLOT_ACCEPTED"),
    });
  }

  const rich = onePending(state, "GENERATE_RICH_CONTENT");
  state.richAccepted = true;
  await workflow.applyPhaseOutcome({
    message: rich, outcome: outcome(rich, "CONTENT_READY_FOR_REVIEW"),
  });

  assert.deepEqual({ status: state.status, statusVersion: state.statusVersion }, {
    status: "READY_FOR_REVIEW", statusVersion: 4,
  });
  const messages = [...state.outbox.values()];
  assert.deepEqual(messages.map((message) => message.phase).sort(), [
    "FINALIZE_MATERIALIZED_PLAN",
    "GENERATE_IMAGE_SLOT", "GENERATE_IMAGE_SLOT", "GENERATE_IMAGE_SLOT",
    "GENERATE_IMAGE_SLOT", "GENERATE_IMAGE_SLOT", "GENERATE_IMAGE_SLOT",
    "GENERATE_RICH_CONTENT", "MATERIALIZE_SOURCE_ASSET", "PLAN_CONTENT",
  ].sort());
  assert.equal(messages.some((message) => /UPLOAD/u.test(message.phase)), false);
  for (const message of messages) {
    assert.equal(message.contractVersion, "V3");
    assert.equal(Object.hasOwn(message, "execution"), false,
      "durable business messages must not embed a leased channel or credential material");
    assert.doesNotMatch(JSON.stringify(message), /api[_-]?key|authorization|bearer|ciphertext/iu);
  }
  const imageEvents = [...state.events.values()].filter((event) => event.eventType === "AI_IMAGE_SLOT_ACCEPTED");
  assert.deepEqual(imageEvents.map((event) => event.details.slotKey).sort(), [...slots].sort());
  assert.equal(new Set(imageEvents.map((event) => event.id)).size, slots.length);
  assert.equal(state.transactions.filter((entry) => entry === "COMMIT").length, 10);
  assert.equal(state.transactions.includes("ROLLBACK"), false);
  assert.equal(state.releases, 10);
});
