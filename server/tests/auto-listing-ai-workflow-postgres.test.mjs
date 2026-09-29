import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyAutoListingAiPhaseOutcome,
  createPostgresAutoListingAiWorkflow,
  stageInitialPlanWork,
} from "../auto-listing-ai-workflow-postgres.mjs";

function scriptedClient(steps) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      const step = steps.shift();
      assert.ok(step, `unexpected query: ${sql}`);
      if (typeof step === "function") return step(sql, values);
      return step;
    },
  };
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

function cleanupAssessment(sourceAssetId = "source-a", overrides = {}) {
  const value = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    sourceAssetId, sourceOrdinal: 0, objectKey: "auto-listing/source/a.png",
    contentHash: "a".repeat(64), parentSourceAssetId: null, terminalStatus: "ANALYZED",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: [] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [], semanticTextRegions: [],
    markings: [{
      kind: "EXTERNAL_OVERLAY", region: { x: 0.02, y: 0.02, width: 0.2, height: 0.08 },
      confidence: "CONFIRMED", reasonCodes: ["FIXED_CANVAS_POSITION"],
    }],
    perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"], reasonCodes: [],
    ...overrides,
  };
  return { ...value, assessmentHash: digest(value) };
}

test("stageInitialPlanWork atomically locks a frozen-profile item, transitions SOURCE_READY and writes closed audit+PLAN work", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "SOURCE_READY", status_version: 1, ai_profile_id: "profile-a", ai_profile_version: 3 }] },
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2 }] },
    { rowCount: 1, rows: [{ id: "event-id" }] },
    { rowCount: 1, rows: [{ id: "outbox-id" }] },
  ]);

  const result = await stageInitialPlanWork({
    client,
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    actorAccountId: "account-a",
    expectedStatusVersion: 1,
    correlationId: "correlation-a",
  });

  assert.deepEqual(result, { status: "PLANNING", statusVersion: 2 });
  assert.match(client.calls[0].sql, /FROM auto_listing_job_items[\s\S]*JOIN auto_listing_jobs[\s\S]*FOR UPDATE OF i/iu);
  assert.deepEqual(client.calls[0].values, ["account-a", "job-a", "item-a"]);
  assert.match(client.calls[1].sql, /SET status='PLANNING',status_version=status_version\+1/iu);
  assert.match(client.calls[1].sql, /status='SOURCE_READY' AND status_version=\$4/iu);
  assert.deepEqual(client.calls[2].values.slice(1, 8), [
    "account-a", "job-a", "item-a", "account-a", "SOURCE_READY", "PLANNING", "START_PLANNING",
  ]);
  const outboxValues = client.calls[3].values;
  const payload = JSON.parse(outboxValues.find((value) => typeof value === "string" && value.startsWith("{")));
  assert.deepEqual(payload, {
    contractVersion: "V3", accountId: "account-a", itemId: "item-a", phase: "PLAN_CONTENT",
    expectedStatusVersion: 2, correlationId: "correlation-a",
  });
  assert.doesNotMatch(JSON.stringify(client.calls), /https?:|prompt|api.?key|secret|raw.?error/iu);
});

test("workflow factory is closed and exposes only the transaction stage port and transactional outcome port", () => {
  const pool = { async connect() {}, async query() {} };
  const workflow = createPostgresAutoListingAiWorkflow({ pool });
  assert.deepEqual(Object.keys(workflow).sort(), ["applyPhaseOutcome", "requeueChannelFailure", "stageInitialPlanWork"]);
  assert.throws(() => createPostgresAutoListingAiWorkflow({ pool, profileId: "global-profile" }), {
    code: "AUTO_LISTING_AI_WORKFLOW_INVALID",
  });
});

test("v3 reservation busy durably defers the exact generation while preserving item and fixed channel", async () => {
  const client = scriptedClient([
    {},
    { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 0,
      status: "PLANNING", status_version: 2, enabled: true }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    {},
  ]);
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...client, release() {} }; } },
  });
  const message = { contractVersion: "V1", accountId: "account-a", itemId: "item-a",
    phase: "PLAN_CONTENT", expectedStatusVersion: 2, correlationId: "correlation-a" };
  const result = await workflow.applyPhaseOutcome({
    message,
    outcome: {
      contractVersion: "V1", disposition: "RETRY", phase: "PLAN_CONTENT", outcome: "IN_PROGRESS",
      retryable: true, failureCode: "AUTO_LISTING_CONTENT_PLAN_IN_PROGRESS",
      correlationId: "correlation-a", failureScope: "RESERVATION_BUSY",
      deliveryState: null, retryAfterMs: 30_000,
    },
    execution: v3Execution(),
  });

  assert.deepEqual(result, { disposition: "DEFERRED", status: "PLANNING",
    statusVersion: 2, enqueued: 0 });
  assert.match(client.calls[3].sql, /execution_lease_owner=NULL/iu);
  assert.doesNotMatch(client.calls[3].sql, /assigned_job_id=NULL/iu);
  assert.match(client.calls[4].sql, /state='PENDING'[\s\S]*next_retry_at=NOW\(\)\+\(\$7 \* INTERVAL '1 millisecond'\)/iu);
  assert.equal(client.calls[4].values[6], 30_000);
  assert.equal(client.calls.some(({ sql }) => /UPDATE auto_listing_job_items/iu.test(sql)), false);
});

test("v3 reservation busy rejects a failure code belonging to another phase before PostgreSQL", async () => {
  let connections = 0;
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: {
      async query() {},
      async connect() { connections += 1; throw new Error("must not connect"); },
    },
  });
  const message = { contractVersion: "V1", accountId: "account-a", itemId: "item-a",
    phase: "PLAN_CONTENT", expectedStatusVersion: 2, correlationId: "correlation-a" };
  await assert.rejects(workflow.applyPhaseOutcome({
    message,
    outcome: {
      contractVersion: "V1", disposition: "RETRY", phase: "PLAN_CONTENT", outcome: "IN_PROGRESS",
      retryable: true, failureCode: "AUTO_LISTING_IMAGE_IN_PROGRESS",
      correlationId: "correlation-a", failureScope: "RESERVATION_BUSY",
      deliveryState: null, retryAfterMs: 30_000,
    },
    execution: v3Execution(),
  }), { code: "AUTO_LISTING_AI_WORKFLOW_INVALID" });
  assert.equal(connections, 0);
});

test("v3 factory outcome contract requires execution fencing and locks outbox item and channel before writes", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === "BEGIN") return {};
      if (/set_config/iu.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/FOR UPDATE OF outbox,item,channel/iu.test(sql)) return { rowCount: 0, rows: [] };
      if (sql === "COMMIT") return {};
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return client; } },
  });
  const message = {
    contractVersion: "V1", accountId: "account-a", itemId: "item-a", phase: "PLAN_CONTENT",
    expectedStatusVersion: 2, correlationId: "correlation-a",
  };
  const execution = {
    outboxId: "outbox-a", dispatchGeneration: 2, channelId: "channel-a",
    connectionId: "connection-a", connectionVersion: 3,
    leaseOwner: "worker-a", leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const result = await workflow.applyPhaseOutcome({
    message,
    outcome: {
      ...outcome("PLAN_CONTENT", "PLAN_READY"),
      failureScope: null, deliveryState: null, retryAfterMs: null,
    },
    execution,
  });

  assert.equal(result.disposition, "STALE");
  assert.match(calls[2].sql, /dispatch_generation[\s\S]*execution_lease_token[\s\S]*FOR UPDATE OF outbox,item,channel/iu);
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items/iu.test(sql)), false);
});

