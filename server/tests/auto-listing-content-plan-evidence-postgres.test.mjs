import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPostgresContentPlanEvidenceRepository } from "../auto-listing-content-plan-evidence-postgres.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const cryptoHash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function responseCommand(overrides = {}) {
  return {
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    sourceSnapshotId: "snapshot-a",
    owner: { kind: "ATTEMPT", id: "attempt-a" },
    planningContract: "LEGACY_FULL_PLAN_V3",
    inputHash: HASH_A,
    skeletonHash: null,
    profileId: "profile-a",
    profileVersion: 3,
    modelName: "vendor/planner-model",
    promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_V3",
    gatewayRequestId: "gateway-request-a",
    gatewayConnectionId: "connection-a",
    gatewayConnectionVersion: 3,
    response: { version: 1, language: "ru", slots: [] },
    ...overrides,
  };
}

function responseRow(command = responseCommand()) {
  return {
    id: "response-a",
    account_id: command.accountId,
    job_id: command.jobId,
    item_id: command.itemId,
    source_snapshot_id: command.sourceSnapshotId,
    attempt_id: command.owner.kind === "ATTEMPT" ? command.owner.id : null,
    diagnostic_run_id: command.owner.kind === "DIAGNOSTIC" ? command.owner.id : null,
    planning_contract: command.planningContract,
    input_hash: command.inputHash,
    skeleton_hash: command.skeletonHash,
    source_image_analysis_run_id: command.sourceImageAnalysisRunId ?? null,
    source_image_intelligence_hash: command.sourceImageIntelligenceHash ?? null,
    profile_id: command.profileId,
    profile_version: command.profileVersion,
    model_name: command.modelName,
    prompt_template_version: command.promptTemplateVersion,
    gateway_request_id: command.gatewayRequestId,
    response: structuredClone(command.response),
    response_hash: "c86329aebeef4e5e13ae4e152f93a2200093c7ab709aadeb32711c88fd4e99a6",
    received_at: new Date("2026-08-14T00:00:00.000Z"),
  };
}

