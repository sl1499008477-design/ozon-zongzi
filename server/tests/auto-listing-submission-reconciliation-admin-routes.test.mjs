import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingSubmissionReconciliationAdminHttpHandler } from "../auto-listing-submission-reconciliation-admin-routes.mjs";

const path = "/admin/auto-listing/reconciliation-tasks/recover";

function harness(actor = { id: "account-a", role: "admin" }) {
  const sent = [];
  const calls = [];
  const handler = createAutoListingSubmissionReconciliationAdminHttpHandler({
    authenticate: async () => actor,
    getService: async () => ({ async reopenDeadTask(input) {
      calls.push(input);
      return { taskId: input.taskId, state: "PENDING", recoveryCount: 1, duplicate: false };
    } }),
    readJson: async (request) => request.body,
    sendJson: (_response, status, payload) => sent.push({ status, payload }),
  });
  return { handler, sent, calls };
}

test("POST exposes one closed admin recovery command without accepting binding replacements", async () => {
  const { handler, sent, calls } = harness();
  const body = { taskId: "task-a", reason: "故障已排除", idempotencyKey: "recover-a", correlationId: "corr-a" };
  assert.equal(await handler({ method: "POST", body }, {}, new URL(`http://local${path}`)), true);
  assert.equal(sent[0].status, 200);
  assert.deepEqual(calls[0], { actor: { id: "account-a", role: "admin" }, ...body });

  await handler({ method: "POST", body: { ...body, submissionJobId: "new-submission" } }, {},
    new URL(`http://local${path}`));
  assert.equal(sent.at(-1).status, 400);
});

test("route enforces AI content admin permission, method and empty query contract", async () => {
  const denied = harness({ id: "account-a", role: "user" });
  await denied.handler({ method: "POST", body: {} }, {}, new URL(`http://local${path}`));
  assert.equal(denied.sent[0].status, 403);
  assert.equal(denied.calls.length, 0);

  const active = harness();
  await active.handler({ method: "GET" }, {}, new URL(`http://local${path}`));
  assert.equal(active.sent.at(-1).status, 405);
  await active.handler({ method: "POST", body: {} }, {}, new URL(`http://local${path}?accountId=other`));
  assert.equal(active.sent.at(-1).status, 400);
  assert.equal(await active.handler({ method: "POST" }, {}, new URL("http://local/unrelated")), false);
});

test("route rejects accessor-bearing recovery bodies without reading them", async () => {
  const { handler, sent, calls } = harness();
  let reads = 0;
  const body = {
    taskId: "task-a", idempotencyKey: "recover-a", correlationId: "corr-a",
  };
  Object.defineProperty(body, "reason", {
    enumerable: true,
    get() { reads += 1; throw new Error("apiKey=must-not-leak"); },
  });
  await handler({ method: "POST", body }, {}, new URL(`http://local${path}`));
  assert.equal(sent[0].status, 400);
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(sent[0].payload), /apiKey|must-not-leak/iu);
});

test("runtime initialization failure remains a stable 503 instead of becoming an internal 500", async () => {
  const responses = [];
  const handler = createAutoListingSubmissionReconciliationAdminHttpHandler({
    authenticate: async () => ({ id: "account-a", role: "admin" }),
    getService: async () => {
      const error = new Error("hidden database detail");
      error.code = "AUTO_LISTING_RECONCILE_ADMIN_INITIALIZATION_FAILED";
      error.status = 503;
      throw error;
    },
    readJson: async () => ({ taskId: "task-a", reason: "人工确认后恢复", idempotencyKey: "idem-a", correlationId: "corr-a" }),
    sendJson: (_res, status, payload) => responses.push({ status, payload }),
  });
  assert.equal(await handler({ method: "POST" }, {}, new URL("http://local/admin/auto-listing/reconciliation-tasks/recover")), true);
  assert.deepEqual(responses, [{ status: 503, payload: {
    ok: false,
    code: "AUTO_LISTING_RECONCILE_ADMIN_INITIALIZATION_FAILED",
    message: "自动上架对账恢复服务暂时不可用",
  } }]);
});