function v3Execution() {
  return {
    outboxId: "outbox-a", dispatchGeneration: 2, channelId: "channel-a",
    connectionId: "connection-a", connectionVersion: 3,
    leaseOwner: "worker-a", leaseToken: "worker-token-a",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function channelOutcome(code, failureScope, deliveryState, retryAfterMs = null) {
  return {
    contractVersion: "V1", disposition: "RETRY", phase: "PLAN_CONTENT", outcome: "FAILED",
    retryable: true, failureCode: code, correlationId: "correlation-a",
    failureScope, deliveryState, retryAfterMs,
  };
}

test("NOT_SENT channel revalidation cools and requeues atomically without consuming uncertainty", async () => {
  const client = scriptedClient([
    {},
    { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 0,
      status: "PLANNING", status_version: 2, enabled: true }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    {},
  ]);
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...client, release() {} }; } },
  });
  const message = { contractVersion: "V1", accountId: "account-a", itemId: "item-a",
    phase: "PLAN_CONTENT", expectedStatusVersion: 2, correlationId: "correlation-a" };
  const result = await workflow.requeueChannelFailure({
    message,
    outcome: channelOutcome("AI_GATEWAY_UNAUTHORIZED", "CHANNEL_REVALIDATION", "NOT_SENT"),
    execution: v3Execution(),
  });

  assert.deepEqual(result, { disposition: "REQUEUED", status: "PLANNING",
    statusVersion: 2, enqueued: 0, uncertainResultCount: 0 });
  assert.match(client.calls[2].sql, /FOR UPDATE OF outbox,item,channel/iu);
  assert.match(client.calls[3].sql, /requires_revalidation=requires_revalidation OR \$9/iu);
  assert.equal(client.calls[3].values[7], 60_000);
  assert.equal(client.calls[3].values[8], true);
  assert.match(client.calls[4].sql, /state='PENDING'[\s\S]*publication_id=NULL[\s\S]*next_retry_at=NOW\(\)/iu);
  assert.equal(client.calls[4].values[6], 0);
});

test("POSSIBLY_SENT requeues below five bounded attempts, then the fifth uncertain result becomes a retryable item failure", async () => {
  const message = { contractVersion: "V1", accountId: "account-a", itemId: "item-a",
    phase: "PLAN_CONTENT", expectedStatusVersion: 2, correlationId: "correlation-a" };
  const first = scriptedClient([
    {}, { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 0,
      status: "PLANNING", status_version: 2, enabled: true }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] }, {},
  ]);
  const firstWorkflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...first, release() {} }; } },
  });
  assert.equal((await firstWorkflow.requeueChannelFailure({
    message,
    outcome: channelOutcome("AI_GATEWAY_UNEXPECTED_EOF", "CHANNEL_TRANSIENT", "POSSIBLY_SENT"),
    execution: v3Execution(),
  })).uncertainResultCount, 1);
  assert.equal(first.calls[4].values[6], 1);

  const fourth = scriptedClient([
    {}, { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 3,
      status: "PLANNING", status_version: 2, enabled: true }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] }, {},
  ]);
  const fourthWorkflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...fourth, release() {} }; } },
  });
  assert.equal((await fourthWorkflow.requeueChannelFailure({
    message,
    outcome: channelOutcome("AI_GATEWAY_UNEXPECTED_EOF", "CHANNEL_TRANSIENT", "POSSIBLY_SENT"),
    execution: v3Execution(),
  })).uncertainResultCount, 4);
  assert.equal(fourth.calls[4].values[6], 4);

  const fifth = scriptedClient([
    {}, { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 4,
      status: "PLANNING", status_version: 2, enabled: true }] },
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2,
      active_content_plan_id: null, planning_contract: "FIXED_SKELETON_V1" }] },
    { rowCount: 1, rows: [{ status: "RETRYABLE_ERROR", status_version: 3 }] },
    { rowCount: 1, rows: [{ id: "event-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    {},
  ]);
  const fifthWorkflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...fifth, release() {} }; } },
  });
  const result = await fifthWorkflow.requeueChannelFailure({
    message,
    outcome: channelOutcome("INVALID_GATEWAY_RESPONSE", "CHANNEL_TRANSIENT", "POSSIBLY_SENT"),
    execution: v3Execution(),
  });
  assert.deepEqual(result, { disposition: "APPLIED", status: "RETRYABLE_ERROR",
    statusVersion: 3, enqueued: 0 });
  assert.equal(fifth.calls[4].values.includes("AUTO_LISTING_AI_RESULT_UNCERTAIN"), true);
  assert.match(fifth.calls[6].sql, /uncertain_result_count=\$7/iu);
  assert.equal(fifth.calls[6].values[6], 5);
  assert.match(fifth.calls[7].sql, /consecutive_failure_count=consecutive_failure_count\+1/iu);
  assert.match(fifth.calls[9].sql, /assigned_job_id=CASE WHEN enabled AND \$8/iu);
});

test("a disabled busy channel finishes the accepted outcome then releases assignment and resets expired health", async () => {
  const client = scriptedClient([
    {}, { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 0,
      status: "PLANNING", status_version: 2, enabled: false }] },
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2,
      active_content_plan_id: "plan-a", planning_contract: "FIXED_SKELETON_V1" }] },
    { rowCount: 1, rows: [{ id: "plan-a", parent_plan_id: null,
      derivation_kind: null, visual_groups: { groups: [] }, plan: {} }] },
    { rowCount: 1, rows: [{ id: "event-a" }] },
    { rowCount: 1, rows: [{ id: "next-outbox" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    {},
  ]);
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...client, release() {} }; } },
  });
  const message = { contractVersion: "V1", accountId: "account-a", itemId: "item-a",
    phase: "PLAN_CONTENT", expectedStatusVersion: 2, correlationId: "correlation-a" };
  const result = await workflow.applyPhaseOutcome({
    message,
    outcome: outcome("PLAN_CONTENT", "PLAN_READY"),
    execution: v3Execution(),
  });
  assert.deepEqual(result, { disposition: "APPLIED", status: "PLANNING",
    statusVersion: 2, enqueued: 1 });
  assert.match(client.calls[8].sql, /assigned_job_id=CASE WHEN enabled AND \$8[\s\S]*consecutive_failure_count=CASE WHEN \$9 THEN 0/iu);
  assert.equal(client.calls[8].values[7], true, "AI phase would normally keep affinity");
  assert.equal(client.calls[8].values[8], true, "ACK resets channel health");
  assert.match(client.calls[7].sql, /state='COMPLETED'/iu);
});

test("an enabled busy channel advances its fixed assignment to the next phase status version", async () => {
  const client = scriptedClient([
    {}, { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a", uncertain_result_count: 0,
      status: "PLANNING", status_version: 2, enabled: true }] },
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2,
      active_content_plan_id: "plan-derived", planning_contract: "FIXED_SKELETON_V1" }] },
    { rowCount: 1, rows: [{ id: "plan-derived", parent_plan_id: "plan-parent",
      derivation_kind: "SOURCE_MATERIALIZATION", plan: { slots: [{ slotKey: "slot-main", role: "MAIN" }] } }] },
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3 }] },
    { rowCount: 1, rows: [{ id: "event-a" }] },
    { rowCount: 1, rows: [{ id: "next-outbox" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    { rowCount: 1, rows: [{ channel_id: "channel-a" }] },
    {},
  ]);
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...client, release() {} }; } },
  });
  const message = { contractVersion: "V1", accountId: "account-a", itemId: "item-a",
    phase: "FINALIZE_MATERIALIZED_PLAN", expectedStatusVersion: 2, correlationId: "correlation-a" };
  const result = await workflow.applyPhaseOutcome({
    message,
    outcome: { ...outcome("FINALIZE_MATERIALIZED_PLAN", "MATERIALIZED_PLAN_READY"),
      failureScope: null, deliveryState: null, retryAfterMs: null },
    execution: v3Execution(),
  });

  assert.equal(result.statusVersion, 3);
  assert.match(client.calls[9].sql, /assigned_status_version=CASE WHEN enabled AND \$8 THEN \$10::INTEGER ELSE NULL END/iu);
  assert.equal(client.calls[9].values[9], 3);
});

