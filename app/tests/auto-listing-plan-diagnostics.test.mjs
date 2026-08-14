import assert from "node:assert/strict";
import test from "node:test";

import { autoListingPlanDiagnosticDetail } from "../src/auto-listing-plan-diagnostics.js";

function detail(overrides = {}) {
  return {
    responseId: "response-a", attemptId: "attempt-a", diagnosticRunId: null,
    planningContract: "LEGACY_FULL_PLAN_V3", model: "text-model-a",
    promptTemplateVersion: "AUTO_LISTING_CONTENT_PLAN_V3", gatewayRequestId: "gateway-a",
    receivedAt: "2026-08-14T01:02:03.000Z",
    response: { version: 1, language: "ru", slots: [] },
    validation: {
      status: "REJECTED", validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
      issues: [{ code: "ROLE_COUNT_MISMATCH", slotKey: "group-a:selling-point:01", claimIndex: null,
        field: "role", expected: "SELLING_POINT x 3", actual: "DETAIL x 2" }],
      validatedAt: "2026-08-14T01:02:04.000Z",
    },
    ...overrides,
  };
}

test("projects exact accepted and rejected administrator diagnostics as detached frozen data", () => {
  const rejected = detail();
  const projected = autoListingPlanDiagnosticDetail(rejected);
  const { promptTemplateVersion, ...rejectedWithoutPromptName } = rejected;
  assert.deepEqual(projected, {
    ...rejectedWithoutPromptName,
    templateVersion: promptTemplateVersion,
  });
  assert.notEqual(projected, rejected);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.response), true);
  assert.equal(Object.isFrozen(rejected), false);
  const accepted = detail({
    planningContract: "FIXED_SKELETON_V1",
    response: { version: 1, language: "ru", fills: {} },
    validation: { status: "ACCEPTED", validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
      issues: [], validatedAt: "2026-08-14T01:02:04.000Z" },
  });
  assert.equal(autoListingPlanDiagnosticDetail(accepted)?.validation.status, "ACCEPTED");
});

test("rejects missing, extra, secret, oversized and hostile diagnostic carriers without traps", () => {
  const missing = detail(); delete missing.model;
  const extra = detail({ rawError: "private" });
  const secret = detail({ response: { version: 1, language: "ru", slots: [{ apiKey: "hidden" }] } });
  const oversized = detail({ response: { version: 1, language: "ru", slots: [{ text: "x".repeat(2_000_001) }] } });
  let getters = 0;
  const accessor = detail();
  Object.defineProperty(accessor.validation, "issues", { enumerable: true, get() { getters += 1; return []; } });
  const custom = Object.assign(Object.create({ inherited: true }), detail());
  let traps = 0;
  const active = new Proxy(detail(), { ownKeys() { traps += 1; return []; } });
  const { proxy: revoked, revoke } = Proxy.revocable(detail(), {}); revoke();
  for (const value of [missing, extra, secret, oversized, accessor, custom, active, revoked]) {
    assert.equal(autoListingPlanDiagnosticDetail(value), null);
  }
  assert.equal(getters, 0);
  assert.equal(traps, 0);
});

test("accepts at most one hundred exact bounded issues", () => {
  const one = detail().validation.issues[0];
  assert.equal(autoListingPlanDiagnosticDetail(detail({
    validation: { ...detail().validation, issues: Array.from({ length: 100 }, () => ({ ...one })) },
  }))?.validation.issues.length, 100);
  assert.equal(autoListingPlanDiagnosticDetail(detail({
    validation: { ...detail().validation, issues: Array.from({ length: 101 }, () => ({ ...one })) },
  })), null);
});
