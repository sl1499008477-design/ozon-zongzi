import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingPlanDiagnosticService } from "../auto-listing-plan-diagnostic-service.mjs";

const adminA = Object.freeze({ id: "account-a", role: "admin" });
const adminB = Object.freeze({ id: "account-b", role: "admin" });

function detail(overrides = {}) {
  return {
    responseId: "response-a",
    attemptId: "attempt-a",
    diagnosticRunId: null,
    planningContract: "LEGACY_FULL_PLAN_V3",
    model: "text-model-a",
    promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_V3",
    gatewayRequestId: "gateway-a",
    receivedAt: "2026-08-14T01:02:03.000Z",
    response: { version: 1, language: "ru", slots: [] },
    validation: {
      status: "REJECTED",
      validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
      issues: [{
        code: "ROLE_COUNT_MISMATCH", slotKey: "group-a:selling-point:01", claimIndex: null,
        field: "role", expected: "SELLING_POINT x 3", actual: "DETAIL x 2",
      }],
      validatedAt: "2026-08-14T01:02:04.000Z",
    },
    ...overrides,
  };
}

test("administrator reads only the exact account job and item diagnostic", async () => {
  const calls = [];
  const service = createAutoListingPlanDiagnosticService({ repository: {
    async loadLatest(input) {
      calls.push(input);
      return input.accountId === "account-a" ? detail() : null;
    },
  } });
  const result = await service.getLatest({ actor: adminA, jobId: "job-a", itemId: "item-a" });
  assert.deepEqual(Object.keys(result), [
    "responseId", "attemptId", "diagnosticRunId", "planningContract", "model",
    "promptTemplateVersion", "gatewayRequestId", "receivedAt", "response", "validation",
  ]);
  assert.deepEqual(calls[0], { accountId: "account-a", jobId: "job-a", itemId: "item-a" });
  await assert.rejects(
    service.getLatest({ actor: adminB, jobId: "job-a", itemId: "item-a" }),
    { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND", status: 404 },
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.validation.issues[0]), true);
});

