import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSubmissionReconciler } from "../auto-listing-submission-reconciler.mjs";

const request = Object.freeze({
  accountId: "account-a",
  itemId: "item-a",
  submissionLinkId: "link-a",
  correlationId: "reconcile-a",
});

function harness(submission = {}, context = {}) {
  const calls = [];
  const state = {
    context: {
      accountId: "account-a",
      jobId: "job-a",
      itemId: "item-a",
      itemStatus: "UPLOADING",
      itemStatusVersion: 8,
      submissionLinkId: "link-a",
      submissionLinkStatus: "SUBMITTED",
      submissionJobId: "submission-a",
      submission: {
        id: "submission-a",
        accountId: "account-a",
        status: "CHECKING",
        ozonTaskId: "ozon-task-a",
        errorCode: null,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        resultSummary: {},
        items: [],
        ...submission,
      },
      ...context,
    },
  };
  const repository = {
    async loadReconciliationEvidence(input) {
      calls.push(["load", input]);
      return structuredClone(state.context);
    },
    async applyReconciliation(input) {
      calls.push(["apply", input]);
      state.context.itemStatus = input.itemStatus;
      state.context.itemStatusVersion += input.advanceItemVersion ? 1 : 0;
      state.context.submissionLinkStatus = input.linkStatus;
      return {
        itemId: input.itemId,
        status: state.context.itemStatus,
        statusVersion: state.context.itemStatusVersion,
        linkStatus: state.context.submissionLinkStatus,
        duplicate: false,
      };
    },
  };
  return { calls, state, reconciler: createAutoListingSubmissionReconciler({ repository }) };
}

test("closed reconciliation request is account scoped and rejects extra fields", async () => {
  const { reconciler, calls } = harness();
  await assert.rejects(reconciler.reconcile({ ...request, extra: true }), {
    code: "AUTO_LISTING_RECONCILE_INVALID",
  });
  assert.deepEqual(calls, []);
});

test("all nonterminal standard listing states remain UPLOADING without inventing a result", async () => {
  for (const status of ["QUEUE_PENDING", "QUEUED", "VALIDATING", "SUBMITTING", "OZON_ACCEPTED", "CHECKING", "RETRY_PENDING", "CANCEL_REQUESTED"]) {
    const { reconciler, calls } = harness({ status });
    const result = await reconciler.reconcile(request);
    assert.equal(result.status, "UPLOADING");
    const applied = calls.find(([kind]) => kind === "apply")[1];
    assert.equal(applied.itemStatus, "UPLOADING");
    assert.equal(applied.linkStatus, "SUBMITTED");
    assert.equal(applied.advanceItemVersion, false);
    assert.equal(applied.enqueueNextCheck, true);
  }
});

test("SUCCEEDED is terminal, auditable and carries bounded variant and stock evidence", async () => {
  const { reconciler, calls } = harness({
    status: "SUCCEEDED",
    successCount: 2,
    failedCount: 0,
    skippedCount: 0,
    resultSummary: { success: 2, failed: 0, skipped: 0, stockCount: 2 },
    items: [
      { offerId: "offer-a", status: "SUCCESS", productId: "101" },
      { offerId: "offer-b", status: "SUCCESS", productId: "102" },
    ],
  });
  const result = await reconciler.reconcile(request);
  assert.equal(result.status, "SUCCEEDED");
  const applied = calls.find(([kind]) => kind === "apply")[1];
  assert.equal(applied.itemStatus, "SUCCEEDED");
  assert.equal(applied.linkStatus, "SUCCEEDED");
  assert.equal(applied.advanceItemVersion, true);
  assert.equal(applied.enqueueNextCheck, false);
  assert.deepEqual(applied.summary.counts, { success: 2, failed: 0, skipped: 0, stockCount: 2 });
  assert.equal(applied.summary.variants.length, 2);
  assert.equal(JSON.stringify(applied).includes("apiKey"), false);
});