test("intelligent response evidence is closed over the frozen analysis run and summary hash", async () => {
  const command = responseCommand({
    planningContract: "FIXED_SKELETON_SOURCE_IMAGE_V1",
    skeletonHash: HASH_B,
    sourceImageAnalysisRunId: "analysis-run-a",
    sourceImageIntelligenceHash: "d".repeat(64),
    response: { version: 1, language: "ru", fills: {} },
  });
  const db = scriptedPool((sql) => {
    if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_content_plan_attempts/i.test(sql)) return { rows: [{
      id: "attempt-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
      source_snapshot_id: "snapshot-a", profile_id: "profile-a", profile_version: 3,
      planning_contract: command.planningContract, input_hash: HASH_A, skeleton_hash: HASH_B,
      source_image_analysis_run_id: command.sourceImageAnalysisRunId,
      source_image_intelligence_hash: command.sourceImageIntelligenceHash,
      gateway_connection_id: "connection-a", gateway_connection_version: 3,
    }], rowCount: 1 };
    if (/FROM auto_listing_content_plan_responses/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO auto_listing_content_plan_responses/i.test(sql)) {
      const row = responseRow(command);
      row.response_hash = cryptoHash(command.response);
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const evidence = createPostgresContentPlanEvidenceRepository({ pool: db.pool, responseId: () => "response-a" });
  const stored = await evidence.recordResponse(command);
  assert.equal(stored.sourceImageAnalysisRunId, "analysis-run-a");
  assert.equal(stored.sourceImageIntelligenceHash, "d".repeat(64));
  const inserted = db.queries.find(({ text }) => /INSERT INTO auto_listing_content_plan_responses/i.test(text));
  assert.match(inserted.text, /source_image_analysis_run_id,source_image_intelligence_hash/i);
});

function scriptedPool(handler) {
  const queries = [];
  let connections = 0;
  const pool = {
    async connect() {
      connections += 1;
      return {
        async query(text, values = []) {
          queries.push({ text, values });
          return handler(text, values, queries);
        },
        release() {},
      };
    },
  };
  return { pool, queries, connections: () => connections };
}

test("records one bounded response before validation and exact replay returns the same evidence", async () => {
  let stored = null;
  const db = scriptedPool((sql) => {
    if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_content_plan_attempts/i.test(sql)) {
      return { rows: [{
        id: "attempt-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
        source_snapshot_id: "snapshot-a", profile_id: "profile-a", profile_version: 3,
        planning_contract: "LEGACY_FULL_PLAN_V3", input_hash: HASH_A, skeleton_hash: null,
        gateway_connection_id: "connection-a", gateway_connection_version: 3,
      }], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_responses/i.test(sql)) {
      return stored ? { rows: [stored], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO auto_listing_content_plan_responses/i.test(sql)) {
      stored = responseRow();
      return { rows: [stored], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const evidence = createPostgresContentPlanEvidenceRepository({
    pool: db.pool,
    responseId: () => "response-a",
    validationId: () => "validation-a",
  });

  const first = await evidence.recordResponse(responseCommand());
  const replay = await evidence.recordResponse(responseCommand());
  assert.deepEqual(replay, first);
  assert.equal(first.responseHash, responseRow().response_hash);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.response), true);
  assert.equal(db.queries.filter(({ text }) => /INSERT INTO auto_listing_content_plan_responses/i.test(text)).length, 1);

  await assert.rejects(
    evidence.recordResponse(responseCommand({ response: { version: 2, language: "ru", slots: [] } })),
    { code: "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT", retryable: false },
  );
});

test("rejects hostile or oversized response carriers before opening a database connection", async () => {
  const db = scriptedPool(() => { throw new Error("must not query"); });
  const evidence = createPostgresContentPlanEvidenceRepository({ pool: db.pool });
  let getterCalls = 0;
  const hostile = { version: 1, language: "ru", slots: [] };
  Object.defineProperty(hostile, "secret", {
    enumerable: true,
    get() { getterCalls += 1; return "credential-secret"; },
  });
  const revoked = Proxy.revocable({ version: 1, language: "ru", slots: [] }, {});
  revoked.revoke();
  const tooLarge = { version: 1, language: "ru", slots: [{ text: "x".repeat(2_000_001) }] };
  for (const response of [hostile, revoked.proxy, tooLarge]) {
    await assert.rejects(
      evidence.recordResponse(responseCommand({ response })),
      (error) => error?.code === "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_INVALID"
        && error?.message === "图片规划证据无效" && error?.cause === undefined,
    );
  }
  const tooManyFills = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`slot-${index}`, {}]));
  for (const fills of [[], tooManyFills]) {
    await assert.rejects(
      evidence.recordResponse(responseCommand({
        planningContract: "FIXED_SKELETON_V1",
        skeletonHash: HASH_B,
        response: { version: 1, language: "ru", fills },
      })),
      { code: "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_INVALID", retryable: false },
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(db.connections(), 0);
});

test("records one exact validation result and loads evidence only by the immutable owner tuple", async () => {
  const response = responseRow();
  let validation = null;
  const db = scriptedPool((sql) => {
    if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: 0 };
    if (/FROM auto_listing_content_plan_responses/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return { rows: [response], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_validation_results/i.test(sql)) {
      return validation ? { rows: [validation], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO auto_listing_content_plan_validation_results/i.test(sql)) {
      validation = {
        id: "validation-a", account_id: "account-a", response_id: "response-a",
        status: "REJECTED", validator_version: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
        issues: [{ code: "SLOT_COUNT_MISMATCH", slotKey: null, claimIndex: null, field: "slots", expected: "8", actual: "7" }],
        validated_at: new Date("2026-08-14T00:00:01.000Z"),
      };
      return { rows: [validation], rowCount: 1 };
    }
    if (/FROM auto_listing_content_plan_responses/i.test(sql) && /LEFT JOIN auto_listing_content_plan_validation_results/i.test(sql)) {
      return { rows: [{
        ...response,
        validation_id: validation.id,
        validation_status: validation.status,
        validator_version: validation.validator_version,
        issues: validation.issues,
        validated_at: validation.validated_at,
      }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const evidence = createPostgresContentPlanEvidenceRepository({
    pool: db.pool,
    responseId: () => "response-a",
    validationId: () => "validation-a",
  });
  const command = {
    accountId: "account-a",
    responseId: "response-a",
    status: "REJECTED",
    validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
    issues: [{ code: "SLOT_COUNT_MISMATCH", slotKey: null, claimIndex: null, field: "slots", expected: "8", actual: "7" }],
  };
  const first = await evidence.recordValidation(command);
  assert.deepEqual(await evidence.recordValidation(command), first);
  await assert.rejects(
    evidence.recordValidation({ ...command, issues: [{ ...command.issues[0], actual: "6" }] }),
    { code: "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT" },
  );

  const outcome = await evidence.loadOutcome({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
    owner: { kind: "ATTEMPT", id: "attempt-a" }, planningContract: "LEGACY_FULL_PLAN_V3",
    inputHash: HASH_A, skeletonHash: null, profileId: "profile-a", profileVersion: 3,
    gatewayConnectionId: "connection-a", gatewayConnectionVersion: 3,
  });
  assert.equal(outcome.response.id, "response-a");
  assert.equal(outcome.validation.status, "REJECTED");
  const loadSql = db.queries.find(({ text }) => /LEFT JOIN auto_listing_content_plan_validation_results/i.test(text)).text;
  assert.match(loadSql, /attempt_id=\$\d+/i);
  assert.match(loadSql, /gateway_connection_id IS NOT DISTINCT FROM \$\d+/i);
  assert.match(loadSql, /gateway_connection_version IS NOT DISTINCT FROM \$\d+/i);
  assert.doesNotMatch(loadSql, /ORDER BY|LIMIT 1|MAX\(/i);
  assert.equal(JSON.stringify(outcome).includes(HASH_B), false);
});

test("load rejects a hash-conflicting planner response instead of treating it as reusable", async () => {
  const db = scriptedPool((sql) => {
    if (/LEFT JOIN auto_listing_content_plan_validation_results/iu.test(sql)) return { rows: [{
      ...responseRow(), response_hash: HASH_B,
      validation_id: null, validation_status: null, validator_version: null,
      issues: null, validated_at: null,
    }], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const evidence = createPostgresContentPlanEvidenceRepository({ pool: db.pool });

  await assert.rejects(evidence.loadOutcome({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
    owner: { kind: "ATTEMPT", id: "attempt-a" }, planningContract: "LEGACY_FULL_PLAN_V3",
    inputHash: HASH_A, skeletonHash: null, profileId: "profile-a", profileVersion: 3,
    gatewayConnectionId: "connection-a", gatewayConnectionVersion: 3,
  }), { code: "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT" });
});
