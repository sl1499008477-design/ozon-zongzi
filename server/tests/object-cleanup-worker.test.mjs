import assert from "node:assert/strict";
import test from "node:test";
import { createObjectCleanupWorker } from "../object-cleanup-worker.mjs";

test("object cleanup worker loads, drains, and persists the updated queue", async () => {
  const state = {
    pendingObjectDeletions: [{
      objectKey: "orphan.png",
      attemptCount: 0,
      nextAttemptAt: "2026-07-27T00:00:00.000Z",
    }],
  };
  const removed = [];
  let saved = 0;
  const worker = createObjectCleanupWorker({
    loadState: async () => state,
    saveState: async () => { saved += 1; },
    removeObject: async (objectKey) => { removed.push(objectKey); },
    logger: { error() {} },
  });

  const result = await worker.drain();

  assert.deepEqual(removed, ["orphan.png"]);
  assert.equal(saved, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(state.pendingObjectDeletions, []);
});
