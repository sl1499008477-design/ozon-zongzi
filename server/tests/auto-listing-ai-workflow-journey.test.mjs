import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresAutoListingAiWorkflow,
  stageInitialPlanWork,
} from "../auto-listing-ai-workflow-postgres.mjs";

const accountId = "account-a";
const jobId = "job-a";
const itemId = "item-a";
const correlationId = "correlation-a";

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

function statefulPostgres() {
  const slots = ["main-1", "selling-1", "detail-1", "scene-1", "info-1", "info-2"];
  const state = {
    status: "SOURCE_READY",
    statusVersion: 1,
    activePlanId: "plan-parent",
    sourceAccepted: new Set(),
    imageAccepted: new Set(),
    richAccepted: false,
    events: new Map(),
    outbox: new Map(),
    transactions: [],
    releases: 0,
  };
  const plans = {
    "plan-parent": {
      id: "plan-parent",
      parent_plan_id: null,
      derivation_kind: "ROOT",
      visual_groups: { groups: [{ referenceImages: [{
        assetId: "source-a", sourceRefHash: "a".repeat(64),
        evidenceKind: "SOURCE_REF_HASH", contentHash: null,
      }] }] },
      plan: { slots: [] },
    },
    "plan-derived": {
      id: "plan-derived",
      parent_plan_id: "plan-parent",
      derivation_kind: "SOURCE_MATERIALIZATION",
      visual_groups: { groups: [{ referenceImages: [{
        assetId: "source-a", sourceRefHash: "a".repeat(64),
        evidenceKind: "CONTENT_HASH", contentHash: "b".repeat(64),
      }] }] },
      plan: { slots: slots.map((slotKey, index) => ({ slotKey, role: index === 0 ? "MAIN" : "DETAIL" })) },
    },
  };

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
      if (/SELECT i\.status,i\.status_version,j\.ai_profile_id,j\.ai_profile_version/iu.test(statement)) {
        return { rowCount: 1, rows: [{
          status: state.status, status_version: state.statusVersion,
          ai_profile_id: "profile-a", ai_profile_version: 1,
        }] };
      }
      if (/SET status='PLANNING',status_version=status_version\+1/iu.test(statement)) {
        assert.equal(state.status, "SOURCE_READY");
        state.status = "PLANNING";
        state.statusVersion += 1;
        return { rowCount: 1, rows: [{ status: state.status, status_version: state.statusVersion }] };
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
      if (/SELECT job_id FROM auto_listing_job_items/iu.test(statement)) {
        return { rowCount: 1, rows: [{ job_id: jobId }] };
      }
      if (/SELECT i\.status,i\.status_version,i\.active_content_plan_id/iu.test(statement)) {
        return { rowCount: 1, rows: [{
          status: state.status, status_version: state.statusVersion,
          active_content_plan_id: state.activePlanId,
        }] };
      }
      if (/SELECT p\.id,p\.parent_plan_id,p\.derivation_kind,p\.visual_groups,p\.plan/iu.test(statement)) {
        return { rowCount: 1, rows: [{ ...plans[state.activePlanId] }] };
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
    && (target === null || message.sourceAssetId === target || message.slotKey === target));
  assert.equal(matches.length, 1, `expected one ${phase}:${target || ""} message`);
  return matches[0];
}

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
  const imageEvents = [...state.events.values()].filter((event) => event.eventType === "AI_IMAGE_SLOT_ACCEPTED");
  assert.deepEqual(imageEvents.map((event) => event.details.slotKey).sort(), [...slots].sort());
  assert.equal(new Set(imageEvents.map((event) => event.id)).size, slots.length);
  assert.equal(state.transactions.filter((entry) => entry === "COMMIT").length, 10);
  assert.equal(state.transactions.includes("ROLLBACK"), false);
  assert.equal(state.releases, 10);
});
