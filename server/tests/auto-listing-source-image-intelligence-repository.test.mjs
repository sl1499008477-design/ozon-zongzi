import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
} from "../auto-listing-source-image-intelligence-contract.mjs";

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const HASHES = Object.freeze({ snapshot: "1".repeat(64), assets: "2".repeat(64), input: "3".repeat(64) });
const baseScope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", expectedStatusVersion: 7 });

function repositoryOptions() {
  let nextId = 0;
  return {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    id: (kind) => `${kind}-${++nextId}`,
    token: () => "stable-token",
  };
}

function runInput(overrides = {}) {
  return {
    ...baseScope,
    sourceSnapshotId: "snapshot-a",
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceSnapshotHash: HASHES.snapshot,
    sourceAssetSetHash: HASHES.assets,
    inputHash: HASHES.input,
    promptTemplateVersion: "source-image-analysis-v1",
    profileId: "profile-a",
    profileVersion: 3,
    modelName: "vision-model",
    expectedAssetCount: 2,
    ...overrides,
  };
}

function scope(run, overrides = {}) {
  return {
    accountId: run.accountId,
    jobId: run.jobId,
    itemId: run.itemId,
    analysisRunId: run.id,
    expectedStatusVersion: run.expectedStatusVersion,
    ...overrides,
  };
}

function assessment(sourceAssetId, overrides = {}) {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    sourceAssetId,
    sourceOrdinal: overrides.sourceOrdinal ?? Number(sourceAssetId.match(/\d+$/u)?.[0] || 1) - 1,
    objectKey: `auto-listing/source/v2/account/job/item/analysis-run/run/${sourceAssetId}/object.jpg`,
    contentHash: (overrides.contentDigit ?? "a").repeat(64),
    parentSourceAssetId: null,
    terminalStatus: overrides.terminalStatus ?? "ANALYZED",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: ["VISIBLE_FRONT"] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [],
    markings: [],
    perceptualDuplicateGroup: null,
    duplicateOfSourceAssetId: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"],
    reasonCodes: [],
  };
  return { ...value, assessmentHash: hash(value), ...overrides.output };
}

function batchInput(run, assessments, overrides = {}) {
  const analysisBatchId = overrides.analysisBatchId ?? "batch-1";
  return {
    ...scope(run),
    analysisBatchId,
    inputHash: overrides.inputHash ?? "4".repeat(64),
    resultHash: overrides.resultHash ?? hash(assessments.map(({ assessmentHash }) => assessmentHash)),
    assessments,
  };
}

function summary(overrides = {}) {
  const value = {
    contractVersion: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    coverageMap: { FRONT: ["asset-1"] },
    factCandidates: [],
    markingDecisions: [],
    eligibleAssetIds: ["asset-1", "asset-2"],
    excludedAssetIds: [],
    requiredConfirmations: [],
    symmetryClass: "ASYMMETRIC",
    reasonCodes: [],
    ...overrides,
  };
  return { ...value, summaryHash: hash(value) };
}

async function moduleUnderTest() {
  return import(`../auto-listing-source-image-intelligence-repository.mjs?test=${Date.now()}-${Math.random()}`);
}

test("both repository factories expose the same eight-method contract", async () => {
  const { createMemorySourceImageIntelligenceRepository, createPostgresSourceImageIntelligenceRepository } = await moduleUnderTest();
  const expected = [
    "acceptSummary", "listRunAssessments", "loadAcceptedSummary", "markAssetMaterialized",
    "markAssetUnavailable", "recordBatchAssessments", "recordSourceImageDecision", "reserveAnalysisRun",
  ];
  assert.deepEqual(Object.keys(createMemorySourceImageIntelligenceRepository(repositoryOptions())).sort(), expected);
  assert.deepEqual(Object.keys(createPostgresSourceImageIntelligenceRepository({ pool: { connect() {} } })).sort(), expected);
});

test("analysis runs replay by stable input and reject a conflicting current run", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const first = await repository.reserveAnalysisRun(runInput());
  assert.equal(first.status, "MATERIALIZING");
  assert.deepEqual(await repository.reserveAnalysisRun(runInput()), first);
  await assert.rejects(repository.reserveAnalysisRun(runInput({ inputHash: "9".repeat(64) })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_RUN_CONFLICT",
  });
});