test("a successful Ozon import with erased rich content is blocked for review", async () => {
  const { reconciler, calls } = harness({
    status: "SUCCEEDED",
    successCount: 1,
    failedCount: 0,
    skippedCount: 0,
    resultSummary: { success: 1, failed: 0, skipped: 0, stockCount: 1 },
    items: [{
      offerId: "offer-a",
      status: "SUCCESS",
      productId: "101",
      errorCode: "ZONGZI_RICH_CONTENT_REJECTED",
    }],
  });

  const result = await reconciler.reconcile(request);

  assert.equal(result.status, "BLOCKED");
  const applied = calls.find(([kind]) => kind === "apply")[1];
  assert.equal(applied.linkStatus, "BLOCKED");
  assert.equal(applied.failureCode, "ZONGZI_RICH_CONTENT_REJECTED_REQUIRES_REVIEW");
  assert.equal(applied.allowResubmission, false);
  assert.equal(applied.enqueueNextCheck, false);
  assert.equal(applied.summary.variants[0].errorCode, "ZONGZI_RICH_CONTENT_REJECTED");
});

test("reconciliation carries only safe category recovery identity on the original link", async () => {
  const { reconciler, calls } = harness({
    status: "SUCCEEDED", ozonTaskId: "task-retry",
    categoryRecovery: {
      attemptId: "attempt-a", status: "SUCCEEDED", originalOzonTaskId: "task-original",
      retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 1,
      replacementSharedCategoryVersion: 3,
    },
  });
  await reconciler.reconcile(request);
  const applied = calls.find(([kind]) => kind === "apply")[1];
  assert.equal(applied.submissionLinkId, "link-a");
  assert.equal(applied.submissionJobId, "submission-a");
  assert.deepEqual(applied.summary.categoryRecovery, {
    attemptId: "attempt-a", status: "SUCCEEDED", originalOzonTaskId: "task-original",
    retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 1,
    replacementSharedCategoryVersion: 3,
  });
  assert.doesNotMatch(JSON.stringify(applied), /corrected_items|rawResponse|apiKey/iu);
});

test("recovery audit accepts only the exact nullable six-field shape for every attempt state", async () => {
  const cases = [
    ["CLAIMED", "FAILED", null, null],
    ["MATCHED", "FAILED", null, 3],
    ["RETRY_PENDING", "RETRY_PENDING", null, 3],
    ["RETRY_ACCEPTED", "CHECKING", "task-retry", 3],
    ["SUCCEEDED", "SUCCEEDED", "task-retry", 3],
    ["NEEDS_REVIEW", "FAILED", null, null],
    ["NEEDS_REVIEW", "FAILED", null, 3],
    ["NEEDS_REVIEW", "FAILED", "task-retry", 3],
  ];
  for (const [status, submissionStatus, retryOzonTaskId, replacementSharedCategoryVersion] of cases) {
    const ozonTaskId = retryOzonTaskId || "task-original";
    const { reconciler, calls } = harness({
      status: submissionStatus, ozonTaskId,
      categoryRecovery: {
        attemptId: "attempt-a", status, originalOzonTaskId: "task-original",
        retryOzonTaskId, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion,
      },
    });
    await reconciler.reconcile(request);
    assert.deepEqual(calls.find(([kind]) => kind === "apply")[1].summary.categoryRecovery, {
      attemptId: "attempt-a", status, originalOzonTaskId: "task-original",
      retryOzonTaskId, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion,
    });
  }

  for (const categoryRecovery of [
    { attemptId: "attempt-a", status: "CLAIMED", originalOzonTaskId: "task-original",
      retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: null },
    { attemptId: "attempt-a", status: "MATCHED", originalOzonTaskId: "task-original",
      retryOzonTaskId: null, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: null },
    { attemptId: "attempt-a", status: "RETRY_ACCEPTED", originalOzonTaskId: "task-original",
      retryOzonTaskId: null, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: 3 },
    { attemptId: "attempt-a", status: "NEEDS_REVIEW", originalOzonTaskId: "task-original",
      retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: null },
  ]) {
    const { reconciler, calls } = harness({ status: "FAILED", ozonTaskId: "task-original", categoryRecovery });
    await assert.rejects(reconciler.reconcile(request), {
      code: "AUTO_LISTING_RECONCILE_EVIDENCE_INVALID",
    });
    assert.equal(calls.some(([kind]) => kind === "apply"), false);
  }

  const acceptedBeforeItsAtomicJobTransition = harness({
    status: "SUBMITTING", ozonTaskId: "task-retry",
    categoryRecovery: {
      attemptId: "attempt-a", status: "RETRY_ACCEPTED", originalOzonTaskId: "task-original",
      retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 1,
      replacementSharedCategoryVersion: 3,
    },
  });
  await assert.rejects(acceptedBeforeItsAtomicJobTransition.reconciler.reconcile(request), {
    code: "AUTO_LISTING_RECONCILE_EVIDENCE_INVALID",
  });
  assert.equal(acceptedBeforeItsAtomicJobTransition.calls.some(([kind]) => kind === "apply"), false);
});