test("stageInitialPlanWork is idempotent only when the exact transition event and closed PLAN work already exist", async () => {
  const duplicate = scriptedClient([
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2, ai_profile_id: "profile-a", ai_profile_version: 3 }] },
    { rowCount: 1, rows: [{ staged: true }] },
  ]);
  const input = {
    client: duplicate, accountId: "account-a", jobId: "job-a", itemId: "item-a",
    actorAccountId: "account-a", expectedStatusVersion: 1, correlationId: "correlation-a",
  };
  assert.deepEqual(await stageInitialPlanWork(input), { status: "PLANNING", statusVersion: 2 });
  assert.equal(duplicate.calls.length, 2);
  assert.match(duplicate.calls[1].sql, /EXISTS[\s\S]*FROM auto_listing_events[\s\S]*EXISTS[\s\S]*FROM auto_listing_ai_outbox/iu);

  for (const row of [
    { status: "SOURCE_READY", status_version: 2, ai_profile_id: "profile-a", ai_profile_version: 3 },
    { status: "PLANNING", status_version: 2, ai_profile_id: "profile-a", ai_profile_version: 3 },
  ]) {
    const client = scriptedClient([
      { rowCount: 1, rows: [row] },
      ...(row.status === "PLANNING" ? [{ rowCount: 1, rows: [{ staged: false }] }] : []),
    ]);
    await assert.rejects(stageInitialPlanWork({ ...input, client }), {
      code: "AUTO_LISTING_AI_WORKFLOW_VERSION_CONFLICT", retryable: false,
    });
    assert.equal(client.calls.some(({ sql }) => /UPDATE auto_listing_job_items/iu.test(sql)), false);
  }
});

function outcome(phase, value, overrides = {}) {
  const result = {
    contractVersion: "V1", disposition: "ACK", phase, outcome: value, retryable: false,
    failureCode: null, correlationId: "correlation-a", ...overrides,
  };
  return { ...result, failureScope: result.disposition === "ACK" ? null : "BUSINESS",
    deliveryState: null, retryAfterMs: null };
}

function applyInput(client, phase, value, overrides = {}) {
  return {
    client, accountId: "account-a", jobId: "job-a", itemId: "item-a",
    expectedStatusVersion: 2, correlationId: "correlation-a", phase,
    phaseTargetId: null, outcome: outcome(phase, value), ...overrides,
  };
}

test("PLAN_READY reads only the active parent plan and enqueues each unique SOURCE_REF_HASH exactly once", async () => {
  const visualGroups = { groups: [
    { referenceImages: [
      { assetId: "source-b", sourceRefHash: "b".repeat(64), evidenceKind: "SOURCE_REF_HASH", contentHash: null },
      { assetId: "source-a", sourceRefHash: "a".repeat(64), evidenceKind: "SOURCE_REF_HASH", contentHash: null },
    ] },
    { referenceImages: [
      { assetId: "source-a", sourceRefHash: "a".repeat(64), evidenceKind: "SOURCE_REF_HASH", contentHash: null },
    ] },
  ] };
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2, active_content_plan_id: "plan-parent" }] },
    { rowCount: 1, rows: [{ id: "plan-parent", parent_plan_id: null, visual_groups: visualGroups }] },
    { rowCount: 1, rows: [{ id: "event-id" }] },
    { rowCount: 1, rows: [{ id: "outbox-a" }] },
    { rowCount: 1, rows: [{ id: "outbox-b" }] },
  ]);

  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client, "PLAN_CONTENT", "PLAN_READY")), {
    disposition: "APPLIED", status: "PLANNING", statusVersion: 2, enqueued: 2,
  });
  assert.match(client.calls[0].sql, /WHERE i\.account_id=\$1 AND i\.job_id=\$2 AND i\.id=\$3[\s\S]*FOR UPDATE/iu);
  assert.match(client.calls[1].sql, /p\.id=i\.active_content_plan_id/iu);
  const messages = client.calls.slice(3).map(({ values }) => JSON.parse(values[7]));
  assert.deepEqual(messages.map((message) => message.sourceAssetId), ["source-a", "source-b"]);
  assert.equal(messages.every((message) => message.phase === "MATERIALIZE_SOURCE_ASSET"
    && message.expectedStatusVersion === 2 && Object.keys(message).length === 7), true);
});

test("PLAN_READY with no source references enqueues one FINALIZE message and never guesses a latest plan", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2, active_content_plan_id: "plan-parent" }] },
    { rowCount: 1, rows: [{ id: "plan-parent", parent_plan_id: null, visual_groups: { groups: [{ referenceImages: [] }] } }] },
    { rowCount: 1, rows: [{ id: "event-id" }] },
    { rowCount: 1, rows: [{ id: "outbox-finalize" }] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client, "PLAN_CONTENT", "PLAN_READY")), {
    disposition: "APPLIED", status: "PLANNING", statusVersion: 2, enqueued: 1,
  });
  assert.doesNotMatch(client.calls[1].sql, /ORDER\s+BY|LIMIT\s+1|latest/iu);
  assert.equal(JSON.parse(client.calls[3].values[7]).phase, "FINALIZE_MATERIALIZED_PLAN");
});

test("apply rejects RETRY before a database read and stale or cancelled final results perform zero writes", async () => {
  const retryClient = scriptedClient([]);
  await assert.rejects(applyAutoListingAiPhaseOutcome(applyInput(retryClient, "PLAN_CONTENT", "FAILED", {
    outcome: outcome("PLAN_CONTENT", "FAILED", {
      disposition: "RETRY", retryable: true, failureCode: "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED",
    }),
  })), { code: "AUTO_LISTING_AI_WORKFLOW_RETRY_NOT_FINAL", retryable: false });
  assert.equal(retryClient.calls.length, 0);

  for (const row of [
    { status: "PLANNING", status_version: 3, active_content_plan_id: "plan-parent" },
    { status: "CANCELLED", status_version: 2, active_content_plan_id: "plan-parent" },
  ]) {
    const client = scriptedClient([{ rowCount: 1, rows: [row] }]);
    const result = await applyAutoListingAiPhaseOutcome(applyInput(client, "PLAN_CONTENT", "PLAN_READY"));
    assert.equal(result.disposition, row.status === "CANCELLED" ? "CANCELLED" : "STALE");
    assert.equal(client.calls.length, 1);
  }
});

test("reconcile blocks confirmation or unusable identity evidence without enqueuing paid downstream work", async () => {
  for (const fixture of [
    { run: { status: "CONFIRMATION_REQUIRED", summary: null, summary_hash: null },
      failureCode: "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED" },
    { run: { status: "ACCEPTED", summary: { summaryHash: "6".repeat(64), eligibleAssetIds: [] }, summary_hash: "6".repeat(64) },
      failureCode: "AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT" },
  ]) {
    const client = scriptedClient([
      { rowCount: 1, rows: [{
        status: "PLANNING", status_version: 2, active_content_plan_id: null,
        planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
        current_source_image_analysis_run_id: "run-a",
      }] },
      { rowCount: 1, rows: [{ id: "run-a", expected_asset_count: 1, ...fixture.run }] },
      { rowCount: 1, rows: [{ source_asset_id: "source-a", record_status: "ACCEPTED" }] },
      { rowCount: 1, rows: [{ status: "BLOCKED", status_version: 3 }] },
      { rowCount: 1, rows: [{ id: "blocked-event" }] },
    ]);
    const result = await applyAutoListingAiPhaseOutcome(applyInput(
      client, "RECONCILE_SOURCE_IMAGE_ANALYSIS", "SOURCE_IMAGE_ANALYSIS_READY", { phaseTargetId: "run-a" },
    ));
    assert.deepEqual(result, { disposition: "APPLIED", status: "BLOCKED", statusVersion: 3, enqueued: 0 });
    assert.equal(client.calls[3].values[6], fixture.failureCode);
    assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql)), false);
  }
});

test("the last accepted V2 analysis batch skips new cleanup and enqueues reconciliation", async () => {
  const assessment = cleanupAssessment();
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "PLANNING", status_version: 2, active_content_plan_id: null,
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    }] },
    { rowCount: 1, rows: [{ id: "run-a", expected_asset_count: 1, status: "ANALYZING" }] },
    { rowCount: 1, rows: [{
      source_asset_id: "source-a", source_ordinal: 0, record_status: "ACCEPTED",
      analysis_batch_id: "batch-a", assessment,
    }] },
    { rowCount: 1, rows: [{ id: "batch-audit" }] },
    { rowCount: 1, rows: [{ id: "reconcile-outbox" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "ANALYZE_SOURCE_IMAGE_BATCH", "SOURCE_IMAGE_BATCH_ACCEPTED", {
      phaseTargetId: "batch-a",
    },
  ));

  assert.deepEqual(result, { disposition: "APPLIED", status: "PLANNING", statusVersion: 2, enqueued: 1 });
  assert.equal(client.calls.some(({ sql }) => /auto_listing_source_image_derivatives/iu.test(sql)), false);
  const message = JSON.parse(client.calls[4].values[7]);
  assert.deepEqual(Object.keys(message).sort(), [
    "accountId", "analysisRunId", "contractVersion", "correlationId",
    "expectedStatusVersion", "itemId", "phase",
  ]);
  assert.equal(message.phase, "RECONCILE_SOURCE_IMAGE_ANALYSIS");
  assert.equal(message.analysisRunId, "run-a");
});

