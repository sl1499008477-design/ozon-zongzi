import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingItemHttpHandler } from "../auto-listing-item-routes.mjs";

const body = Object.freeze({
  jobId: "job-a", expectedStatusVersion: 5,
  idempotencyKey: "command-a", correlationId: "correlation-a",
});

function harness({ enabled = true, authenticate, service } = {}) {
  const replies = []; const calls = []; let initialized = 0;
  const value = service || {
    async retryItem(input) { calls.push(["retry", input]); return { status: "GENERATING", statusVersion: 6, duplicate: false }; },
    async regenerateItem(input) { calls.push(["regenerate", input]); return { status: "PLANNING", statusVersion: 6, duplicate: false }; },
    async approveItem(input) { calls.push(["approve", input]); return { status: "UPLOAD_QUEUED", statusVersion: 6, duplicate: false }; },
    async cancelItem(input) { calls.push(["cancel", input]); return { status: "CANCELLED", statusVersion: 6, duplicate: false }; },
    async getReview(input) { calls.push(["review", input]); return { itemId: "item-a", statusVersion: 5, images: [] }; },
  };
  const handler = createAutoListingItemHttpHandler({
    isEnabled: () => enabled,
    authenticate: authenticate || (async () => ({ id: "account-a", role: "user" })),
    async getService() { initialized += 1; return value; },
    readJson: async (req) => req.body,
    sendJson: (_res, status, payload) => replies.push({ status, payload }),
  });
  return { handler, replies, calls, initialized: () => initialized };
}

test("action routes inject only the actor and one closed versioned command", async () => {
  const local = harness();
  for (const action of ["retry", "regenerate", "approve", "cancel"]) {
    const path = `/auto-listing/items/item-a/${action}`;
    assert.equal(await local.handler({ method: "POST", body }, {}, new URL(`http://local${path}`)), true);
  }
  assert.deepEqual(local.calls.map(([name, input]) => [name, input]), [
    ["retry", { actor: { id: "account-a", role: "user" }, itemId: "item-a", ...body }],
    ["regenerate", { actor: { id: "account-a", role: "user" }, itemId: "item-a", ...body }],
    ["approve", { actor: { id: "account-a", role: "user" }, itemId: "item-a", ...body }],
    ["cancel", { actor: { id: "account-a", role: "user" }, itemId: "item-a", ...body }],
  ]);
  assert.deepEqual(local.replies.map(({ status, payload }) => [status, payload.ok, payload.correlationId]), [
    [200, true, "correlation-a"], [200, true, "correlation-a"], [200, true, "correlation-a"], [200, true, "correlation-a"],
  ]);
});

test("disabled and invalid action requests fail before runtime initialization", async () => {
  const disabled = harness({ enabled: false });
  await disabled.handler({ method: "POST", body }, {}, new URL("http://local/auto-listing/items/item-a/cancel"));
  assert.equal(disabled.replies[0].status, 503);
  assert.equal(disabled.initialized(), 0);
  for (const [path, value] of [
    ["/auto-listing/items/item-a/cancel", { ...body, accountId: "account-b" }],
    ["/auto-listing/items/%/cancel", body],
    ["/auto-listing/items/item-a/retry?accountId=account-b", body],
  ]) {
    const local = harness();
    await local.handler({ method: "POST", body: value }, {}, new URL(`http://local${path}`));
    assert.equal(local.replies[0].status, 400);
    assert.equal(local.initialized(), 0);
  }
});

test("authentication and stable command failures never expose raw internals", async () => {
  const unauthenticated = harness({ authenticate: async () => { throw Object.assign(new Error("cookie=secret"), { status: 401 }); } });
  await unauthenticated.handler({ method: "POST", body }, {}, new URL("http://local/auto-listing/items/item-a/cancel"));
  assert.equal(unauthenticated.replies[0].status, 401);
  assert.doesNotMatch(JSON.stringify(unauthenticated.replies[0]), /secret|cookie/i);

  const failed = harness({ service: {
    async cancelItem() { throw Object.assign(new Error("password=production"), { code: "AUTO_LISTING_USER_ACTION_CONFLICT" }); },
  } });
  await failed.handler({ method: "POST", body }, {}, new URL("http://local/auto-listing/items/item-a/cancel"));
  assert.equal(failed.replies[0].status, 409);
  assert.equal(failed.replies[0].payload.code, "AUTO_LISTING_USER_ACTION_CONFLICT");
  assert.doesNotMatch(JSON.stringify(failed.replies[0]), /password|production/i);
});

test("unknown item paths are untouched and unsupported methods are 405", async () => {
  const local = harness();
  assert.equal(await local.handler({ method: "GET" }, {}, new URL("http://local/unrelated")), false);
  await local.handler({ method: "GET" }, {}, new URL("http://local/auto-listing/items/item-a/cancel"));
  assert.equal(local.replies[0].status, 405);
  assert.equal(local.initialized(), 0);
});

test("review route is a bodyless authenticated GET and returns a closed DTO", async () => {
  const local = harness();
  const handled = await local.handler({ method: "GET" }, {}, new URL("http://local/auto-listing/items/item-a/review"));
  assert.equal(handled, true);
  assert.deepEqual(local.calls, [["review", {
    actor: { id: "account-a", role: "user" }, itemId: "item-a",
  }]]);
  assert.deepEqual(local.replies, [{
    status: 200,
    payload: { ok: true, data: { itemId: "item-a", statusVersion: 5, images: [] } },
  }]);
});

test("review route rejects methods, query input, and missing evidence without leaking details", async () => {
  const wrongMethod = harness();
  await wrongMethod.handler({ method: "POST", body }, {}, new URL("http://local/auto-listing/items/item-a/review"));
  assert.equal(wrongMethod.replies[0].status, 405);
  assert.equal(wrongMethod.initialized(), 0);

  const query = harness();
  await query.handler({ method: "GET" }, {}, new URL("http://local/auto-listing/items/item-a/review?accountId=account-b"));
  assert.equal(query.replies[0].status, 400);
  assert.equal(query.initialized(), 0);

  const missing = harness({ service: {
    async getReview() {
      throw Object.assign(new Error("object_key=private/secret"), { code: "AUTO_LISTING_REVIEW_NOT_FOUND" });
    },
  } });
  await missing.handler({ method: "GET" }, {}, new URL("http://local/auto-listing/items/item-a/review"));
  assert.equal(missing.replies[0].status, 404);
  assert.equal(missing.replies[0].payload.code, "AUTO_LISTING_REVIEW_NOT_FOUND");
  assert.doesNotMatch(JSON.stringify(missing.replies[0]), /object_key|private|secret/i);

  const unavailable = harness({ service: {
    async getReview() {
      throw Object.assign(new Error("password=database-secret"), { code: "AUTO_LISTING_REVIEW_FAILED" });
    },
  } });
  await unavailable.handler({ method: "GET" }, {}, new URL("http://local/auto-listing/items/item-a/review"));
  assert.equal(unavailable.replies[0].status, 503);
  assert.equal(unavailable.replies[0].payload.code, "AUTO_LISTING_REVIEW_FAILED");
  assert.doesNotMatch(JSON.stringify(unavailable.replies[0]), /password|secret/u);
});