test("reconciliation rejects hostile or inconsistent recovery audit DTOs without executing them", async () => {
  let reads = 0;
  const getter = Object.create(null);
  for (const [key, value] of Object.entries({
    attemptId: "attempt-a", status: "SUCCEEDED", originalOzonTaskId: "task-original",
    retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 1,
    replacementSharedCategoryVersion: 3,
  })) {
    Object.defineProperty(getter, key, key === "attemptId" ? {
      enumerable: true, get() { reads += 1; throw new Error("must not execute"); },
    } : { enumerable: true, value });
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const categoryRecovery of [getter, new Proxy({}, {
    get() { reads += 1; throw new Error("must not execute"); },
  }), revoked.proxy, {
    attemptId: "attempt-a", status: "MATCHED", originalOzonTaskId: "task-original",
    retryOzonTaskId: "task-retry", oldSharedCategoryVersion: 3,
    replacementSharedCategoryVersion: 3,
  }, {
    attemptId: "attempt-a", status: "SUCCEEDED", originalOzonTaskId: "task-original",
    retryOzonTaskId: "another-task", oldSharedCategoryVersion: 1,
    replacementSharedCategoryVersion: 3,
  }]) {
    const calls = [];
    const reconciler = createAutoListingSubmissionReconciler({ repository: {
      async loadReconciliationEvidence() {
        return {
          accountId: "account-a", jobId: "job-a", itemId: "item-a", itemStatus: "UPLOADING",
          itemStatusVersion: 8, submissionLinkId: "link-a", submissionLinkStatus: "SUBMITTED",
          submissionJobId: "submission-a", submission: {
            id: "submission-a", accountId: "account-a", status: "SUCCEEDED",
            ozonTaskId: "task-retry", successCount: 1, failedCount: 0, skippedCount: 0,
            resultSummary: {}, items: [], categoryRecovery,
          },
        };
      },
      async applyReconciliation(input) { calls.push(input); return input; },
    } });
    await assert.rejects(reconciler.reconcile(request), {
      code: "AUTO_LISTING_RECONCILE_EVIDENCE_INVALID",
    });
    assert.deepEqual(calls, []);
  }
  assert.equal(reads, 0);
});

test("partial success and uncertain reconciliation block resubmission instead of creating another product", async () => {
  for (const [status, failureCode] of [
    ["PARTIAL_SUCCESS", "ZONGZI_PARTIAL_SUCCESS_REQUIRES_REVIEW"],
    ["RECONCILING", "ZONGZI_RECONCILIATION_REQUIRED"],
  ]) {
    const { reconciler, calls } = harness({ status, successCount: 1, failedCount: 1 });
    const result = await reconciler.reconcile(request);
    assert.equal(result.status, "BLOCKED");
    const applied = calls.find(([kind]) => kind === "apply")[1];
    assert.equal(applied.linkStatus, status === "RECONCILING" ? "RECONCILING" : "BLOCKED");
    assert.equal(applied.failureCode, failureCode);
    assert.equal(applied.enqueueNextCheck, status === "RECONCILING");
    assert.equal(applied.allowResubmission, false);
  }
});