test("a stored cleanup candidate resumes at CHECK without reserving another paid image attempt", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "PLANNING", status_version: 2, planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    }] },
    { rowCount: 1, rows: [{
      derivative_attempt_id: "derivative-attempt-a", analysis_run_id: "run-a", source_asset_id: "source-a",
      expected_status_version: 2, attempt_no: 1, status: "GENERATED",
    }] },
    { rowCount: 1, rows: [{ id: "generated-audit" }] },
    { rowCount: 1, rows: [{ id: "check-outbox-a" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CLEAN_SOURCE_IMAGE_OVERLAY", "SOURCE_IMAGE_CLEANUP_GENERATED", {
      phaseTargetId: "derivative-attempt-a",
    },
  ));
  assert.equal(result.enqueued, 1);
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_source_image_derivatives/iu.test(sql)), false);
  const message = JSON.parse(client.calls[3].values[7]);
  assert.equal(message.phase, "CHECK_SOURCE_IMAGE_CLEANUP");
  assert.equal(message.derivativeAttemptId, "derivative-attempt-a");
  assert.equal(message.analysisRunId, "run-a");
});

test("a rejected cleanup check reserves only the next deterministic attempt and never starts planning", async () => {
  const assessment = cleanupAssessment();
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "PLANNING", status_version: 2, planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    }] },
    { rowCount: 1, rows: [{
      derivative_attempt_id: "derivative-attempt-a", analysis_run_id: "run-a", source_asset_id: "source-a",
      expected_status_version: 2, attempt_no: 1, status: "REJECTED",
      check_result: { reasonCodes: ["OVERLAY_REMAINS"] },
    }] },
    { rowCount: 1, rows: [{ assessment }] },
    { rowCount: 1, rows: [{ id: "derivative-row-b" }] },
    { rowCount: 1, rows: [{ id: "rejected-audit" }] },
    { rowCount: 1, rows: [{ id: "retry-clean-outbox" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CHECK_SOURCE_IMAGE_CLEANUP", "SOURCE_IMAGE_CLEANUP_REJECTED", {
      phaseTargetId: "derivative-attempt-a",
    },
  ));
  assert.equal(result.enqueued, 1);
  assert.match(client.calls[3].sql, /INSERT INTO auto_listing_source_image_derivatives/iu);
  const message = JSON.parse(client.calls[5].values[7]);
  assert.equal(message.phase, "CLEAN_SOURCE_IMAGE_OVERLAY");
  assert.notEqual(message.derivativeAttemptId, "derivative-attempt-a");
  assert.equal(client.calls.some(({ values }) => values.some?.((value) => typeof value === "string"
    && value.includes("PLAN_CONTENT"))), false);
});

test("a third cleanup rejection is terminal for cleanup and proceeds to reviewable reconciliation", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "PLANNING", status_version: 2, planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
      current_source_image_analysis_run_id: "run-a",
    }] },
    { rowCount: 1, rows: [{
      derivative_attempt_id: "derivative-attempt-c", analysis_run_id: "run-a", source_asset_id: "source-a",
      expected_status_version: 2, attempt_no: 3, status: "REJECTED",
      check_result: { reasonCodes: ["PRODUCT_IDENTITY_CHANGED"] },
    }] },
    { rowCount: 1, rows: [{ id: "third-rejected-audit" }] },
    { rowCount: 1, rows: [{
      source_asset_id: "source-a", record_status: "ACCEPTED", assessment: cleanupAssessment(),
      attempt_no: 3, derivative_status: "REJECTED",
    }] },
    { rowCount: 1, rows: [{ id: "reconcile-outbox" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CHECK_SOURCE_IMAGE_CLEANUP", "SOURCE_IMAGE_CLEANUP_REJECTED", {
      phaseTargetId: "derivative-attempt-c",
    },
  ));
  assert.deepEqual(result, { disposition: "APPLIED", status: "PLANNING", statusVersion: 2, enqueued: 1 });
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_source_image_derivatives/iu.test(sql)), false);
  const message = JSON.parse(client.calls[4].values[7]);
  assert.equal(message.phase, "RECONCILE_SOURCE_IMAGE_ANALYSIS");
  assert.equal(message.analysisRunId, "run-a");
});

test("accepted materialization waits for every unique parent reference then enqueues FINALIZE exactly once", async () => {
  const groups = { groups: [{ referenceImages: [
    { assetId: "source-a", sourceRefHash: "a".repeat(64), evidenceKind: "SOURCE_REF_HASH", contentHash: null },
    { assetId: "source-b", sourceRefHash: "b".repeat(64), evidenceKind: "SOURCE_REF_HASH", contentHash: null },
  ] }] };
  for (const fixture of [
    { accepted: [{ source_asset_id: "source-a", source_ref_hash: "a".repeat(64) }], enqueue: false },
    { accepted: [
      { source_asset_id: "source-a", source_ref_hash: "a".repeat(64) },
      { source_asset_id: "source-b", source_ref_hash: "b".repeat(64) },
    ], enqueue: true },
  ]) {
    const client = scriptedClient([
      { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2, active_content_plan_id: "plan-parent" }] },
      { rowCount: 1, rows: [{ id: "plan-parent", parent_plan_id: null, visual_groups: groups }] },
      { rowCount: fixture.accepted.length, rows: fixture.accepted },
      { rowCount: 1, rows: [{ id: "event" }] },
      ...(fixture.enqueue ? [{ rowCount: 1, rows: [{ id: "finalize" }] }] : []),
    ]);
    const result = await applyAutoListingAiPhaseOutcome(applyInput(
      client, "MATERIALIZE_SOURCE_ASSET", "SOURCE_ASSET_ACCEPTED", { phaseTargetId: "source-a" },
    ));
    assert.equal(result.enqueued, fixture.enqueue ? 1 : 0);
    assert.equal(result.status, "PLANNING");
    if (fixture.enqueue) assert.equal(JSON.parse(client.calls.at(-1).values[7]).phase, "FINALIZE_MATERIALIZED_PLAN");
  }
});

test("materialized plan completion atomically enters GENERATING and enqueues every unique active-plan slot", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [{
      id: "plan-derived", parent_plan_id: "plan-parent", derivation_kind: "SOURCE_MATERIALIZATION",
      plan: { slots: [{ slotKey: "slot-b", role: "DETAIL" }, { slotKey: "slot-a", role: "MAIN" }] },
    }] },
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3 }] },
    { rowCount: 1, rows: [{ id: "event" }] },
    { rowCount: 1, rows: [{ id: "slot-a" }] },
    { rowCount: 1, rows: [{ id: "slot-b" }] },
  ]);
  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "FINALIZE_MATERIALIZED_PLAN", "MATERIALIZED_PLAN_READY",
  ));
  assert.deepEqual(result, { disposition: "APPLIED", status: "GENERATING", statusVersion: 3, enqueued: 2 });
  assert.match(client.calls[2].sql, /status=\$5,status_version=status_version\+1/iu);
  assert.deepEqual(client.calls.slice(4).map(({ values }) => JSON.parse(values[7]).slotKey), ["slot-a", "slot-b"]);
  assert.equal(client.calls.slice(4).every(({ values }) => JSON.parse(values[7]).expectedStatusVersion === 3), true);
});

function imagePlan() {
  return {
    id: "plan-derived", parent_plan_id: "plan-parent", derivation_kind: "SOURCE_MATERIALIZATION",
    plan: { slots: [
      { slotKey: "slot-main", role: "MAIN" },
      { slotKey: "slot-2", role: "DETAIL" }, { slotKey: "slot-3", role: "SCENE" },
      { slotKey: "slot-4", role: "INFOGRAPHIC" }, { slotKey: "slot-5", role: "SELLING_POINT" },
      { slotKey: "slot-6", role: "DETAIL" },
    ] },
  };
}

