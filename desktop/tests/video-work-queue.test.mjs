import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoWorkQueue} from '../dist-electron/services/collection/video-work-queue.services.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('one desktop queue serializes video work from different Collections',async()=>{
  const queue=createVideoWorkQueue({maxPending:4}),starts=[];
  let releaseFirst;
  const first=queue.run(async()=>{starts.push('first');await new Promise(resolve=>{releaseFirst=resolve;});return 1;});
  const second=queue.run(async()=>{starts.push('second');return 2;});
  await tick();assert.deepEqual(starts,['first']);
  releaseFirst();assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.deepEqual(starts,['first','second']);
});

test('cancelling a waiting Collection removes its job before ffmpeg work can start',async()=>{
  const queue=createVideoWorkQueue({maxPending:4});let releaseFirst,started=0;
  const first=queue.run(async()=>{await new Promise(resolve=>{releaseFirst=resolve;});});
  const controller=new AbortController();
  const waiting=queue.run(async()=>{started++;},{signal:controller.signal});
  controller.abort();await assert.rejects(waiting,{name:'AbortError'});
  releaseFirst();await first;await tick();assert.equal(started,0);assert.deepEqual(queue.snapshot(),{active:0,pending:0});
});

test('the desktop video queue has a bounded waiting list',async()=>{
  const queue=createVideoWorkQueue({maxPending:1});let releaseFirst;
  const first=queue.run(()=>new Promise(resolve=>{releaseFirst=resolve;}));
  const second=queue.run(async()=>{});
  await assert.rejects(queue.run(async()=>{}),{code:'COLLECTOR_VIDEO_QUEUE_FULL'});
  releaseFirst();await Promise.all([first,second]);
});
