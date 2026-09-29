import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSourceImageDecisionService } from "../auto-listing-source-image-decision-service.mjs";

const input = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
  sourceAssetId: "asset-a", decision: "EXCLUDE_UNCERTAIN", expectedStatusVersion: 8,
  idempotencyKey: "decision-a", correlationId: "correlation-a",
});

test("decision service maps the public decision once and exposes only the derived planning result", async () => {
  const calls = [];
  const service = createAutoListingSourceImageDecisionService({ repository: {
    async recordSourceImageDecision(value) {
      calls.push(value);
      return {
        decision: { id: "decision-row", sourceAssetId: "asset-a", decision: "UNRESOLVED_EXCLUDE" },
        derivedRun: { id: "run-derived", status: "RECONCILING", expectedStatusVersion: 9 },
      };
    },
  } });
  assert.deepEqual(await service.recordDecision(input), {
    analysisRunId: "run-derived", status: "PLANNING", statusVersion: 9,
  });
  assert.deepEqual(calls, [{ ...input, decision: "UNRESOLVED_EXCLUDE" }]);
});

test("decision service rejects open input and unknown decisions before persistence", async () => {
  let calls = 0;
  const service = createAutoListingSourceImageDecisionService({ repository: {
    async recordSourceImageDecision() { calls += 1; },
  } });
  await assert.rejects(service.recordDecision({ ...input, extra: true }), { code: "AUTO_LISTING_SOURCE_IMAGE_DECISION_INVALID" });
  await assert.rejects(service.recordDecision({ ...input, decision: "DELETE" }), { code: "AUTO_LISTING_SOURCE_IMAGE_DECISION_INVALID" });
  assert.equal(calls, 0);
});