test("image aggregation waits until every active-plan slot is terminal and then enqueues rich content only with MAIN plus six accepted", async () => {
  const waiting = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ id: "event" }] },
    { rowCount: 6, rows: [
      { slot_key: "slot-main", role: "MAIN", terminal_status: "ACCEPTED" },
      ...[2, 3, 4, 5].map((n) => ({ slot_key: `slot-${n}`, role: "DETAIL", terminal_status: "ACCEPTED" })),
      { slot_key: "slot-6", role: "DETAIL", terminal_status: "PENDING" },
    ] },
  ]);
  assert.equal((await applyAutoListingAiPhaseOutcome(applyInput(waiting,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_ACCEPTED", { phaseTargetId: "slot-main", expectedStatusVersion: 3 }))).enqueued, 0);
  assert.match(waiting.calls[3].sql, /LEFT JOIN skipped s ON s\.slot_key=p\.slot_key/iu);
  assert.doesNotMatch(waiting.calls[3].sql, /LEFT JOIN skipped s USING\s*\(slot_key\)/iu);
  assert.match(waiting.calls[3].sql,
    /SELECT DISTINCT ON \(asset\.slot_key\)[\s\S]*asset\.created_at[\s\S]*asset\.expected_status_version IS NULL OR asset\.expected_status_version<=\$5[\s\S]*asset\.expected_status_version DESC NULLS LAST,\s*asset\.created_at DESC/iu,
    "the latest versioned accepted asset wins while legacy NULL-version evidence remains visible");
  assert.match(waiting.calls[3].sql,
    /latest_group_checks[\s\S]*status='REJECTED'[\s\S]*result->'retrySlotKeys' \? asset\.slot_key[\s\S]*COALESCE\(asset\.expected_status_version,0\)<=group_check\.expected_status_version/iu,
    "a rejected group check must make its old accepted assets pending until newer replacements pass");
  assert.match(waiting.calls[3].sql, /skipped[\s\S]*details->>'statusVersion'=\$5::TEXT/iu,
    "a controlled retry must wait for every slot instead of inheriting an earlier run's skip");
  assert.match(waiting.calls[3].sql,
    /SELECT DISTINCT ON \(details->>'slotKey'\)[\s\S]*created_at[\s\S]*ORDER BY details->>'slotKey',created_at DESC,id DESC/iu,
    "only the latest current-version skip participates in terminal aggregation");
  assert.match(waiting.calls[3].sql,
    /WHEN s\.slot_key IS NOT NULL AND \(a\.slot_key IS NULL OR s\.created_at>=a\.created_at\)\s+THEN 'SKIPPED'\s+WHEN a\.slot_key IS NOT NULL THEN 'ACCEPTED'/iu,
    "a newer/equal skip supersedes historical acceptance but a later acceptance survives an earlier skip");
  assert.match(waiting.calls[3].sql,
    /plan\.prompt_template_version='AUTO_LISTING_CONTENT_PLAN_FILL_V6'[\s\S]*planned_slot->>'role'='MAIN'/iu,
    "a V6 MAIN accepted with the required product title remains terminal even when it has no display claims");
  assert.equal(waiting.calls[3].values[4], 3);

  const complete = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ id: "event" }] },
    { rowCount: 6, rows: [
      { slot_key: "slot-main", role: "MAIN", terminal_status: "ACCEPTED" },
      ...[2, 3, 4, 5, 6].map((n) => ({ slot_key: `slot-${n}`, role: "DETAIL", terminal_status: "ACCEPTED" })),
    ] },
    { rowCount: 1, rows: [{ id: "rich" }] },
  ]);
  const completed = await applyAutoListingAiPhaseOutcome(applyInput(complete,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_ACCEPTED", { phaseTargetId: "slot-main", expectedStatusVersion: 3 }));
  assert.deepEqual(completed, { disposition: "APPLIED", status: "GENERATING", statusVersion: 3, enqueued: 1 });
  assert.equal(JSON.parse(complete.calls[4].values[7]).phase, "GENERATE_RICH_CONTENT");
});

test("image aggregation continues after optional slots are skipped when MAIN plus six accepted remain", async () => {
  const plan = {
    ...imagePlan(),
    plan: { slots: [
      ...imagePlan().plan.slots,
      { slotKey: "slot-7", role: "SELLING_POINT" },
      { slotKey: "slot-8", role: "SPECIFICATION" },
    ] },
  };
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 1, rows: [{ id: "audit" }] },
    { rowCount: 8, rows: [
      { slot_key: "slot-main", role: "MAIN", terminal_status: "ACCEPTED" },
      ...[2, 3, 4, 5, 6].map((n) => ({ slot_key: `slot-${n}`, role: "DETAIL", terminal_status: "ACCEPTED" })),
      { slot_key: "slot-7", role: "SELLING_POINT", terminal_status: "SKIPPED" },
      { slot_key: "slot-8", role: "SPECIFICATION", terminal_status: "SKIPPED" },
    ] },
    { rowCount: 1, rows: [{ id: "rich" }] },
  ]);

  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_SKIPPED", { phaseTargetId: "slot-8", expectedStatusVersion: 3 })),
  { disposition: "APPLIED", status: "GENERATING", statusVersion: 3, enqueued: 1 });
  assert.equal(JSON.parse(client.calls[4].values[7]).phase, "GENERATE_RICH_CONTENT");
  assert.equal(client.calls.some(({ sql }) => /UPDATE auto_listing_job_items/iu.test(sql)), false);
});

test("a rejected image-group check requeues only its returned completed slots", async () => {
  const slots = ["group-a", "group-b"].flatMap((visualGroupKey) => Array.from({ length: 6 }, (_, index) => ({
    slotKey: `${visualGroupKey}-slot-${index + 1}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey,
  })));
  const plan = {
    ...imagePlan(),
    visual_groups: { groups: [{ visualGroupKey: "group-a" }, { visualGroupKey: "group-b" }] },
    plan: { slots },
  };
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 1, rows: [{
      id: "image-group-check-b", visual_group_key: "group-b", expected_status_version: 3, status: "REJECTED",
      result: { retrySlotKeys: ["group-b-slot-2", "group-b-slot-4"] },
    }] },
    { rowCount: 2, rows: [
      { slot_key: "group-b-slot-2", role: "DETAIL", attempt_count: 3 },
      { slot_key: "group-b-slot-4", role: "DETAIL", attempt_count: 3 },
    ] },
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "group-retry-event" }] },
    { rowCount: 1, rows: [{ id: "group-b-slot-2-outbox" }] },
    { rowCount: 1, rows: [{ id: "group-b-slot-4-outbox" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CHECK_IMAGE_GROUP", "IMAGE_GROUP_RETRY_QUEUED", {
      phaseTargetId: "group-b", expectedStatusVersion: 3,
    },
  ));

  assert.deepEqual(result, { disposition: "APPLIED", status: "GENERATING", statusVersion: 4, enqueued: 2 });
  assert.match(client.calls[3].sql, /JOIN ai_generation_assets/iu);
  assert.match(client.calls[3].sql, /FILTER\s*\(WHERE asset\.status='ACCEPTED'\)/iu);
  assert.deepEqual(client.calls[3].values, [
    "account-a", "job-a", "item-a", "plan-derived", ["group-b-slot-2", "group-b-slot-4"],
  ]);
  assert.match(client.calls[4].sql, /UPDATE auto_listing_job_items[\s\S]*status_version=status_version\+1/iu);
  assert.match(client.calls[5].sql, /INSERT INTO auto_listing_events/iu);
  assert.equal(client.calls[5].values[7], "AI_IMAGE_GROUP_RETRY_QUEUED");
  assert.equal(client.calls.slice(6).every(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql)), true);
  assert.deepEqual(client.calls.slice(6).map(({ values }) => [values[8], values[6]]), [
    [4, "group-b-slot-2"], [4, "group-b-slot-4"],
  ]);
});

test("an exhausted soft image-group replacement enters manual review with a warning instead of looping", async () => {
  const slots = Array.from({ length: 6 }, (_, index) => ({
    slotKey: `group-a-slot-${index + 1}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: "group-a",
  }));
  const plan = {
    ...imagePlan(),
    visual_groups: { groups: [{ visualGroupKey: "group-a" }] },
    plan: { slots },
  };
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 1, rows: [{
      id: "image-group-check-a", visual_group_key: "group-a", expected_status_version: 3,
      status: "REJECTED", result: {
        retrySlotKeys: ["group-a-slot-2"],
        reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW"],
        identityMismatchSlotKeys: [],
      },
    }] },
    { rowCount: 1, rows: [{ slot_key: "group-a-slot-2", role: "DETAIL", attempt_count: 4 }] },
    { rowCount: 1, rows: [{ id: "warning-event" }] },
    { rowCount: 1, rows: [{ id: "rich-outbox" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CHECK_IMAGE_GROUP", "IMAGE_GROUP_RETRY_QUEUED", {
      phaseTargetId: "group-a", expectedStatusVersion: 3,
    },
  ));

  assert.deepEqual(result, { disposition: "APPLIED", status: "GENERATING", statusVersion: 3, enqueued: 1 });
  assert.match(client.calls[4].sql, /INSERT INTO auto_listing_events/iu);
  assert.equal(client.calls[4].values[7], "AI_IMAGE_GROUP_RETRY_EXHAUSTED");
  assert.deepEqual(JSON.parse(client.calls[4].values[9]), {
    planId: "plan-derived",
    visualGroupKey: "group-a",
    retrySlotKeys: ["group-a-slot-2"],
    reasonCodes: ["IMAGE_GROUP_DUPLICATE_VIEW"],
  });
  assert.equal(JSON.parse(client.calls[5].values[7]).phase, "GENERATE_RICH_CONTENT");
  assert.equal(client.calls.some(({ sql }) => /UPDATE auto_listing_job_items/iu.test(sql)), false);
});

