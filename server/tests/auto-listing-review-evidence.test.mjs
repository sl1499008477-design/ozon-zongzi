import assert from "node:assert/strict";
import test from "node:test";

import { isSourceImageConfirmationReviewEvidence } from "../auto-listing-review-evidence.mjs";

test("only the exact current source-image confirmation block is pre-plan reviewable", () => {
  const base = {
    item: {
      status: "BLOCKED",
      failureCode: "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED",
      currentSourceImageAnalysisRunId: "run-a",
    },
    sourceImageAnalysis: { analysisRunId: "run-a", status: "CONFIRMATION_REQUIRED" },
  };
  assert.equal(isSourceImageConfirmationReviewEvidence(base), true);
  for (const evidence of [
    { ...base, item: { ...base.item, status: "PLANNING" } },
    { ...base, item: { ...base.item, failureCode: "AUTO_LISTING_SOURCE_IMAGE_EVIDENCE_INSUFFICIENT" } },
    { ...base, item: { ...base.item, currentSourceImageAnalysisRunId: "run-b" } },
    { ...base, sourceImageAnalysis: { ...base.sourceImageAnalysis, status: "ACCEPTED" } },
  ]) assert.equal(isSourceImageConfirmationReviewEvidence(evidence), false);
});