test("service rejects unauthorized, open, hostile and secret-bearing data with fixed errors", async () => {
  let reads = 0;
  const repository = { async loadLatest() { reads += 1; return detail(); } };
  const service = createAutoListingPlanDiagnosticService({ repository });
  await assert.rejects(service.getLatest({ actor: { id: "account-a", role: "user" }, jobId: "job-a", itemId: "item-a" }),
    { code: "PERMISSION_FORBIDDEN", status: 403 });
  await assert.rejects(service.getLatest({ actor: adminA, jobId: "job-a", itemId: "item-a", extra: true }),
    { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID", status: 400 });
  assert.equal(reads, 0);

  for (const value of [
    detail({ response: { version: 1, language: "ru", slots: [], apiKey: "secret" } }),
    detail({ response: { version: 1, language: "ru", slots: [{ prompt: "do not expose" }] } }),
    Object.defineProperty(detail(), "model", { enumerable: true, get() { throw new Error("raw-secret"); } }),
    new Proxy(detail(), {}),
  ]) {
    const unsafe = createAutoListingPlanDiagnosticService({ repository: { async loadLatest() { return value; } } });
    await assert.rejects(unsafe.getLatest({ actor: adminA, jobId: "job-a", itemId: "item-a" }),
      (error) => error?.code === "AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED" && error.status === 500
        && !/secret|prompt/iu.test(error.message));
  }
});

test("text-only replay persists one rejected diagnosis without creating a content plan or image work", async () => {
  const calls = [];
  const rejected = detail({
    diagnosticRunId: "diagnostic-a", attemptId: null,
  });
  const service = createAutoListingPlanDiagnosticService({
    repository: {
      async loadLatest(input) { calls.push(["latest", input]); return rejected; },
      async loadRun(input) { calls.push(["run", input]); return rejected; },
    },
    contextRepository: {
      async reserve(input) {
        calls.push(["reserve", input]);
        return {
          status: "RESERVED", runId: "diagnostic-a", accountId: "account-a",
          jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
          planningContract: "LEGACY_FULL_PLAN_V3", inputHash: "a".repeat(64), skeletonHash: null,
          profileId: "profile-a", profileVersion: 3,
          gatewayProfile: { id: "profile-a" }, model: "vendor/text-model-a",
          templateVersion: "AUTO_LISTING_CONTENT_PLAN_V3", requestKey: "diagnostic-request-a",
          correlationId: "corr-a", request: { schema: {}, text: "safe frozen facts" },
          validationContext: { marker: "frozen" },
        };
      },
      async complete(input) { calls.push(["complete", input]); return { status: input.status }; },
    },
    gateway: {
      async createTextResponse(input) {
        calls.push(["gateway", input]);
        return { requestId: "gateway-a", value: rejected.response };
      },
    },
    evidenceRepository: {
      async loadOutcome(input) { calls.push(["outcome", input]); return null; },
      async recordResponse(input) { calls.push(["response", input]); return {
        id: "response-a", gatewayRequestId: "gateway-a", response: input.response,
      }; },
      async recordValidation(input) { calls.push(["validation", input]); return input; },
    },
    diagnoseResponse() { return rejected.validation; },
  });
  const result = await service.replay({
    actor: adminA, jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
    expectedStatusVersion: 9, costConfirmed: true, idempotencyKey: "diagnostic-once-a",
    correlationId: "corr-a",
  });
  assert.equal(result.created, true);
  assert.equal(result.detail.validation.status, "REJECTED");
  assert.deepEqual(calls.map(([name]) => name), [
    "reserve", "outcome", "gateway", "response", "validation", "complete", "run",
  ]);
  assert.equal(calls.filter(([name]) => name === "gateway").length, 1);
  assert.equal(calls.some(([name]) => /image|plan|asset|ozon/iu.test(name)), false);
});

test("diagnostic replay closes cost, request shape, idempotency and existing-result boundaries", async () => {
  let reserves = 0;
  let gateways = 0;
  const existing = detail({ diagnosticRunId: "diagnostic-a", attemptId: null });
  const service = createAutoListingPlanDiagnosticService({
    repository: { async loadLatest() { return existing; }, async loadRun() { return existing; } },
    contextRepository: {
      async reserve() { reserves += 1; return { status: "EXISTING", runId: "diagnostic-a" }; },
      async complete() { throw new Error("must not complete"); },
    },
    gateway: { async createTextResponse() { gateways += 1; } },
    evidenceRepository: { async loadOutcome() {}, async recordResponse() {}, async recordValidation() {} },
    diagnoseResponse() {},
  });
  const command = {
    actor: adminA, jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
    expectedStatusVersion: 9, costConfirmed: true, idempotencyKey: "diagnostic-once-a",
    correlationId: "corr-a",
  };
  const replay = await service.replay(command);
  assert.equal(replay.created, false);
  assert.equal(replay.detail.diagnosticRunId, "diagnostic-a");
  assert.equal(replay.detail.validation.status, "REJECTED");
  for (const invalidCommand of [
    { ...command, costConfirmed: false },
    { ...command, expectedStatusVersion: 0 },
    { ...command, extra: true },
    { ...command, actor: { id: "account-a", role: "user" } },
  ]) await assert.rejects(service.replay(invalidCommand));
  assert.equal(reserves, 1);
  assert.equal(gateways, 0);
});

test("an ambiguous paid transport is terminalized safely and is never automatically called twice", async () => {
  let gateways = 0;
  const completions = [];
  const service = createAutoListingPlanDiagnosticService({
    repository: { async loadLatest() { return null; }, async loadRun() { return null; } },
    contextRepository: {
      async reserve() { return {
        status: "RESERVED", runId: "diagnostic-a", accountId: "account-a",
        jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
        planningContract: "LEGACY_FULL_PLAN_V3", inputHash: "a".repeat(64), skeletonHash: null,
        profileId: "profile-a", profileVersion: 3, gatewayProfile: { id: "profile-a" },
        model: "vendor/text-model-a", templateVersion: "AUTO_LISTING_CONTENT_PLAN_V3",
        requestKey: "diagnostic-request-a", correlationId: "corr-a",
        request: { schema: {}, text: "safe frozen facts" }, validationContext: { marker: "frozen" },
      }; },
      async complete(input) { completions.push(input); return { status: input.status }; },
    },
    gateway: { async createTextResponse() { gateways += 1; throw new Error("provider response unknown"); } },
    evidenceRepository: { async loadOutcome() { return null; }, async recordResponse() {}, async recordValidation() {} },
    diagnoseResponse() {},
  });
  await assert.rejects(service.replay({
    actor: adminA, jobId: "job-a", itemId: "item-a", sourceSnapshotId: "snapshot-a",
    expectedStatusVersion: 9, costConfirmed: true, idempotencyKey: "diagnostic-once-a", correlationId: "corr-a",
  }), { code: "AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED" });
  assert.equal(gateways, 1);
  assert.deepEqual(completions, [{
    accountId: "account-a", runId: "diagnostic-a", status: "FAILED",
    failureCode: "AUTO_LISTING_PLAN_DIAGNOSTIC_EXECUTION_FAILED",
  }]);
});