test("materialized and unavailable assets are idempotent and remain run-scoped", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await repository.reserveAnalysisRun(runInput());
  const materialized = {
    ...scope(run), sourceAssetId: "asset-1", sourceOrdinal: 0, sourceRefHash: "5".repeat(64),
    objectKey: "auto-listing/source/v2/account/job/item/analysis-run/run/asset-1/object.jpg",
    contentHash: "a".repeat(64), contentType: "image/jpeg", sizeBytes: 1024,
  };
  assert.deepEqual(await repository.markAssetMaterialized(materialized), await repository.markAssetMaterialized(materialized));
  const unavailable = { ...scope(run), sourceAssetId: "asset-2", sourceOrdinal: 1,
    terminalStatus: "DOWNLOAD_FAILED", errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED" };
  const unavailableFirst = await repository.markAssetUnavailable(unavailable);
  assert.deepEqual(await repository.markAssetUnavailable(unavailable), unavailableFirst);
  assert.equal(unavailableFirst.sourceOrdinal, 1);
  await assert.rejects(repository.markAssetUnavailable({ ...unavailable, accountId: "account-b" }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT",
  });
  assert.equal((await repository.listRunAssessments(scope(run))).length, 1);
});

test("unavailable evidence requires and persists the same trusted ordinal in memory and PostgreSQL", async () => {
  const { createMemorySourceImageIntelligenceRepository, createPostgresSourceImageIntelligenceRepository } = await moduleUnderTest();
  const memory = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await memory.reserveAnalysisRun(runInput());
  const input = { ...scope(run), sourceAssetId: "asset-2", sourceOrdinal: 1,
    terminalStatus: "DOWNLOAD_FAILED", errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED" };
  assert.equal((await memory.markAssetUnavailable(input)).sourceOrdinal, 1);
  const { sourceOrdinal: ignoredOrdinal, ...missingOrdinal } = input;
  await assert.rejects(memory.markAssetUnavailable(missingOrdinal), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID",
  });

  const calls = [];
  let connects = 0;
  const createdAt = new Date("2026-08-30T00:00:00.000Z");
  const client = {
    release() {},
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT \* FROM auto_listing_source_image_analysis_runs/u.test(sql)) return { rowCount: 1, rows: [{
        id: run.id, account_id: run.accountId, job_id: run.jobId, item_id: run.itemId,
        source_snapshot_id: run.sourceSnapshotId, expected_status_version: run.expectedStatusVersion,
        intelligence_contract_version: run.contractVersion, source_snapshot_hash: run.sourceSnapshotHash,
        source_asset_set_hash: run.sourceAssetSetHash, input_hash: run.inputHash,
        prompt_template_version: run.promptTemplateVersion, profile_id: run.profileId,
        profile_version: run.profileVersion, model_name: run.modelName,
        expected_asset_count: run.expectedAssetCount, terminal_asset_count: 0, status: "MATERIALIZING",
        parent_run_id: null, derivation_kind: "INITIAL", summary: null, summary_hash: null,
        summary_input_hash: null, decision_set: [], decision_set_hash: run.decisionSetHash,
        created_at: createdAt, completed_at: null,
      }] };
      if (/SELECT status_version,current_source_image_analysis_run_id/u.test(sql)) {
        return { rowCount: 1, rows: [{ status_version: 7, current_source_image_analysis_run_id: run.id }] };
      }
      if (/SELECT \* FROM auto_listing_source_image_assessments/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT source_asset_id FROM auto_listing_source_image_assessments/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO auto_listing_source_image_assessments/u.test(sql)) return { rowCount: 1, rows: [{
        account_id: input.accountId, job_id: input.jobId, item_id: input.itemId,
        analysis_run_id: input.analysisRunId, expected_status_version: input.expectedStatusVersion,
        source_asset_id: input.sourceAssetId, source_ordinal: input.sourceOrdinal,
        terminal_status: input.terminalStatus, analysis_batch_id: null, input_hash: null,
        result_hash: "9".repeat(64), assessment: null, error_code: input.errorCode, created_at: createdAt,
      }] };
      if (/UPDATE auto_listing_source_image_analysis_runs/u.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const postgres = createPostgresSourceImageIntelligenceRepository({
    pool: { async connect() { connects += 1; return client; } }, ...repositoryOptions(),
  });
  assert.equal((await postgres.markAssetUnavailable(input)).sourceOrdinal, 1);
  const insert = calls.find(({ sql }) => /INSERT INTO auto_listing_source_image_assessments/u.test(sql));
  assert.match(insert.sql, /source_asset_id,source_ordinal,record_status/u);
  assert.equal(insert.params[6], 1);
  await assert.rejects(postgres.markAssetUnavailable(missingOrdinal), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID",
  });
  assert.equal(connects, 1, "invalid input must fail before PostgreSQL access");
});

