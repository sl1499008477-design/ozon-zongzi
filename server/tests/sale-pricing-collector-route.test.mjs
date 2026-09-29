import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectorHttpHandler} from '../collector-routes.mjs';
import {createCollectorAuthRuntime} from '../collector-auth-runtime.mjs';
import {hashCollectorSecret} from '../collector-auth-service.mjs';
test('extension pricing is read-only, uses Collector config permission and takes account from authentication',async()=>{
 const expiresAt='2099-01-01T00:00:00.000Z';
 const state={accounts:[{id:'a',role:'user',status:'active',expiresAt}],sessions:{web:{accountId:'a',expiresAt}},
  collectorSessions:[{id:'session',accountId:'a',tokenHash:hashCollectorSecret('collector'),parentSessionToken:'web',permissions:['collector.config.read'],expiresAt}]};
 const sendJson=(res,status,body)=>Object.assign(res,{status,body}),readJson=async req=>req.body||{};
 const auth=createCollectorAuthRuntime({loadState:async()=>state,saveState:async()=>{},persistenceMode:()=> 'json',stateTransaction:{run:fn=>fn()},readJson,sendJson});
 const reads=[];
 const handler=createCollectorHttpHandler({authenticate:auth.authenticateRequest,readJson,sendJson,service:{listCollectorSalePricing:async id=>{reads.push(id);return [{id:'own-profile'}];}}});
 const request=async(method,token='Collector collector')=>{const res={};await handler({method,url:'/collector/sale-pricing?accountId=other',headers:{authorization:token},body:{accountId:'other'}},res);return res;};
 const own=await request('GET');assert.equal(own.status,200);assert.equal(own.body.accountId,'a');assert.deepEqual(reads,['a']);
 assert.equal((await request('POST')).status,405);
 assert.equal((await request('GET','Bearer web')).status,401);
 state.collectorSessions[0].permissions=['collector.upload'];assert.equal((await request('GET')).status,403);
 assert.deepEqual(reads,['a']);
});