test("an exhausted hard image-group identity failure still blocks the item", async () => {
  const slots = Array.from({ length: 6 }, (_, index) => ({
    slotKey: `group-a-slot-${index + 1}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: "group-a",
  }));
  const plan = {
    ...imagePlan(),
    visual_groups: { groups: [{ visualGroupKey: "group-a" }] },
    plan: { slots },
  };
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 1, rows: [{
      id: "image-group-check-a", visual_group_key: "group-a", expected_status_version: 3,
      status: "REJECTED", result: {
        retrySlotKeys: ["group-a-slot-2"],
        reasonCodes: ["IMAGE_GROUP_IDENTITY_MISMATCH"],
        identityMismatchSlotKeys: ["group-a-slot-2"],
      },
    }] },
    { rowCount: 1, rows: [{ slot_key: "group-a-slot-2", role: "DETAIL", attempt_count: 4 }] },
    { rowCount: 1, rows: [{ status: "BLOCKED", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "block-event" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CHECK_IMAGE_GROUP", "IMAGE_GROUP_RETRY_QUEUED", {
      phaseTargetId: "group-a", expectedStatusVersion: 3,
    },
  ));

  assert.deepEqual(result, { disposition: "APPLIED", status: "BLOCKED", statusVersion: 4, enqueued: 0 });
  assert.match(client.calls[4].sql, /UPDATE auto_listing_job_items/iu);
  assert.equal(client.calls[4].values[6], "AUTO_LISTING_IMAGE_GROUP_RETRY_LIMIT_REACHED");
  assert.equal(client.calls.some(({ sql }) => /UPDATE auto_listing_ai_outbox/iu.test(sql)), false);
});

test("a persisted rejected group cannot requeue a sibling-group slot before conflict rollback", async () => {
  const slots = ["group-a", "group-b"].flatMap((visualGroupKey) => Array.from({ length: 6 }, (_, index) => ({
    slotKey: `${visualGroupKey}-slot-${index + 1}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey,
  })));
  const plan = {
    id: "plan-derived",
    parent_plan_id: "plan-parent",
    derivation_kind: "SOURCE_MATERIALIZATION",
    visual_groups: { groups: [{ visualGroupKey: "group-a" }, { visualGroupKey: "group-b" }] },
    plan: { slots },
  };
  const client = scriptedClient([
    {},
    { rowCount: 1, rows: [{}] },
    { rowCount: 1, rows: [{ job_id: "job-a" }] },
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 2, rows: [{
      visual_group_key: "group-a", expected_status_version: 2, status: "ACCEPTED", result: {},
    }, {
      visual_group_key: "group-b", expected_status_version: 3, status: "REJECTED",
      result: { retrySlotKeys: ["group-a-slot-2"] },
    }] },
    { rowCount: 1, rows: [{ id: "must-not-requeue" }] },
    {},
  ]);
  const workflow = createPostgresAutoListingAiWorkflow({
    pool: { async query() {}, async connect() { return { ...client, release() {} }; } },
  });

  await assert.rejects(workflow.applyPhaseOutcome({
    message: {
      contractVersion: "V3",
      accountId: "account-a",
      itemId: "item-a",
      phase: "CHECK_IMAGE_GROUP",
      visualGroupKey: "group-b",
      expectedStatusVersion: 3,
      correlationId: "correlation-a",
    },
    outcome: outcome("CHECK_IMAGE_GROUP", "IMAGE_GROUP_RETRY_QUEUED"),
  }), { code: "AUTO_LISTING_AI_WORKFLOW_VERSION_CONFLICT", retryable: false });

  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  assert.equal(client.calls.some(({ sql }) => /UPDATE auto_listing_ai_outbox/iu.test(sql)), false);
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql)), false);
});

test("a retried group rechecks only itself without charging an already accepted sibling group", async () => {
  const slots = ["group-a", "group-b"].flatMap((visualGroupKey) => Array.from({ length: 6 }, (_, index) => ({
    slotKey: `${visualGroupKey}-${index}`, role: index === 0 ? "MAIN" : "DETAIL", visualGroupKey,
  })));
  const plan = {
    id: "plan-derived", parent_plan_id: "plan-parent", derivation_kind: "SOURCE_MATERIALIZATION",
    visual_groups: { groups: [
      { visualGroupKey: "group-a" }, { visualGroupKey: "group-b" },
    ] },
    plan: { slots },
  };
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 1, rows: [{ id: "audit" }] },
    { rowCount: slots.length, rows: slots.map((slot) => ({
      slot_key: slot.slotKey, role: slot.role, visual_group_key: slot.visualGroupKey,
      terminal_status: "ACCEPTED",
    })) },
    (sql) => /FROM auto_listing_image_group_checks/iu.test(sql)
      ? { rowCount: 2, rows: [
        { visual_group_key: "group-a", status: "ACCEPTED" },
        { visual_group_key: "group-b", status: "REJECTED" },
      ] }
      : { rowCount: 1, rows: [{ id: "unexpected-group-a-recheck" }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ id: "group-b-recheck" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_ACCEPTED", {
      phaseTargetId: "group-b-2", expectedStatusVersion: 3,
    },
  ));

  assert.deepEqual(result, { disposition: "APPLIED", status: "GENERATING", statusVersion: 3, enqueued: 1 });
  const groupLookup = client.calls.find(({ sql }) => /FROM auto_listing_image_group_checks/iu.test(sql));
  assert.match(groupLookup.sql, /plan_id=\$4[\s\S]*expected_status_version<=\$5/iu);
  assert.match(groupLookup.sql, /ORDER BY visual_group_key,expected_status_version DESC/iu);
  const rechecks = client.calls.filter(({ sql }) => /UPDATE auto_listing_ai_outbox/iu.test(sql));
  assert.deepEqual(rechecks.map(({ values }) => values.at(-1)), ["group-b"]);
});

