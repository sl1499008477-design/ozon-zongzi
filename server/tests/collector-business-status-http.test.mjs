import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createCollectorHttpHandler} from '../collector-routes.mjs';

test('product-group business states remain in JSON and never become HTTP status codes',async()=>{
 let state='CLAIMED';
 const handler=createCollectorHttpHandler({authenticate:async()=>({id:'fixture-account'}),service:{
  claimCollectorRunProductGroup:async input=>{assert.equal(input.accountId,'fixture-account');return {groupId:'group',status:state,skus:['123'],cachedVariants:[]};},
  createCollectorTask:async()=>({id:'new-task'}),
 }});
 const server=createServer((req,res)=>void handler(req,res));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(state of ['CLAIMED','COLLECTING','COLLECTED']){
   const response=await fetch(base+'/collector/runs/run/product-groups/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:'device',leaseToken:'fixture',anchorSku:'123',skus:['123']})});
   const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.status,state);assert.equal(body.ok,true);
  }
  const response=await fetch(base+'/collector/tasks',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,201);assert.equal((await response.json()).task.id,'new-task');
 }finally{await new Promise(r=>server.close(r));}
});
