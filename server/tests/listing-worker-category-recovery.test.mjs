import assert from "node:assert/strict";
import test from "node:test";

import {
  completeListingCategoryRetryAndContinue,
  createListingWorkerCategoryRecoveryController,
  resumeListingCategoryRecoveryFromChildResults,
  resolveListingSubmitFailureDispositionForWork,
} from "../listing-worker.mjs";
import { projectSubmissionWorkRowV3 } from "../listing-pipeline.mjs";

const explicitEvidence = (offerId = "offer-a") => Object.freeze({
  schemaVersion: "OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1",
  policyVersion: "ozon-category-policy.v2",
  errorCode: "CATEGORY_INVALID",
  field: "description_category_id",
  attributeId: null,
  state: "FAILED",
  offerId,
  productId: null,
  classification: "EXPLICIT_CATEGORY_FAILURE",
});

const work = (overrides = {}) => ({
  id: "job-a", account_id: "account-a", snapshot_id: "snapshot-a",
  ozon_task_id: "task-original", status_version: 7, correlation_id: "corr-a",
  items: [{ offer_id: "offer-a" }], categoryRecovery: null,
  ...overrides,
});

const failed = (overrides = {}) => ({
  done: true, status: "FAILED", success: 0, failed: 1, skipped: 0,
  items: [{ offerId: "offer-a", productId: "", status: "FAILED",
    classification: "EXPLICIT_CATEGORY_FAILURE", errorEvidence: explicitEvidence() }],
  ...overrides,
});

function harness({ persistFailure = null } = {}) {
  const calls = [];
  const controller = createListingWorkerCategoryRecoveryController({
    async beginCategoryRecovery(input) {
      calls.push(["begin", input]);
      return { evidenceId: "evidence-a", status: "FAILED" };
    },
    async recoverCategory(input) {
      calls.push(["recover", input]);
      calls.push(["schedule", {
        accountId: input.accountId, jobId: input.jobId, snapshotId: "snapshot-a",
        attemptId: "attempt-a", correlationId: input.correlationId,
      }]);
      return { attemptId: "attempt-a", status: "RETRY_PENDING" };
    },
    async persistRetryResults(input) {
      calls.push(["child-results", input]);
      if (persistFailure) throw persistFailure;
      return { attemptId: "attempt-a", status: "RECORDED", count: input.items.length };
    },
    async markRetryAccepted(input) {
      calls.push(["accepted", input]);
      return { attemptId: "attempt-a", status: "RETRY_ACCEPTED", retryOzonTaskId: input.retryOzonTaskId };
    },
    async completeRecovery(input) {
      calls.push(["complete", input]);
      return { attemptId: "attempt-a", status: "SUCCEEDED", retryOzonTaskId: input.retryOzonTaskId };
    },
    async requireRecoveryReview(input) {
      calls.push(["review", input]);
      return { attemptId: "attempt-a", status: "NEEDS_REVIEW" };
    },
    async reviewUncertainRetry(input) {
      calls.push(["uncertain-review", input]);
      return { attemptId: "attempt-a", status: "NEEDS_REVIEW" };
    },
  });
  return { calls, controller };
}

test("first complete explicit category failure alone schedules the sole same-job retry", async () => {
  const { calls, controller } = harness();
  assert.deepEqual(await controller.handleTerminal({ work: work(), statusInfo: failed() }), {
    handled: true, attemptId: "attempt-a", status: "RETRY_PENDING",
  });
  assert.deepEqual(calls.map(([name]) => name), ["begin", "recover", "schedule"]);
  assert.deepEqual(calls[0][1], {
    accountId: "account-a", jobId: "job-a", snapshotId: "snapshot-a",
    originalOzonTaskId: "task-original", statusVersion: 7,
    correlationId: "corr-a", items: failed().items,
  });
  assert.equal(calls[2][1].jobId, "job-a");
  assert.equal(calls[2][1].attemptId, "attempt-a");
});

test("retry acceptance preserves original task identity and success completes before stock continuation", async () => {
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_PENDING", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", correlationId: "corr-a",
  };
  const { calls, controller } = harness();
  assert.deepEqual(await controller.acceptRetry({ work: work({ categoryRecovery: recovery }),
    retryOzonTaskId: "task-retry" }), {
    attemptId: "attempt-a", status: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry",
  });
  assert.equal(calls[0][1].originalOzonTaskId, "task-original");
  assert.equal(calls[0][1].retryOzonTaskId, "task-retry");
  const retryWork = work({ ozon_task_id: "task-retry", stocks: [{ offer_id: "offer-a" }],
    categoryRecovery: { ...recovery, status: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry" } });
  const continuation = [];
  await completeListingCategoryRetryAndContinue({
    work: retryWork,
    statusInfo: { done: true, status: "SUCCEEDED", success: 1, failed: 0, skipped: 0,
      items: [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }] },
    controller,
    continueImport: async (continuedWork, continuedStatus) => {
      continuation.push("PRE_STOCK", "RFBS", "STOCK");
      assert.equal(continuedWork, retryWork);
      assert.equal(continuedStatus.status, "SUCCEEDED");
    },
  });
  assert.deepEqual(calls.map(([name]) => name), ["accepted", "child-results", "complete"]);
  assert.deepEqual(calls[1][1].items, [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }]);
  assert.equal(calls[2][1].retryOzonTaskId, "task-retry");
  assert.deepEqual(continuation, ["PRE_STOCK", "RFBS", "STOCK"]);
});

