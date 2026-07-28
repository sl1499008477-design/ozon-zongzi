import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubmissionFailureDisposition } from "../listing-submission-policy.mjs";

test("submission uncertainty is reconciled instead of retried", () => {
  assert.equal(resolveSubmissionFailureDisposition({ status: 503 }), "RECONCILING");
  assert.equal(resolveSubmissionFailureDisposition({ body: { network: true } }), "RECONCILING");
});

test("submission retries only an explicitly safe pre-submit failure", () => {
  assert.equal(resolveSubmissionFailureDisposition({ code: "SUBMISSION_NOT_SENT" }), "RETRY_PENDING");
});
