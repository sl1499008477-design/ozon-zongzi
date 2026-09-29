import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectorAuthorization } from '../dist-electron/services/collector-authorization.core.js';

test('collector authorization exchanges once concurrently, caches separately, and follows parent account changes',async()=>{
 let parent='web-a',now=1000,calls=[];
 const auth=createCollectorAuthorization({getParentToken:()=>parent,getDeviceId:()=> 'desktop-fixture',clock:()=>now,request:async c=>{
  calls.push(c);if(c.url.endsWith('/ticket'))return {ticket:c.headers.Authorization};
  assert.equal(c.headers?.Authorization,undefined);return {collectorToken:'collector-'+c.data.ticket,expiresAt:new Date(now+90000).toISOString()};
 }});
 assert.deepEqual(await Promise.all([auth.get(),auth.get()]),['collector-Bearer web-a','collector-Bearer web-a']);assert.equal(calls.length,2);
 assert.equal(calls[1].data.deviceFingerprint,'desktop-fixture');await auth.get();assert.equal(calls.length,2);
 parent='web-b';assert.equal(await auth.get(),'collector-Bearer web-b');assert.equal(calls.length,4);
 now+=100000;await auth.get();assert.equal(calls.length,6);
 auth.clear();await auth.get();assert.equal(calls.length,8);
 parent='';await assert.rejects(auth.get(),/登录/);assert.equal(calls.length,8);
});

test('account switch during exchange rejects stale credentials and never caches old session',async()=>{
 let parent='a',finish;const auth=createCollectorAuthorization({getParentToken:()=>parent,getDeviceId:()=> 'device',request:async c=>c.url.endsWith('/ticket')?{ticket:'ticket'}:new Promise(r=>finish=r)});
 const pending=auth.get();await new Promise(r=>setImmediate(r));parent='b';finish({collectorToken:'old',expiresAt:new Date(Date.now()+60000).toISOString()});await assert.rejects(pending,/账号|登录/);
});
