import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueObjectDeletions,
  processPendingObjectDeletions,
} from "../object-cleanup-queue.mjs";

test("object cleanup queue is deduplicated and retains failed work for retry", async () => {
  const state = {};
  enqueueObjectDeletions(state, ["a.png", "a.png", "b.png"], "2026-07-27T00:00:00.000Z");

  const result = await processPendingObjectDeletions(
    state,
    async (objectKey) => {
      if (objectKey === "b.png") throw new Error("storage unavailable");
    },
    new Date("2026-07-27T00:00:00.000Z"),
  );

  assert.deepEqual(result, { attempted: 2, deleted: 1, failed: 1, pending: 1 });
  assert.equal(state.pendingObjectDeletions[0].objectKey, "b.png");
  assert.equal(state.pendingObjectDeletions[0].attemptCount, 1);
  assert.match(state.pendingObjectDeletions[0].lastError, /storage unavailable/);
  assert.ok(state.pendingObjectDeletions[0].nextAttemptAt);
});

test("object cleanup queue does not retry before nextAttemptAt", async () => {
  const state = {
    pendingObjectDeletions: [{
      objectKey: "later.png",
      attemptCount: 1,
      nextAttemptAt: "2026-07-27T00:05:00.000Z",
    }],
  };
  let called = false;

  const result = await processPendingObjectDeletions(
    state,
    async () => { called = true; },
    new Date("2026-07-27T00:00:00.000Z"),
  );

  assert.equal(called, false);
  assert.deepEqual(result, { attempted: 0, deleted: 0, failed: 0, pending: 1 });
});