test("a retried group converges with the latest accepted sibling evidence from the same current plan", async () => {
  const plan = {
    id: "plan-derived", parent_plan_id: "plan-parent", derivation_kind: "SOURCE_MATERIALIZATION",
    visual_groups: { groups: [{ visualGroupKey: "group-a" }, { visualGroupKey: "group-b" }] },
    plan: { slots: [] },
  };
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 5, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 2, rows: [
        { plan_id: "plan-derived", visual_group_key: "group-a", expected_status_version: 4,
          status: "ACCEPTED", result: {} },
        { plan_id: "plan-derived", visual_group_key: "group-b", expected_status_version: 5,
          status: "ACCEPTED", result: {} },
      ] },
    { rowCount: 1, rows: [{ id: "audit" }] },
    { rowCount: 1, rows: [{ id: "rich-once" }] },
  ]);

  const result = await applyAutoListingAiPhaseOutcome(applyInput(
    client, "CHECK_IMAGE_GROUP", "IMAGE_GROUP_ACCEPTED", {
      phaseTargetId: "group-b", expectedStatusVersion: 5,
    },
  ));

  assert.deepEqual(result, { disposition: "APPLIED", status: "GENERATING", statusVersion: 5, enqueued: 1 });
  assert.match(client.calls[2].sql, /plan_id=\$4[\s\S]*expected_status_version<=\$5/iu);
  assert.match(client.calls[2].sql, /ORDER BY visual_group_key,expected_status_version DESC/iu);
  assert.deepEqual(client.calls[2].values, ["account-a", "job-a", "item-a", "plan-derived", 5]);
  const outbox = client.calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql));
  assert.equal(outbox.length, 1);
  assert.equal(JSON.parse(outbox[0].values[7]).phase, "GENERATE_RICH_CONTENT");
  assert.match(outbox[0].sql, /ON CONFLICT \(dedupe_key\) DO NOTHING[\s\S]*NOT EXISTS \(SELECT 1 FROM inserted\)/iu);
  assert.equal(client.calls.some(({ values }) => values.some?.((value) => value === "group-a")), false);
});

test("group convergence excludes foreign or future evidence and lets newer non-accepted evidence supersede older acceptance", async () => {
  const plan = {
    id: "plan-derived", parent_plan_id: "plan-parent", derivation_kind: "SOURCE_MATERIALIZATION",
    visual_groups: { groups: [{ visualGroupKey: "group-a" }, { visualGroupKey: "group-b" }] },
    plan: { slots: [] },
  };
  const superseded = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 5, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    }] },
    { rowCount: 1, rows: [plan] },
    { rowCount: 2, rows: [{
      plan_id: "plan-derived", visual_group_key: "group-a", expected_status_version: 5,
      status: "FAILED", result: null,
    }, {
      plan_id: "plan-derived", visual_group_key: "group-b", expected_status_version: 5,
      status: "ACCEPTED", result: {},
    }] },
    { rowCount: 1, rows: [{ id: "audit" }] },
    { rowCount: 0, rows: [] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(
    superseded, "CHECK_IMAGE_GROUP", "IMAGE_GROUP_ACCEPTED", {
      phaseTargetId: "group-b", expectedStatusVersion: 5,
    },
  )), { disposition: "APPLIED", status: "GENERATING", statusVersion: 5, enqueued: 0 });
  assert.match(superseded.calls[2].sql,
    /account_id=\$1 AND job_id=\$2 AND item_id=\$3 AND plan_id=\$4[\s\S]*expected_status_version<=\$5/iu);
  assert.match(superseded.calls[2].sql, /ORDER BY visual_group_key,expected_status_version DESC/iu);
  assert.equal(superseded.calls.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql)), false);
});

test("same-correlation image audits are target-bound across accepted, skipped, and exact duplicate slots", async () => {
  function auditFixture(terminalStatus, target = "slot-main") {
    return scriptedClient([
      { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
      { rowCount: 1, rows: [imagePlan()] },
      { rowCount: 1, rows: [{ id: "audit" }] },
      { rowCount: 6, rows: imagePlan().plan.slots.map(({ slotKey, role }) => ({
        slot_key: slotKey, role, terminal_status: slotKey === target ? terminalStatus : "PENDING",
      })) },
    ]);
  }
  const accepted = auditFixture("ACCEPTED");
  await applyAutoListingAiPhaseOutcome(applyInput(accepted,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_ACCEPTED", { phaseTargetId: "slot-main", expectedStatusVersion: 3 }));
  const skipped = auditFixture("SKIPPED", "slot-2");
  await applyAutoListingAiPhaseOutcome(applyInput(skipped,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_SKIPPED", { phaseTargetId: "slot-2", expectedStatusVersion: 3 }));
  const duplicate = auditFixture("SKIPPED", "slot-2");
  await applyAutoListingAiPhaseOutcome(applyInput(duplicate,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_SKIPPED", { phaseTargetId: "slot-2", expectedStatusVersion: 3 }));

  const acceptedId = accepted.calls[2].values[0];
  const skippedId = skipped.calls[2].values[0];
  const duplicateId = duplicate.calls[2].values[0];
  assert.notEqual(acceptedId, skippedId);
  assert.equal(skippedId, duplicateId);
  assert.deepEqual(JSON.parse(accepted.calls[2].values[9]), {
    planId: "plan-derived", slotKey: "slot-main", statusVersion: 3,
  });
  assert.deepEqual(JSON.parse(skipped.calls[2].values[9]), {
    planId: "plan-derived", slotKey: "slot-2", statusVersion: 3,
  });
});

test("all-terminal insufficient image evidence requeues only the skipped slot with a fresh quality lineage", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ id: "audit" }] },
    { rowCount: 6, rows: [
      { slot_key: "slot-main", role: "MAIN", terminal_status: "ACCEPTED" },
      ...[2, 3, 4, 5].map((n) => ({ slot_key: `slot-${n}`, role: "DETAIL", terminal_status: "ACCEPTED" })),
      { slot_key: "slot-6", role: "DETAIL", terminal_status: "SKIPPED" },
    ] },
    { rowCount: 1, rows: [{ slot_key: "slot-6", recovery_count: 0 }] },
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "slot-recovery-event" }] },
    { rowCount: 1, rows: [{ id: "slot-recovery-outbox" }] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_SKIPPED", { phaseTargetId: "slot-6", expectedStatusVersion: 3 })),
  { disposition: "APPLIED", status: "GENERATING", statusVersion: 4, enqueued: 1 });
  assert.match(client.calls[4].sql, /AI_IMAGE_SLOT_RECOVERY_QUEUED/iu);
  assert.match(client.calls[5].sql, /status_version=status_version\+1/iu);
  assert.deepEqual(JSON.parse(client.calls[6].values[9]), {
    planId: "plan-derived", previousStatusVersion: 3, retrySlotKeys: ["slot-6"], recoveryRound: 1,
  });
  const outbox = client.calls.find(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql));
  assert.ok(outbox);
  const message = JSON.parse(outbox.values[7]);
  assert.equal(message.phase, "GENERATE_IMAGE_SLOT");
  assert.equal(message.slotKey, "slot-6");
  assert.equal(message.expectedStatusVersion, 4);
});

test("a skipped slot blocks only after two isolated recovery rounds are exhausted", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 5, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ id: "audit" }] },
    { rowCount: 6, rows: [
      { slot_key: "slot-main", role: "MAIN", terminal_status: "ACCEPTED" },
      ...[2, 3, 4, 5].map((n) => ({ slot_key: `slot-${n}`, role: "DETAIL", terminal_status: "ACCEPTED" })),
      { slot_key: "slot-6", role: "DETAIL", terminal_status: "SKIPPED" },
    ] },
    { rowCount: 1, rows: [{ slot_key: "slot-6", recovery_count: 2 }] },
    { rowCount: 1, rows: [{ status: "BLOCKED", status_version: 6 }] },
    { rowCount: 1, rows: [{ id: "blocked-event" }] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client,
    "GENERATE_IMAGE_SLOT", "IMAGE_SLOT_SKIPPED", { phaseTargetId: "slot-6", expectedStatusVersion: 5 })),
  { disposition: "APPLIED", status: "BLOCKED", statusVersion: 6, enqueued: 0 });
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/iu.test(sql)), false);
});

test("latest accepted rich content per visual group enters READY_FOR_REVIEW while older accepted history remains auditable", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ planned_group_count: "1", accepted_group_count: "1", invalid_result_count: "0", duplicate_group_count: "4" }] },
    { rowCount: 1, rows: [{ mode: "REVIEW", enabled: true }] },
    { rowCount: 1, rows: [{ status: "READY_FOR_REVIEW", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "ready-event" }] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client,
    "GENERATE_RICH_CONTENT", "CONTENT_READY_FOR_REVIEW", { expectedStatusVersion: 3 })),
  { disposition: "APPLIED", status: "READY_FOR_REVIEW", statusVersion: 4, enqueued: 0 });
  assert.equal(client.calls.some(({ sql }) => /auto_listing_ai_outbox/iu.test(sql)), false);
  assert.match(client.calls[2].sql, /visual_groups->'groups'/iu);
  assert.match(client.calls[2].sql, /jsonb_array_elements\(r\.asset_evidence\)/iu);
  assert.match(client.calls[2].sql, /DISTINCT ON \(group_key\)/iu);
});