test("accepted batches replay without replacing another asset assessment", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await repository.reserveAnalysisRun(runInput());
  const firstBatch = batchInput(run, [assessment("asset-1"), assessment("asset-2", { contentDigit: "b" })]);
  assert.equal((await repository.recordBatchAssessments(firstBatch)).status, "ACCEPTED");
  const replay = await repository.recordBatchAssessments(firstBatch);
  assert.equal(replay.status, "EXISTING_ACCEPTED");
  assert.equal((await repository.listRunAssessments(scope(run))).length, 2);
  await assert.rejects(repository.recordBatchAssessments(batchInput(run, [assessment("asset-1", { contentDigit: "c" })], {
    analysisBatchId: "batch-2", inputHash: "6".repeat(64),
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT" });
  assert.equal((await repository.listRunAssessments(scope(run))).length, 2);
});

test("summary acceptance requires every asset terminal and confirmation rows change run status", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const incomplete = await repository.reserveAnalysisRun(runInput());
  await repository.recordBatchAssessments(batchInput(incomplete, [assessment("asset-1")]));
  await assert.rejects(repository.acceptSummary({ ...scope(incomplete), inputHash: "7".repeat(64), summary: summary() }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_TERMINAL_COUNT_MISMATCH",
  });

  const repository2 = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await repository2.reserveAnalysisRun(runInput());
  await repository2.recordBatchAssessments(batchInput(run, [
    assessment("asset-1"), assessment("asset-2", { terminalStatus: "CONFIRMATION_REQUIRED", contentDigit: "b" }),
  ]));
  const accepted = await repository2.acceptSummary({ ...scope(run), inputHash: "7".repeat(64), summary: summary({ requiredConfirmations: ["asset-2"] }) });
  assert.equal(accepted.status, "CONFIRMATION_REQUIRED");
  assert.equal((await repository2.loadAcceptedSummary(scope(run))).summaryHash, accepted.summaryHash);
  assert.deepEqual(await repository2.acceptSummary({ ...scope(run), inputHash: "7".repeat(64), summary: summary({ requiredConfirmations: ["asset-2"] }) }), accepted);
});

test("PostgreSQL summary replay is immutable even after the current item advanced to the blocked page version", async () => {
  const { createPostgresSourceImageIntelligenceRepository } = await moduleUnderTest();
  const acceptedSummary = summary({ requiredConfirmations: [{
    sourceAssetId: "asset-2", kind: "UNCERTAIN_MARKING", regions: [],
    reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_UNIQUE_VIEW_MARKING_UNCERTAIN"],
  }] });
  const calls = [];
  const client = {
    release() {},
    async query(sql) {
      calls.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT \* FROM auto_listing_source_image_analysis_runs[\s\S]*expected_status_version=\$5 FOR UPDATE/u.test(sql)) {
        return { rowCount: 1, rows: [{
          id: "run-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
          source_snapshot_id: "snapshot-a", expected_status_version: 7,
          intelligence_contract_version: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
          source_snapshot_hash: HASHES.snapshot, source_asset_set_hash: HASHES.assets,
          input_hash: HASHES.input, prompt_template_version: "source-image-analysis-v1",
          profile_id: "profile-a", profile_version: 3, model_name: "vision-model",
          expected_asset_count: 2, terminal_asset_count: 2, status: "CONFIRMATION_REQUIRED",
          parent_run_id: null, derivation_kind: "INITIAL", decision_set: [],
          decision_set_hash: hash([]), summary: acceptedSummary,
          summary_hash: acceptedSummary.summaryHash, summary_input_hash: "7".repeat(64),
          created_at: new Date("2026-08-30T00:00:00.000Z"),
          completed_at: new Date("2026-08-30T00:01:00.000Z"),
        }] };
      }
      if (/FROM auto_listing_job_items/u.test(sql)) {
        throw new Error("matching terminal summary replay must not depend on the advanced current item");
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const repository = createPostgresSourceImageIntelligenceRepository({
    pool: { async connect() { return client; } }, ...repositoryOptions(),
  });

  const replay = await repository.acceptSummary({
    ...baseScope, analysisRunId: "run-a", inputHash: "7".repeat(64), summary: acceptedSummary,
  });

  assert.equal(replay.status, "CONFIRMATION_REQUIRED");
  assert.equal(replay.summaryHash, acceptedSummary.summaryHash);
  assert.equal(calls.some((sql) => /FROM auto_listing_job_items/u.test(sql)), false);
  assert.equal(calls.at(-1), "COMMIT");
});

test("PostgreSQL decision replay performs each lookup with one values array and no callback-shaped third argument", async () => {
  const { createPostgresSourceImageIntelligenceRepository } = await moduleUnderTest();
  const decisionInput = {
    ...baseScope, expectedStatusVersion: 8, analysisRunId: "run-a", sourceAssetId: "asset-2",
    decision: "EXTERNAL_OVERLAY_EXCLUDE", idempotencyKey: "decision-replay-a",
    correlationId: "correlation-replay-request",
  };
  const createdAt = new Date("2026-08-30T00:02:00.000Z");
  const derivedRunRow = {
    id: "run-derived", account_id: "account-a", job_id: "job-a", item_id: "item-a",
    source_snapshot_id: "snapshot-a", expected_status_version: 9,
    intelligence_contract_version: SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
    source_snapshot_hash: HASHES.snapshot, source_asset_set_hash: HASHES.assets,
    input_hash: "8".repeat(64), prompt_template_version: "source-image-analysis-v1",
    profile_id: "profile-a", profile_version: 3, model_name: "vision-model",
    expected_asset_count: 2, terminal_asset_count: 2, status: "RECONCILING",
    parent_run_id: "run-a", derivation_kind: "MANUAL_DECISION", decision_set: [],
    decision_set_hash: "d".repeat(64), summary: null, summary_hash: null, summary_input_hash: null,
    created_at: createdAt, completed_at: null,
  };
  const queryShapes = [];
  const client = {
    release() {},
    async query(...args) {
      queryShapes.push(args);
      const [sql] = args;
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/pg_advisory_xact_lock/u.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/SELECT decision\.\*/u.test(sql)) return { rowCount: 1, rows: [{
        id: "decision-row", account_id: "account-a", job_id: "job-a", item_id: "item-a",
        analysis_run_id: "run-a", expected_status_version: 8, source_asset_id: "asset-2",
        decision: "EXTERNAL_OVERLAY_EXCLUDE", idempotency_key: "decision-replay-a",
        decision_hash: "c".repeat(64), derived_decision_set_hash: "d".repeat(64), created_at: createdAt,
      }] };
      if (/parent_run_id=\$2/u.test(sql)) return { rows: [derivedRunRow], rowCount: 1 };
      if (/FROM auto_listing_ai_outbox/u.test(sql)) return { rowCount: 1, rows: [{
        phase: "RECONCILE_SOURCE_IMAGE_ANALYSIS", phase_target_id: "run-derived",
        expected_status_version: 9, correlation_id: "correlation-original", dedupe_key: "dedupe-original",
      }] };
      if (/FROM auto_listing_events/u.test(sql)) return { rowCount: 1, rows: [{
        event_type: "SOURCE_IMAGE_DECISION_ACCEPTED", from_status: "BLOCKED", to_status: "PLANNING",
        transition_version: 9, correlation_id: "correlation-original",
      }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const repository = createPostgresSourceImageIntelligenceRepository({
    pool: { async connect() { return client; } }, ...repositoryOptions(),
  });

  const replay = await repository.recordSourceImageDecision(decisionInput);

  assert.equal(replay.derivedRun.id, "run-derived");
  assert.equal(replay.outbox.correlationId, "correlation-original");
  assert.equal(queryShapes.every((args) => args.length <= 2), true);
  assert.equal(queryShapes.filter(([sql]) => /FROM auto_listing_ai_outbox/u.test(sql)).length, 1);
});

test("current blocked-page decisions authorize from the accepted summary and atomically resume reconciliation", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const parentRun = await repository.reserveAnalysisRun(runInput());
  await repository.recordBatchAssessments(batchInput(parentRun, [
    assessment("asset-1"), assessment("asset-2", { terminalStatus: "ANALYZED", contentDigit: "b" }),
  ]));
  await repository.acceptSummary({
    ...scope(parentRun), inputHash: "7".repeat(64),
    summary: summary({ requiredConfirmations: [{
      sourceAssetId: "asset-2", kind: "UNCERTAIN_MARKING", regions: [],
      reasonCodes: ["AUTO_LISTING_SOURCE_IMAGE_UNIQUE_VIEW_MARKING_UNCERTAIN"],
    }] }),
  });
  const input = {
    ...scope(parentRun), expectedStatusVersion: 8, sourceAssetId: "asset-2",
    decision: "EXTERNAL_OVERLAY_EXCLUDE", idempotencyKey: "decision-asset-2-v8", correlationId: "correlation-a",
  };
  await assert.rejects(repository.recordSourceImageDecision({ ...input, sourceAssetId: "asset-1", idempotencyKey: "other" }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT",
  });
  const first = await repository.recordSourceImageDecision(input);
  const replay = await repository.recordSourceImageDecision({ ...input, correlationId: "correlation-replay" });
  assert.deepEqual(replay, first);
  assert.equal(first.derivedRun.parentRunId, first.decision.analysisRunId);
  assert.equal(first.derivedRun.derivationKind, "MANUAL_DECISION");
  assert.equal(first.derivedRun.summaryHash, null);
  assert.equal(first.derivedRun.expectedStatusVersion, 9);
  assert.equal(first.item.status, "PLANNING");
  assert.equal(first.item.statusVersion, 9);
  assert.equal(first.event.eventType, "SOURCE_IMAGE_DECISION_ACCEPTED");
  assert.equal(first.outbox.phase, "RECONCILE_SOURCE_IMAGE_ANALYSIS");
  assert.equal(first.outbox.analysisRunId, first.derivedRun.id);
  assert.deepEqual(
    (await repository.listRunAssessments(scope(first.derivedRun))).map(({ resultHash }) => resultHash),
    (await repository.listRunAssessments(scope(parentRun))).map(({ resultHash }) => resultHash),
  );
  assert.equal(await repository.loadAcceptedSummary(scope(first.derivedRun)), null);
  await assert.rejects(repository.recordSourceImageDecision({ ...input, decision: "PRODUCT_MARKING" }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT",
  });
});

test("a manual decision lets the derived run accept a summary with no unresolved confirmation", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const parentRun = await repository.reserveAnalysisRun(runInput());
  await repository.recordBatchAssessments(batchInput(parentRun, [
    assessment("asset-1"), assessment("asset-2", { terminalStatus: "CONFIRMATION_REQUIRED", contentDigit: "b" }),
  ]));
  await repository.acceptSummary({
    ...scope(parentRun), inputHash: "7".repeat(64), summary: summary({ requiredConfirmations: ["asset-2"] }),
  });
  const { derivedRun } = await repository.recordSourceImageDecision({
    ...scope(parentRun), expectedStatusVersion: 8, sourceAssetId: "asset-2", decision: "EXTERNAL_OVERLAY_EXCLUDE",
    idempotencyKey: "decision-asset-2-v8", correlationId: "correlation-resolve",
  });

  const resolved = await repository.acceptSummary({
    ...scope(derivedRun), inputHash: "8".repeat(64),
    summary: summary({ eligibleAssetIds: ["asset-1"], excludedAssetIds: ["asset-2"], requiredConfirmations: [] }),
  });

  assert.equal(resolved.status, "ACCEPTED");
});

test("batch assessments reject unavailable lifecycle rows and out-of-range ordinals", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await repository.reserveAnalysisRun(runInput());
  const unavailableValue = {
    ...assessment("asset-1"), objectKey: null, contentHash: null, terminalStatus: "DOWNLOAD_FAILED",
  };
  const { assessmentHash: ignoredHash, ...unavailableEvidence } = unavailableValue;
  unavailableValue.assessmentHash = hash(unavailableEvidence);
  await assert.rejects(repository.recordBatchAssessments(batchInput(run, [unavailableValue])), {
    code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID",
  });
  await assert.rejects(repository.recordBatchAssessments(batchInput(run, [assessment("asset-10001")], {
    analysisBatchId: "batch-large-ordinal", inputHash: "5".repeat(64),
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID" });
});

test("source ordinals are unique within one batch and across accepted run evidence", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await repository.reserveAnalysisRun(runInput());
  await assert.rejects(repository.recordBatchAssessments(batchInput(run, [
    assessment("asset-1", { sourceOrdinal: 0 }), assessment("asset-2", { sourceOrdinal: 0, contentDigit: "b" }),
  ])), { code: "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID" });
  await repository.recordBatchAssessments(batchInput(run, [assessment("asset-1", { sourceOrdinal: 0 })]));
  await assert.rejects(repository.recordBatchAssessments(batchInput(run, [assessment("asset-2", {
    sourceOrdinal: 0, contentDigit: "b",
  })], { analysisBatchId: "batch-2", inputHash: "6".repeat(64) })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT",
  });
});

test("terminal runs replay matching evidence but reject every new asset or batch", async () => {
  const { createMemorySourceImageIntelligenceRepository } = await moduleUnderTest();
  const repository = createMemorySourceImageIntelligenceRepository(repositoryOptions());
  const run = await repository.reserveAnalysisRun(runInput());
  const materialized = {
    ...scope(run), sourceAssetId: "asset-1", sourceOrdinal: 0, sourceRefHash: "5".repeat(64),
    objectKey: assessment("asset-1").objectKey, contentHash: "a".repeat(64),
    contentType: "image/jpeg", sizeBytes: 1024,
  };
  const materializedFirst = await repository.markAssetMaterialized(materialized);
  const acceptedBatch = batchInput(run, [assessment("asset-1"), assessment("asset-2", { contentDigit: "b" })]);
  await repository.recordBatchAssessments(acceptedBatch);
  await repository.acceptSummary({ ...scope(run), inputHash: "7".repeat(64), summary: summary() });

  assert.deepEqual(await repository.markAssetMaterialized(materialized), materializedFirst);
  assert.equal((await repository.recordBatchAssessments(acceptedBatch)).status, "EXISTING_ACCEPTED");
  await assert.rejects(repository.markAssetMaterialized({
    ...scope(run), sourceAssetId: "asset-3", sourceOrdinal: 2, sourceRefHash: "5".repeat(64),
    objectKey: "auto-listing/source/v2/account/job/item/analysis-run/run/asset-3/object.jpg",
    contentHash: "c".repeat(64), contentType: "image/jpeg", sizeBytes: 1024,
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL" });
  await assert.rejects(repository.markAssetUnavailable({
    ...scope(run), sourceAssetId: "asset-3", sourceOrdinal: 2, terminalStatus: "DOWNLOAD_FAILED",
    errorCode: "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL" });
  await assert.rejects(repository.recordBatchAssessments(batchInput(run, [assessment("asset-3", {
    sourceOrdinal: 2, contentDigit: "c",
  })], { analysisBatchId: "batch-2", inputHash: "6".repeat(64) })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL",
  });
});