test("a second category failure is reviewed and never schedules a third import", async () => {
  const { calls, controller } = harness();
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_ACCEPTED", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", retryOzonTaskId: "task-retry", correlationId: "corr-a",
  };
  assert.deepEqual(await controller.handleTerminal({
    work: work({ ozon_task_id: "task-retry", categoryRecovery: recovery }), statusInfo: failed(),
  }), { handled: true, attemptId: "attempt-a", status: "NEEDS_REVIEW" });
  assert.deepEqual(calls.map(([name]) => name), ["child-results", "review"]);
  assert.deepEqual(calls[0][1].items, [{ offerId: "offer-a", status: "FAILED", productId: null }]);
});

test("a conflicting retry child result stops before review or another import", async () => {
  const conflict = Object.assign(new Error("conflict"), {
    code: "LISTING_CATEGORY_RECOVERY_RESULT_CONFLICT",
  });
  const { calls, controller } = harness({ persistFailure: conflict });
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_ACCEPTED", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", retryOzonTaskId: "task-retry", correlationId: "corr-a",
  };
  await assert.rejects(controller.handleTerminal({
    work: work({ ozon_task_id: "task-retry", categoryRecovery: recovery }), statusInfo: failed(),
  }), { code: "LISTING_CATEGORY_RECOVERY_RESULT_CONFLICT" });
  assert.deepEqual(calls.map(([name]) => name), ["child-results"]);
});

test("persisted retry child results resume success or review without another Ozon import", async () => {
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_ACCEPTED", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", retryOzonTaskId: "task-retry", correlationId: "corr-a",
  };
  for (const [attemptStatus, child, expectedCalls, expectedStatus] of [
    ["RETRY_ACCEPTED", { offerId: "offer-a", status: "SUCCEEDED", productId: "101" },
      ["complete", "continue"], "SUCCEEDED"],
    ["SUCCEEDED", { offerId: "offer-a", status: "SUCCEEDED", productId: "101" },
      ["continue"], "SUCCEEDED"],
    ["RETRY_ACCEPTED", { offerId: "offer-a", status: "FAILED", productId: null },
      ["review", "continue"], "FAILED"],
    ["NEEDS_REVIEW", { offerId: "offer-a", status: "FAILED", productId: null },
      ["continue"], "FAILED"],
  ]) {
    const { calls, controller } = harness();
    const continued = [];
    assert.deepEqual(await resumeListingCategoryRecoveryFromChildResults({
      work: work({ status: "CHECKING", ozon_task_id: "task-retry",
        categoryRecovery: { ...recovery, status: attemptStatus },
        categoryRecoveryResults: [child] }),
      controller,
      continueImport: async (_work, statusInfo) => continued.push(["continue", statusInfo]),
    }), { handled: true, status: expectedStatus });
    assert.deepEqual([...calls.map(([name]) => name), ...continued.map(([name]) => name)], expectedCalls);
    assert.equal(continued[0][1].done, true);
    assert.equal(continued[0][1].items[0].offerId, "offer-a");
  }
});

test("an incomplete persisted retry child set cannot complete, review, or continue", async () => {
  const { calls, controller } = harness();
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_ACCEPTED", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", retryOzonTaskId: "task-retry", correlationId: "corr-a",
  };
  let continuations = 0;
  await assert.rejects(resumeListingCategoryRecoveryFromChildResults({
    work: work({ status: "CHECKING", ozon_task_id: "task-retry", categoryRecovery: recovery,
      items: [{ offer_id: "offer-a" }, { offer_id: "offer-b" }],
      categoryRecoveryResults: [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }] }),
    controller, continueImport: async () => { continuations += 1; },
  }), { code: "LISTING_CATEGORY_RECOVERY_RESULT_INVALID" });
  assert.deepEqual(calls, []);
  assert.equal(continuations, 0);
});

test("response loss after the original or category retry import always reconciles without another retry", () => {
  assert.equal(resolveListingSubmitFailureDispositionForWork(work(), {
    body: { network: true }, code: "OZON_RESPONSE_LOST",
  }), "RECONCILING");
  assert.equal(resolveListingSubmitFailureDispositionForWork(work({ categoryRecovery: {
    status: "RETRY_PENDING",
  } }), { code: "SUBMISSION_NOT_SENT" }), "FAILED");
});

