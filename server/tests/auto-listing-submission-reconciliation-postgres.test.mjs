import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingSubmissionReconciliationRepository } from "../auto-listing-submission-reconciliation-postgres.mjs";

function harness({ enqueueDuplicate = false, parentStatus = "UPLOADING", recoveryRow = {}, submissionItemRow = {}, aggregateRow = {
  total_count: 1, terminal_count: 1, succeeded_count: 1, blocked_count: 0, cancelled_count: 0,
} } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^(BEGIN|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/set_config\('statement_timeout'/u.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/WITH exhausted_candidate AS/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id,status FROM auto_listing_jobs/u.test(sql)) return {
        rows: [{ id: "job-a", status: parentStatus }], rowCount: 1,
      };
      if (/FROM auto_listing_submission_links AS link[\s\S]*JOIN submission_jobs AS submission/u.test(sql)) return { rows: [{
        account_id: "account-a", job_id: "job-a", item_id: "item-a", item_status: "UPLOADING",
        item_status_version: 8, failure_code: null, submission_link_id: "link-a",
        submission_link_status: "SUBMITTED", submission_job_id: "submission-a",
        submission_status: "CHECKING", ozon_task_id: "ozon-a", submission_error_code: "",
        success_count: 0, failed_count: 0, skipped_count: 0, result_summary: {},
        ...recoveryRow,
      }], rowCount: 1 };
      if (/FROM submission_items AS item/u.test(sql)) return { rows: [
        { offer_id: "offer-a", status: "SUCCESS", product_id: "product-a", error_code: "", response: {}, ...submissionItemRow },
      ], rowCount: 1 };
      if (/FOR UPDATE OF item,link/u.test(sql)) return { rows: [{
        item_status: "UPLOADING", item_status_version: 8, link_status: "SUBMITTED",
        submission_job_id: "submission-a",
      }], rowCount: 1 };
      if (/UPDATE auto_listing_job_items/u.test(sql)) return { rows: [{ status: "SUCCEEDED", status_version: 9 }], rowCount: 1 };
      if (/UPDATE auto_listing_submission_links/u.test(sql)) return { rows: [{ status: "SUCCEEDED" }], rowCount: 1 };
      if (/COUNT\(\*\).*FILTER[\s\S]*FROM auto_listing_job_items/u.test(sql)) return {
        rows: [aggregateRow], rowCount: 1,
      };
      if (/UPDATE auto_listing_jobs/u.test(sql)) return { rows: [{ status: "SUCCEEDED" }], rowCount: 1 };
      if (/INSERT INTO auto_listing_events/u.test(sql)) return { rows: [{ id: "event-a" }], rowCount: 1 };
      if (/WITH candidate AS/u.test(sql)) return { rows: [{
        task_id: "task-a", account_id: "account-a", job_id: "job-a", item_id: "item-a",
        submission_link_id: "link-a", submission_job_id: "submission-a", lease_token: "lease-a", attempt_count: 2,
      }], rowCount: 1 };
      if (/INSERT INTO auto_listing_submission_reconcile_events/u.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      if (/UPDATE auto_listing_submission_reconcile_tasks/u.test(sql)) return { rows: [{ id: "task-a" }], rowCount: 1 };
      if (/INSERT INTO auto_listing_submission_reconcile_tasks/u.test(sql)) return enqueueDuplicate
        ? { rows: [], rowCount: 0 } : { rows: [{ id: "task-a", state: "PENDING" }], rowCount: 1 };
      if (/SELECT id,job_id,auto_listing_item_id,submission_job_id[\s\S]*FROM auto_listing_submission_reconcile_tasks/u.test(sql)) return {
        rows: [{ id: "existing-task-a", job_id: "job-a", auto_listing_item_id: "item-a", submission_job_id: "submission-a" }], rowCount: 1,
      };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  return {
    calls,
    repository: createPostgresAutoListingSubmissionReconciliationRepository({
      pool: { async connect() { return client; }, async query(sql, values) { return client.query(sql, values); } },
      idFactory(kind) { return kind === "lease" ? "lease-a" : `${kind}-a`; },
    }),
  };
}

test("evidence loading joins every identifier through the account boundary and bounds submission items", async () => {
  const { repository, calls } = harness();
  const result = await repository.loadReconciliationEvidence({
    accountId: "account-a", itemId: "item-a", submissionLinkId: "link-a", correlationId: "correlation-a",
  });
  assert.equal(result.submission.status, "CHECKING");
  assert.equal(result.submission.items.length, 1);
  const scope = calls.find(({ sql }) => /FROM auto_listing_submission_links AS link/u.test(sql));
  assert.match(scope.sql, /link\.account_id=\$1[\s\S]*link\.auto_listing_item_id=\$2[\s\S]*link\.id=\$3/iu);
  assert.match(scope.sql, /submission\.account_id=link\.account_id/iu);
  assert.match(calls.find(({ sql }) => /FROM submission_items AS item/u.test(sql)).sql, /LIMIT 101/iu);
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.deepEqual(calls.slice(-2).map(({ sql }) => sql), ["COMMIT", "RELEASE"]);
});

test("evidence loading projects Ozon attribute 11254 erasure to a safe failure code", async () => {
  const { repository, calls } = harness({ submissionItemRow: {
    response: {
      schemaVersion: "OZON_SUBMISSION_ITEM_RESPONSE_V1",
      errorEvidence: null,
      rawResponse: {
        status: "imported",
        errors: [{ code: "erased_attribute_value", attribute_id: 11254, message: "raw Ozon detail" }],
      },
    },
  } });

  const result = await repository.loadReconciliationEvidence({
    accountId: "account-a", itemId: "item-a", submissionLinkId: "link-a", correlationId: "correlation-a",
  });

  assert.equal(result.submission.items[0].errorCode, "OZON_RICH_CONTENT_REJECTED");
  assert.equal(JSON.stringify(result).includes("raw Ozon detail"), false);
  assert.match(calls.find(({ sql }) => /FROM submission_items AS item/u.test(sql)).sql, /item\.response/iu);
});

test("evidence loading preserves nullable recovery fields for pre-match and pre-accept states", async () => {
  const { repository } = harness({ recoveryRow: {
    recovery_attempt_id: "attempt-a", recovery_status: "CLAIMED",
    recovery_original_ozon_task_id: "ozon-a", recovery_retry_ozon_task_id: null,
    recovery_old_shared_category_version: 1, recovery_replacement_shared_category_version: null,
  } });
  const result = await repository.loadReconciliationEvidence({
    accountId: "account-a", itemId: "item-a", submissionLinkId: "link-a", correlationId: "correlation-a",
  });
  assert.deepEqual(result.submission.categoryRecovery, {
    attemptId: "attempt-a", status: "CLAIMED", originalOzonTaskId: "ozon-a",
    retryOzonTaskId: null, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: null,
  });
});

test("enqueue replay returns the durable existing task identity and does not append a second CREATED event", async () => {
  const { repository, calls } = harness({ enqueueDuplicate: true });
  assert.deepEqual(await repository.enqueue({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "enqueue-a",
  }), { taskId: "existing-task-a", duplicate: true });
  assert.equal(calls.filter(({ sql }) => /'CREATED'/u.test(sql)).length, 0);
});

test("applying a result locks the exact tenant-bound item and link, uses CAS, audits, then commits", async () => {
  const { repository, calls } = harness();
  const result = await repository.applyReconciliation({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "correlation-a",
    expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
    itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
    summary: { submissionJobId: "submission-a", ozonTaskId: "ozon-a", counts: { success: 1, failed: 0, skipped: 0, stockCount: 1 }, variants: [] },
    advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
    resolveReconciliationBlock: false,
  });
  assert.deepEqual(result, {
    itemId: "item-a", status: "SUCCEEDED", statusVersion: 9,
    linkStatus: "SUCCEEDED", duplicate: false,
  });
  const lock = calls.find(({ sql }) => /FOR UPDATE OF item,link/u.test(sql));
  assert.match(lock.sql, /item\.account_id=\$1[\s\S]*item\.job_id=\$2[\s\S]*item\.id=\$3[\s\S]*link\.id=\$4/iu);
  assert.match(calls.find(({ sql }) => /UPDATE auto_listing_job_items/u.test(sql)).sql, /status_version=\$[0-9]+/iu);
  assert.match(calls.find(({ sql }) => /INSERT INTO auto_listing_events/u.test(sql)).sql, /transition_version/iu);
  assert.match(calls.find(({ sql }) => /SELECT id,status FROM auto_listing_jobs/u.test(sql)).sql,
    /account_id=\$1[\s\S]*id=\$2[\s\S]*FOR UPDATE/iu);
  assert.match(calls.find(({ sql }) => /UPDATE auto_listing_jobs/u.test(sql)).sql,
    /account_id=\$1[\s\S]*id=\$2[\s\S]*status=\$[0-9]+/iu);
  assert.equal(calls.some(({ sql, values }) => /AUTO_LISTING_JOB_AGGREGATED/u.test(sql)
    && values.includes("SUCCEEDED")), true);
  assert.deepEqual(calls.slice(-2).map(({ sql }) => sql), ["COMMIT", "RELEASE"]);
});

test("leasing uses skip-locked and may recover an expired lease atomically", async () => {
  const { repository, calls } = harness();
  assert.equal((await repository.leaseNext({ workerId: "worker-a", leaseMs: 30_000 })).leaseToken, "lease-a");
  const query = calls.find(({ sql }) => /WITH candidate AS/u.test(sql));
  assert.match(query.sql, /FOR UPDATE SKIP LOCKED/iu);
  assert.match(query.sql, /state='PENDING'[\s\S]*lease_expires_at<=NOW\(\)/iu);
  assert.match(query.sql, /attempt_count=task\.attempt_count\+1/iu);
  assert.equal(calls.some(({ sql }) => /event_type[\s\S]*'LEASED'/u.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /WITH exhausted_candidate AS[\s\S]*attempt_count>=1000[\s\S]*'DEAD'/u.test(sql)), true);
});

test("explicit admin recovery resets only the same dead task generation and appends both audits", async () => {
  const calls = [];
  let auditMetadata = null;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/set_config\('statement_timeout'/u.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/SELECT id,role FROM accounts/u.test(sql)) return { rows: [{ id: "account-a", role: "admin" }], rowCount: 1 };
      if (/SELECT metadata FROM audit_events/u.test(sql)) return auditMetadata
        ? { rows: [{ metadata: auditMetadata }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/SELECT id,account_id,recovery_count[\s\S]*FROM auto_listing_submission_reconcile_tasks/u.test(sql)) {
        return { rows: [{ id: "task-a", account_id: "account-a", recovery_count: 1 }], rowCount: 1 };
      }
      if (/SELECT task\.id,task\.account_id,task\.job_id,task\.auto_listing_item_id,[\s\S]*task\.submission_link_id,task\.submission_job_id,task\.state,task\.recovery_count/u.test(sql)) {
        return { rows: [{ id: "task-a", account_id: "account-a", job_id: "job-a",
          auto_listing_item_id: "item-a", submission_link_id: "link-a", submission_job_id: "submission-a",
          state: "DEAD", recovery_count: 0 }], rowCount: 1 };
      }
      if (/UPDATE auto_listing_submission_reconcile_tasks[\s\S]*recovery_count=recovery_count\+1/u.test(sql)) {
        return { rows: [{ id: "task-a", account_id: "account-a", state: "PENDING", recovery_count: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO auto_listing_submission_reconcile_events/u.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/INSERT INTO audit_events/u.test(sql)) {
        auditMetadata = JSON.parse(values[5]);
        return { rows: [{ event_id: values[0] }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const repository = createPostgresAutoListingSubmissionReconciliationRepository({
    pool: { async connect() { return client; }, async query(sql, values) { return client.query(sql, values); } },
  });
  const request = {
    accountId: "account-a", actorId: "account-a", taskId: "task-a", reason: "数据库故障已经排除",
    idempotencyKey: "recover-a", correlationId: "corr-a",
  };
  assert.deepEqual(await repository.reopenDeadTask(request), {
    accountId: "account-a", taskId: "task-a", state: "PENDING", recoveryCount: 1, duplicate: false,
  });
  assert.deepEqual(await repository.reopenDeadTask(request), {
    accountId: "account-a", taskId: "task-a", state: "PENDING", recoveryCount: 1, duplicate: true,
  });
  await assert.rejects(repository.reopenDeadTask({ ...request, reason: "不同的恢复原因" }), {
    code: "AUTO_LISTING_RECONCILE_ADMIN_CONFLICT",
  });
  assert.equal(calls.some(({ sql }) => /event_type[\s\S]*'RECOVERED'/u.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /AUTO_LISTING_RECONCILIATION_TASK_RECOVERED/u.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /submission_job_id\s*=|submission_link_id\s*=/iu.test(sql)
    && /UPDATE auto_listing_submission_reconcile_tasks/iu.test(sql)), false);
  assert.equal(calls.filter(({ sql }) => /UPDATE auto_listing_submission_reconcile_tasks[\s\S]*recovery_count=recovery_count\+1/u.test(sql)).length, 1);
});

test("parent aggregation records partial success only after every item is terminal", async () => {
  const { repository, calls } = harness({ aggregateRow: {
    total_count: 2, terminal_count: 2, succeeded_count: 1, blocked_count: 1, cancelled_count: 0,
  } });
  await repository.applyReconciliation({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "correlation-partial-a",
    expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
    itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
    summary: { submissionJobId: "submission-a", ozonTaskId: "ozon-a",
      counts: { success: 1, failed: 0, skipped: 0, stockCount: 1 }, variants: [] },
    advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
    resolveReconciliationBlock: false,
  });
  const update = calls.find(({ sql }) => /UPDATE auto_listing_jobs/u.test(sql));
  assert.equal(update.values[2], "PARTIAL_SUCCESS");
});

test("parent aggregation leaves the batch open while another item is nonterminal", async () => {
  const { repository, calls } = harness({ aggregateRow: {
    total_count: 2, terminal_count: 1, succeeded_count: 1, blocked_count: 0, cancelled_count: 0,
  } });
  await repository.applyReconciliation({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "correlation-open-a",
    expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
    itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
    summary: { submissionJobId: "submission-a", ozonTaskId: "ozon-a",
      counts: { success: 1, failed: 0, skipped: 0, stockCount: 1 }, variants: [] },
    advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
    resolveReconciliationBlock: false,
  });
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_jobs/u.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /AUTO_LISTING_JOB_AGGREGATED/u.test(sql)), false);
});

test("lease completion and reschedule both require account, task and unexpired token CAS", async () => {
  const { repository, calls } = harness();
  const common = { accountId: "account-a", taskId: "task-a", leaseToken: "lease-a", correlationId: "correlation-a" };
  await repository.completeLease({ ...common, evidence: { itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED" } });
  await repository.rescheduleLease({ ...common, delayMs: 5_000, errorCode: null,
    evidence: { itemStatus: "UPLOADING", linkStatus: "SUBMITTED" } });
  for (const query of calls.filter(({ sql }) => /UPDATE auto_listing_submission_reconcile_tasks/u.test(sql))) {
    assert.match(query.sql, /account_id=\$[0-9]+[\s\S]*id=\$[0-9]+[\s\S]*lease_token=\$[0-9]+/iu);
    assert.match(query.sql, /lease_expires_at>NOW\(\)/iu);
  }
});

test("repository rejects accessor-bearing configuration without exposing raw errors", () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, "pool", { enumerable: true, get() { reads += 1; throw new Error("password=raw"); } });
  assert.throws(() => createPostgresAutoListingSubmissionReconciliationRepository(options),
    (error) => error?.code === "AUTO_LISTING_RECONCILE_INVALID" && !/password|raw/iu.test(error.message));
  assert.equal(reads, 0);

  assert.throws(() => createPostgresAutoListingSubmissionReconciliationRepository(new Proxy({}, {
    ownKeys() { throw new Error("password=proxy-secret"); },
  })), (error) => error?.code === "AUTO_LISTING_RECONCILE_INVALID"
    && !/password|proxy-secret/iu.test(error.message));
});

test("apply rejects accessor-bearing nested result evidence before opening a transaction", async () => {
  const { repository, calls } = harness();
  let reads = 0;
  const summary = {};
  Object.defineProperty(summary, "submissionJobId", {
    enumerable: true,
    get() { reads += 1; throw new Error("apiKey=raw-secret"); },
  });
  await assert.rejects(repository.applyReconciliation({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "correlation-a",
    expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
    itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null, summary,
    advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
    resolveReconciliationBlock: false,
  }), (error) => error?.code === "AUTO_LISTING_RECONCILE_INVALID"
    && !/apiKey|raw-secret/iu.test(error.message));
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
});

test("apply rejects proxied recovery summaries without executing traps", async () => {
  let reads = 0;
  const transparent = new Proxy({}, {
    getPrototypeOf() { reads += 1; throw new Error("apiKey=proxy-secret"); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error("apiKey=proxy-secret"); },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const summary of [transparent, revoked.proxy]) {
    const { repository, calls } = harness();
    await assert.rejects(repository.applyReconciliation({
      accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
      submissionJobId: "submission-a", correlationId: "correlation-a",
      expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
      itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null, summary,
      advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
      resolveReconciliationBlock: false,
    }), { code: "AUTO_LISTING_RECONCILE_INVALID" });
    assert.equal(calls.length, 0);
  }
  assert.equal(reads, 0);
});

test("repository accepts only status-exact nullable recovery audit summaries", async () => {
  const valid = [
    ["CLAIMED", null, null], ["MATCHED", null, 3], ["RETRY_PENDING", null, 3],
    ["RETRY_ACCEPTED", "retry-a", 3], ["SUCCEEDED", "retry-a", 3],
    ["NEEDS_REVIEW", null, null], ["NEEDS_REVIEW", null, 3], ["NEEDS_REVIEW", "retry-a", 3],
  ];
  for (const [status, retryOzonTaskId, replacementSharedCategoryVersion] of valid) {
    const { repository, calls } = harness();
    await repository.applyReconciliation({
      accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
      submissionJobId: "submission-a", correlationId: `correlation-${status}-${retryOzonTaskId || "null"}`,
      expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
      itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
      summary: { submissionJobId: "submission-a", ozonTaskId: retryOzonTaskId || "original-a",
        counts: { success: 1, failed: 0, skipped: 0, stockCount: 1 }, variants: [],
        categoryRecovery: { attemptId: "attempt-a", status, originalOzonTaskId: "original-a",
          retryOzonTaskId, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion } },
      advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
      resolveReconciliationBlock: false,
    });
    assert.equal(calls.length > 0, true);
  }
  for (const categoryRecovery of [
    { attemptId: "attempt-a", status: "CLAIMED", originalOzonTaskId: "original-a",
      retryOzonTaskId: "retry-a", oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: null },
    { attemptId: "attempt-a", status: "RETRY_ACCEPTED", originalOzonTaskId: "original-a",
      retryOzonTaskId: null, oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: 3 },
  ]) {
    const { repository, calls } = harness();
    await assert.rejects(repository.applyReconciliation({
      accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
      submissionJobId: "submission-a", correlationId: "correlation-invalid-a",
      expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
      itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
      summary: { submissionJobId: "submission-a", ozonTaskId: "original-a",
        counts: { success: 1, failed: 0, skipped: 0, stockCount: 1 }, variants: [], categoryRecovery },
      advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
      resolveReconciliationBlock: false,
    }), { code: "AUTO_LISTING_RECONCILE_INVALID" });
    assert.equal(calls.length, 0);
  }
  const { repository, calls } = harness();
  await assert.rejects(repository.applyReconciliation({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", submissionLinkId: "link-a",
    submissionJobId: "submission-a", correlationId: "correlation-wrong-task-a",
    expectedItemStatus: "UPLOADING", expectedItemStatusVersion: 8, expectedLinkStatus: "SUBMITTED",
    itemStatus: "SUCCEEDED", linkStatus: "SUCCEEDED", failureCode: null,
    summary: { submissionJobId: "submission-a", ozonTaskId: "wrong-task",
      counts: { success: 1, failed: 0, skipped: 0, stockCount: 1 }, variants: [],
      categoryRecovery: { attemptId: "attempt-a", status: "SUCCEEDED",
        originalOzonTaskId: "original-a", retryOzonTaskId: "retry-a",
        oldSharedCategoryVersion: 1, replacementSharedCategoryVersion: 3 } },
    advanceItemVersion: true, enqueueNextCheck: false, allowResubmission: false,
    resolveReconciliationBlock: false,
  }), { code: "AUTO_LISTING_RECONCILE_INVALID" });
  assert.equal(calls.length, 0);
});
