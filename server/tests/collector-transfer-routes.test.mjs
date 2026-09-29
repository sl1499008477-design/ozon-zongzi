import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectorHttpHandler} from '../collector-routes.mjs';

async function request(method,url,body={},service={}) {
  const calls=[];let response;
  const handler=createCollectorHttpHandler({service,authenticate:async(_req,permission)=>{calls.push(permission);return{id:'owner'};},
    sendJson:(_res,status,payload)=>{response={status,payload};}});
  assert.equal(await handler({method,url,body},{}),true);
  return{...response,calls};
}
test('capability negotiation uses authenticated config scope and enables compatible payload sharing',async()=>{
  const result=await request('GET','/collector/capabilities');
  assert.equal(result.status,200);assert.deepEqual(result.calls,['collector.config.read']);
  assert.deepEqual(result.payload.capabilities,{exportDataFromRaw:true,eventBatch:true,durableHandoff:true});
});
test('event batches preserve order and cannot choose another account or actor',async()=>{
  let received;
  const result=await request('POST','/collector/runs/run/events',{events:[{eventType:'FIRST',accountId:'other',actorId:'other'},{eventType:'SECOND'}]},
    {appendCollectorRunEvents:async input=>{received=input;return input.events;}});
  assert.equal(result.status,200);assert.equal(received.accountId,'owner');assert.equal(received.actorId,'owner');
  assert.deepEqual(received.events.map(e=>e.eventType),['FIRST','SECOND']);
  assert.equal(received.events[0].accountId,undefined);
});
test('oversize event batch is rejected before service work',async()=>{
  let called=false;const result=await request('POST','/collector/runs/run/events',{events:Array.from({length:51},()=>({eventType:'LOG'}))},
    {appendCollectorRunEvents:async()=>{called=true;}});
  assert.equal(result.status,422);assert.equal(called,false);
});
test('explicit handoff retry is scoped by authenticated account',async()=>{
  let received;const result=await request('POST','/collector/runs/run/handoff/retry',{accountId:'other'},
    {retryCollectorRunHandoff:async input=>{received=input;return{status:'PENDING'};}});
  assert.equal(result.status,200);assert.deepEqual(received,{accountId:'owner',runId:'run'});
  assert.equal(result.payload.handoff.status,'PENDING');
});
test('media routes preserve the current device lease and use authenticated account',async()=>{
  let received;
  const service={issueCollectorRunMediaUpload:async input=>(received=input,{uploadId:'upload'}),
    confirmCollectorRunMediaUpload:async input=>(received=input,{mediaObject:{uploadId:'upload'}}),
    collectorMediaCapabilities:async()=>({mediaDirectUploadV1:true})};
  const capability=await request('GET','/collector/capabilities',{},service);
  assert.equal(capability.payload.capabilities.mediaDirectUploadV1,true);
  const issued=await request('POST','/collector/runs/run/media-uploads',{accountId:'other',runId:'other',deviceId:'device',leaseToken:'lease',sourceSku:'11'},service);
  assert.equal(issued.status,200);assert.equal(received.accountId,'owner');assert.equal(received.runId,'run');assert.equal(received.leaseToken,'lease');
  assert.deepEqual(issued.calls,['collector.upload']);
  const confirmed=await request('POST','/collector/runs/run/media-uploads/upload/confirm',{deviceId:'device',leaseToken:'lease',uploadId:'other'},service);
  assert.equal(confirmed.status,200);assert.equal(received.uploadId,'upload');
});