test("every retry submit failure closes the exact pending attempt atomically without generic reconciliation", async () => {
  const { calls, controller } = harness();
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_PENDING", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", retryOzonTaskId: null, correlationId: "corr-a",
  };
  for (const [error, safeReviewCode] of [
    [{ code: "OZON_RESPONSE_LOST", body: { network: true } },
      "AUTO_LISTING_CATEGORY_RETRY_TASK_UNKNOWN"],
    [{ code: "SUBMISSION_NOT_SENT" }, "AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED"],
    [{ code: "LISTING_RFBS_PHASE_VALIDATION_REQUIRED" },
      "AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED"],
    [{ code: "LISTING_CATEGORY_RECOVERY_TRANSITION_CONFLICT" },
      "AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED"],
  ]) {
    assert.deepEqual(await controller.handleSubmitFailure({
      work: work({ status: "SUBMITTING", categoryRecovery: recovery }), error,
    }), { handled: true, attemptId: "attempt-a", status: "NEEDS_REVIEW" });
    assert.equal(calls.at(-1)[1].safeReviewCode, safeReviewCode);
    assert.equal(calls.at(-1)[1].originalOzonTaskId, "task-original");
    assert.equal(calls.at(-1)[1].retryOzonTaskId, undefined);
  }
  assert.deepEqual(calls.map(([name]) => name), Array(4).fill("uncertain-review"));
});

test("a retry task persisted before scheduling failure resumes only that exact retry task", async () => {
  const { calls, controller } = harness();
  const recovery = {
    attemptId: "attempt-a", status: "RETRY_PENDING", evidenceId: "evidence-a",
    sourceEvidenceId: "source-a", oldSharedCategoryId: "shared-a", oldSharedCategoryVersion: 1,
    replacementSharedCategoryId: "shared-a", replacementSharedCategoryVersion: 3,
    originalOzonTaskId: "task-original", retryOzonTaskId: null, correlationId: "corr-a",
  };
  const latest = work({ status: "OZON_ACCEPTED", ozon_task_id: "task-retry",
    categoryRecovery: { ...recovery, status: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry" } });
  for (let replay = 0; replay < 2; replay += 1) {
    assert.deepEqual(await controller.handleSubmitFailure({
      work: work({ status: "SUBMITTING", categoryRecovery: recovery }), latestWork: latest,
      error: { code: "STATUS_CHECK_SCHEDULE_FAILED" },
    }), { handled: true, status: "RETRY_ACCEPTED", retryOzonTaskId: "task-retry" });
  }
  assert.deepEqual(calls, []);
});

test("uncertain, present, partial, product, processing and noncategory results never enter recovery", async () => {
  const variants = [
    failed({ done: false, status: "CHECKING" }),
    failed({ success: 1, failed: 1 }),
    failed({ items: [{ ...failed().items[0], productId: "101" }] }),
    failed({ items: [{ ...failed().items[0], classification: "OTHER_TERMINAL_FAILURE", errorEvidence: null }] }),
    failed({ status: "UNKNOWN_RESULT" }),
    failed({ skipped: 1 }),
  ];
  for (const statusInfo of variants) {
    const { calls, controller } = harness();
    assert.deepEqual(await controller.handleTerminal({ work: work(), statusInfo }), { handled: false });
    assert.deepEqual(calls, []);
  }
});

test("submission work uses immutable corrected items only for its exact pending recovery", () => {
  const original = [{ offer_id: "offer-a", description_category_id: 10 }];
  const corrected = [{ offer_id: "offer-a", description_category_id: 30 }];
  const basis = {
    id: "job-a", account_id: "account-a", snapshot_id: "snapshot-a", items: original,
    recovery_attempt_id: "attempt-a", recovery_account_id: "account-a",
    recovery_job_id: "job-a", recovery_snapshot_id: "snapshot-a", recovery_status: "RETRY_PENDING",
    recovery_corrected_items: corrected, recovery_evidence_id: "evidence-a",
    recovery_source_evidence_id: "source-a", recovery_old_shared_category_id: "shared-a",
    recovery_old_shared_category_version: 1, recovery_replacement_shared_category_id: "shared-a",
    recovery_replacement_shared_category_version: 3, recovery_original_ozon_task_id: "task-original",
    recovery_retry_ozon_task_id: null, recovery_correlation_id: "corr-a",
    recovery_item_results: [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }],
  };
  const projected = projectSubmissionWorkRowV3(basis);
  assert.deepEqual(projected.items, original);
  assert.deepEqual(projected.effectiveItems, corrected);
  assert.equal(projected.categoryRecovery.attemptId, "attempt-a");
  assert.deepEqual(projected.categoryRecoveryResults,
    [{ offerId: "offer-a", status: "SUCCEEDED", productId: "101" }]);
  for (const mutation of [
    { recovery_status: "CLAIMED" }, { recovery_account_id: "account-b" },
    { recovery_job_id: "job-b" }, { recovery_snapshot_id: "snapshot-b" },
  ]) {
    const value = projectSubmissionWorkRowV3({ ...basis, ...mutation });
    assert.deepEqual(value.effectiveItems, original);
    assert.equal(value.categoryRecovery, null);
  }
});
