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
