import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createOrderManagementRuntime} from '../order-management-runtime.mjs';

test('runtime serializes background pages and stop waits for the active page without scheduling another',async()=>{
  let pages=0,finishPage,started;
  const pageStarted=new Promise(resolve=>{started=resolve});
  const runtime=createOrderManagementRuntime({pollIntervalMs:5,resolveService:async()=>({processNext:async()=>{
    pages++;started();await new Promise(resolve=>{finishPage=resolve});
  }})});
  await runtime.start();
  // Keep the test alive while the runtime's production timer is deliberately unref'ed.
  await Promise.race([pageStarted,delay(500).then(()=>{throw Error('background page did not start')})]);
  await delay(15);assert.equal(pages,1);
  let stopped=false;const stopping=runtime.stop().then(()=>{stopped=true});await delay(5);assert.equal(stopped,false);
  finishPage();await stopping;await delay(15);assert.equal(pages,1);assert.equal(stopped,true);
});
