import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSubmissionReconciliationAdminService } from "../auto-listing-submission-reconciliation-admin-service.mjs";

const command = Object.freeze({
  actor: Object.freeze({ id: "account-a", role: "admin" }),
  taskId: "task-a",
  reason: "数据库故障已经排除，重新核对原提交",
  idempotencyKey: "recover-task-a-1",
  correlationId: "recover-correlation-a",
});

test("AI content admin explicitly reopens only the same account-scoped dead task", async () => {
  const calls = [];
  const service = createAutoListingSubmissionReconciliationAdminService({
    repository: { async reopenDeadTask(input) {
      calls.push(input);
      return { accountId: "account-a", taskId: "task-a", state: "PENDING", recoveryCount: 1, duplicate: false };
    } },
  });
  assert.deepEqual(await service.reopenDeadTask(command), {
    taskId: "task-a", state: "PENDING", recoveryCount: 1, duplicate: false,
  });
  assert.deepEqual(calls, [{
    accountId: "account-a", actorId: "account-a", taskId: "task-a",
    reason: "数据库故障已经排除，重新核对原提交",
    idempotencyKey: "recover-task-a-1", correlationId: "recover-correlation-a",
  }]);
});

test("ordinary users and open request shapes cannot reach recovery persistence", async () => {
  let calls = 0;
  const service = createAutoListingSubmissionReconciliationAdminService({
    repository: { async reopenDeadTask() { calls += 1; } },
  });
  await assert.rejects(service.reopenDeadTask({ ...command, actor: { id: "account-a", role: "user" } }), {
    code: "PERMISSION_FORBIDDEN",
  });
  await assert.rejects(service.reopenDeadTask({ ...command, submissionJobId: "replacement" }), {
    code: "AUTO_LISTING_RECONCILE_ADMIN_INVALID",
  });
  assert.equal(calls, 0);
});

test("recovery reason is mandatory and bounded", async () => {
  const service = createAutoListingSubmissionReconciliationAdminService({
    repository: { async reopenDeadTask() { assert.fail("invalid reason must not persist"); } },
  });
  for (const reason of ["", "x".repeat(501)]) {
    await assert.rejects(service.reopenDeadTask({ ...command, reason }), {
      code: "AUTO_LISTING_RECONCILE_ADMIN_INVALID",
    });
  }
});

test("repository output cannot cross the authenticated account boundary", async () => {
  const service = createAutoListingSubmissionReconciliationAdminService({
    repository: { async reopenDeadTask() {
      return { accountId: "account-b", taskId: "task-a", state: "PENDING", recoveryCount: 1, duplicate: false };
    } },
  });
  await assert.rejects(service.reopenDeadTask(command), {
    code: "AUTO_LISTING_RECONCILE_ADMIN_DATA_BOUNDARY",
  });
});
