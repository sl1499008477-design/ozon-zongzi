import test from 'node:test';
import assert from 'node:assert/strict';

test('local image queue serializes real work and advances after a rejection',async()=>{
  const {createImageWorkQueue}=await import('../ai-image-work-queue.mjs');
  const queue=createImageWorkQueue({concurrency:1});const events=[];let release;
  const first=queue.run(async()=>{events.push('first');await new Promise(resolve=>{release=resolve;});throw new Error('image failed');});
  const failed=assert.rejects(first,/image failed/);
  const second=queue.run(async()=>events.push('second'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['first']);assert.deepEqual(queue.snapshot(),{active:1,pending:1,concurrency:1});
  release();await failed;await second;assert.deepEqual(events,['first','second']);assert.equal(queue.snapshot().active,0);
});

test('local queue raises admission to two then drains to one without cancelling work',async()=>{
  const {createImageWorkQueue}=await import('../ai-image-work-queue.mjs');
  const queue=createImageWorkQueue();const releases=[];const entered=[];
  const jobs=[0,1,2].map(i=>queue.run(async()=>{entered.push(i);await new Promise(r=>releases[i]=r);}));
  await new Promise(r=>setImmediate(r));assert.deepEqual(entered,[0]);
  assert.equal(typeof queue.setConcurrency,'function');queue.setConcurrency(2);
  await new Promise(r=>setImmediate(r));assert.deepEqual(entered,[0,1]);
  queue.setConcurrency(1);releases[0]();await jobs[0];assert.deepEqual(entered,[0,1]);
  releases[1]();await jobs[1];await new Promise(r=>setImmediate(r));assert.deepEqual(entered,[0,1,2]);
  releases[2]();await jobs[2];assert.deepEqual(queue.snapshot(),{active:0,pending:0,concurrency:1});
});