test("a frozen DIRECT policy enters UPLOAD_QUEUED only while the server kill switch is enabled", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ planned_group_count: "1", accepted_group_count: "1", invalid_result_count: "0", duplicate_group_count: "0" }] },
    { rowCount: 1, rows: [{ mode: "DIRECT", enabled: true }] },
    { rowCount: 1, rows: [{ status: "UPLOAD_QUEUED", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "direct-event" }] },
    (_sql, values) => ({ rowCount: 1, rows: [{ id: values[0] }] }),
    { rowCount: 1, rows: [{ id: "upload-task-event" }] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client,
    "GENERATE_RICH_CONTENT", "CONTENT_READY_FOR_REVIEW", { expectedStatusVersion: 3 }),
  { directUploadAllowed: true }),
  { disposition: "APPLIED", status: "UPLOAD_QUEUED", statusVersion: 4, enqueued: 1 });
  assert.equal(client.calls[5].values[7], "CONTENT_READY_FOR_DIRECT_UPLOAD");
  assert.match(client.calls[6].sql, /INSERT INTO auto_listing_upload_tasks/iu);
  assert.deepEqual(client.calls[6].values.slice(1, 7), [
    "account-a", "job-a", "item-a", "account-a", 4, "correlation-a",
  ]);

  const blocked = scriptedClient([
    { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ planned_group_count: "1", accepted_group_count: "1", invalid_result_count: "0", duplicate_group_count: "0" }] },
    { rowCount: 1, rows: [{ mode: "DIRECT", enabled: true }] },
    { rowCount: 1, rows: [{ status: "BLOCKED", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "blocked-event" }] },
  ]);
  assert.equal((await applyAutoListingAiPhaseOutcome(applyInput(blocked,
    "GENERATE_RICH_CONTENT", "CONTENT_READY_FOR_REVIEW", { expectedStatusVersion: 3 }))).status, "BLOCKED");
  assert.equal(blocked.calls[4].values[6], "AUTO_LISTING_DIRECT_UPLOAD_DISABLED");
});

test("a fixed-skeleton item follows a frozen DIRECT policy when the server kill switch is enabled", async () => {
  const client = scriptedClient([
    { rowCount: 1, rows: [{
      status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived",
      planning_contract: "FIXED_SKELETON_V1",
    }] },
    { rowCount: 1, rows: [imagePlan()] },
    { rowCount: 1, rows: [{ planned_group_count: "1", accepted_group_count: "1", invalid_result_count: "0", duplicate_group_count: "0" }] },
    { rowCount: 1, rows: [{ mode: "DIRECT", enabled: true }] },
    { rowCount: 1, rows: [{ status: "UPLOAD_QUEUED", status_version: 4 }] },
    { rowCount: 1, rows: [{ id: "fixed-direct-event" }] },
    (_sql, values) => ({ rowCount: 1, rows: [{ id: values[0] }] }),
    { rowCount: 1, rows: [{ id: "fixed-upload-task-event" }] },
  ]);
  assert.deepEqual(await applyAutoListingAiPhaseOutcome(applyInput(client,
    "GENERATE_RICH_CONTENT", "CONTENT_READY_FOR_REVIEW", { expectedStatusVersion: 3 }),
  { directUploadAllowed: true }), {
    disposition: "APPLIED", status: "UPLOAD_QUEUED", statusVersion: 4, enqueued: 1,
  });
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO auto_listing_upload_tasks/iu.test(sql)), true);
  assert.equal(client.calls[5].values[7], "CONTENT_READY_FOR_DIRECT_UPLOAD");
});

test("accepted rich content requires exactly one independently scoped result for every planned visual group", async () => {
  for (const coverage of [
    { planned_group_count: "2", accepted_group_count: "1", invalid_result_count: "0", duplicate_group_count: "0" },
    { planned_group_count: "2", accepted_group_count: "2", invalid_result_count: "1", duplicate_group_count: "0" },
  ]) {
    const client = scriptedClient([
      { rowCount: 1, rows: [{ status: "GENERATING", status_version: 3, active_content_plan_id: "plan-derived" }] },
      { rowCount: 1, rows: [imagePlan()] },
      { rowCount: 1, rows: [coverage] },
    ]);
    await assert.rejects(applyAutoListingAiPhaseOutcome(applyInput(client,
      "GENERATE_RICH_CONTENT", "CONTENT_READY_FOR_REVIEW", { expectedStatusVersion: 3 })),
    { code: "AUTO_LISTING_AI_WORKFLOW_VERSION_CONFLICT" });
  }
});

test("final FAIL closes through the state machine with safe failure and recovery evidence", async () => {
  for (const retryable of [true, false]) {
    const status = retryable ? "RETRYABLE_ERROR" : "BLOCKED";
    const client = scriptedClient([
      { rowCount: 1, rows: [{ status: "PLANNING", status_version: 2, active_content_plan_id: "plan-parent" }] },
      { rowCount: 1, rows: [{ status, status_version: 3 }] },
      { rowCount: 1, rows: [{ id: "failure-event" }] },
    ]);
    const result = await applyAutoListingAiPhaseOutcome(applyInput(client, "PLAN_CONTENT", "FAILED", {
      outcome: outcome("PLAN_CONTENT", "FAILED", {
        disposition: "FAIL", retryable, failureCode: "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED",
      }),
    }));
    assert.equal(result.status, status);
    assert.equal(result.statusVersion, 3);
    assert.equal(client.calls[1].values[6], "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED");
    assert.equal(client.calls[1].values[5], retryable ? "PLANNING" : null);
  }
});

test("factory apply accepts only {message,outcome}, owns commit/rollback, and rejects RETRY before connecting", async () => {
  const calls = [];
  let released = 0;
  const client = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT") return { rowCount: null, rows: [] };
    if (/set_config\('statement_timeout'/u.test(sql)) return { rowCount: 1, rows: [{}] };
    if (/SELECT job_id FROM auto_listing_job_items/.test(sql)) return { rowCount: 1, rows: [{ job_id: "job-a" }] };
    if (/SELECT i.status,i.status_version/.test(sql)) {
      return { rowCount: 1, rows: [{ status: "PLANNING", status_version: 9, active_content_plan_id: "plan-parent" }] };
    }
    throw new Error(`unexpected: ${sql}`);
  }, release() { released += 1; } };
  let connects = 0;
  const workflow = createPostgresAutoListingAiWorkflow({ pool: {
    async query() {}, async connect() { connects += 1; return client; },
  } });
  const message = {
    contractVersion: "V1", accountId: "account-a", itemId: "item-a", phase: "PLAN_CONTENT",
    expectedStatusVersion: 2, correlationId: "correlation-a",
  };
  assert.equal((await workflow.applyPhaseOutcome({ message, outcome: outcome("PLAN_CONTENT", "PLAN_READY") })).disposition, "STALE");
  assert.deepEqual(calls.map(({ sql }) => {
    if (sql === "BEGIN" || sql === "COMMIT") return sql;
    return /set_config\('statement_timeout'/u.test(sql) ? "TIMEOUTS" : "QUERY";
  }), ["BEGIN", "TIMEOUTS", "QUERY", "QUERY", "COMMIT"]);
  assert.deepEqual(calls[1].values, ["25000", "5000", "30000"]);
  assert.equal(released, 1);
  await assert.rejects(workflow.applyPhaseOutcome({ message, outcome: outcome("PLAN_CONTENT", "FAILED", {
    disposition: "RETRY", retryable: true, failureCode: "AUTO_LISTING_CONTENT_PLAN_GATEWAY_FAILED",
  }) }), { code: "AUTO_LISTING_AI_WORKFLOW_RETRY_NOT_FINAL" });
  assert.equal(connects, 1);
  await assert.rejects(workflow.applyPhaseOutcome({ message, outcome: outcome("PLAN_CONTENT", "PLAN_READY"), extra: true }), {
    code: "AUTO_LISTING_AI_WORKFLOW_INVALID",
  });
});
