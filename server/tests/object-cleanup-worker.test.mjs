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
    loadState: async (options = {}) => {
      assert.equal(options.hydrateCatalog, false, 'object cleanup must not hydrate unrelated product data');
      return state;
    },
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

test('stopping scheduled cleanup waits for persistence and prevents the next cleanup', async () => {
  let release, entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  let loads=0,saved=0;
  const worker=createObjectCleanupWorker({loadState:async()=>{loads++;return{pendingObjectDeletions:[{objectKey:'old.png'}]};},
    removeObject:async()=>{entered();await blocked;},saveState:async()=>{saved++;},logger:{error(){}}});
  const stop=worker.start({initialDelayMs:0,intervalMs:10});
  // Keep the test alive while the worker's normal timers are unref'ed.
  const keepAlive=setInterval(()=>{},1000);
  try{
    await started;let done=false;const stopping=Promise.resolve(stop()).then(()=>{done=true;});
    await new Promise(r=>setTimeout(r,15));assert.equal(done,false);assert.equal(saved,0);
    release();await stopping;assert.equal(saved,1);await new Promise(r=>setTimeout(r,20));assert.equal(loads,1);
  }finally{release();clearInterval(keepAlive);stop();}
});