test("a reconciliation link stays blocked while the standard submission resumes nonterminal checking", async () => {
  for (const status of ["CHECKING", "RETRY_PENDING"]) {
    const { reconciler, calls } = harness({ status }, {
      itemStatus: "BLOCKED",
      itemStatusVersion: 9,
      failureCode: "ZONGZI_RECONCILIATION_REQUIRED",
      submissionLinkStatus: "RECONCILING",
    });
    const result = await reconciler.reconcile(request);
    assert.equal(result.status, "BLOCKED");
    const applied = calls.find(([kind]) => kind === "apply")[1];
    assert.equal(applied.expectedLinkStatus, "RECONCILING");
    assert.equal(applied.linkStatus, "RECONCILING");
    assert.equal(applied.itemStatus, "BLOCKED");
    assert.equal(applied.failureCode, "ZONGZI_RECONCILIATION_REQUIRED");
    assert.equal(applied.advanceItemVersion, false);
    assert.equal(applied.enqueueNextCheck, true);
  }
});

test("a terminal failure replaces the temporary reconciliation failure code and advances item CAS", async () => {
  const { reconciler, calls } = harness({ status: "PARTIAL_SUCCESS", successCount: 1, failedCount: 1 }, {
    itemStatus: "BLOCKED",
    itemStatusVersion: 9,
    failureCode: "ZONGZI_RECONCILIATION_REQUIRED",
    submissionLinkStatus: "RECONCILING",
  });
  assert.equal((await reconciler.reconcile(request)).status, "BLOCKED");
  const applied = calls.find(([kind]) => kind === "apply")[1];
  assert.equal(applied.failureCode, "ZONGZI_PARTIAL_SUCCESS_REQUIRES_REVIEW");
  assert.equal(applied.advanceItemVersion, true);
});

test("a bound FAILED submission is blocked even when never-sent is proven because same-job requeue is not implemented", async () => {
  const safe = harness({ status: "FAILED", errorCode: "SUBMISSION_NOT_SENT", ozonTaskId: null });
  assert.equal((await safe.reconciler.reconcile(request)).status, "BLOCKED");
  const safeApplied = safe.calls.find(([kind]) => kind === "apply")[1];
  assert.equal(safeApplied.linkStatus, "BLOCKED");
  assert.equal(safeApplied.failureCode, "ZONGZI_SUBMISSION_NOT_SENT_REQUIRES_ADMIN_RECOVERY");
  assert.equal(safeApplied.allowResubmission, false);

  for (const submission of [
    { status: "FAILED", errorCode: "ZONGZI_ITEM_RESULT", ozonTaskId: "123" },
    { status: "FAILED", errorCode: "ECONNRESET", ozonTaskId: null },
  ]) {
    const blocked = harness(submission);
    assert.equal((await blocked.reconciler.reconcile(request)).status, "BLOCKED");
    assert.equal(blocked.calls.find(([kind]) => kind === "apply")[1].allowResubmission, false);
  }
});

test("cancelled before Ozon acceptance is CANCELLED; accepted cancellation remains blocked", async () => {
  const neverSent = harness({ status: "CANCELLED", ozonTaskId: null });
  assert.equal((await neverSent.reconciler.reconcile(request)).status, "CANCELLED");

  const uncertain = harness({ status: "CANCELLED", ozonTaskId: "task-1" });
  assert.equal((await uncertain.reconciler.reconcile(request)).status, "BLOCKED");
  assert.equal(uncertain.calls.find(([kind]) => kind === "apply")[1].failureCode, "ZONGZI_RECONCILIATION_REQUIRED");
});

test("terminal replay is idempotent and a later confirmed result may resolve a reconciliation block", async () => {
  const replay = harness({ status: "SUCCEEDED" }, {
    itemStatus: "SUCCEEDED", itemStatusVersion: 9, submissionLinkStatus: "SUCCEEDED",
  });
  assert.deepEqual(await replay.reconciler.reconcile(request), {
    itemId: "item-a", status: "SUCCEEDED", statusVersion: 9, linkStatus: "SUCCEEDED", duplicate: true,
  });
  assert.equal(replay.calls.some(([kind]) => kind === "apply"), false);

  const resolved = harness({ status: "SUCCEEDED" }, {
    itemStatus: "BLOCKED", itemStatusVersion: 9, submissionLinkStatus: "RECONCILING",
    failureCode: "ZONGZI_RECONCILIATION_REQUIRED",
  });
  assert.equal((await resolved.reconciler.reconcile(request)).status, "SUCCEEDED");
  assert.equal(resolved.calls.find(([kind]) => kind === "apply")[1].resolveReconciliationBlock, true);
});
