import test from 'node:test';import assert from 'node:assert/strict';
import {authorizeDirectRfbsPhase,verifyDirectRfbsTargets} from '../listing-direct-rfbs.mjs';
function fixture(){
 const warehouse={id:'local-w',account_id:'a',store_id:'s',warehouse_id:'123456',warehouse_type:'RFBS',status:'active',is_active:true,is_archived:false};
 const evidence={accountId:'a',storeId:'s',warehouseRecordId:'local-w',platformWarehouseId:'123456',fulfillmentType:'RFBS',outcome:'PASSED',expiresAt:'2000-01-01T00:00:00Z'};
 const stocks=[{offer_id:'success',warehouse_id:'123456',stock:0},{offer_id:'failed',warehouse_id:'654321',stock:0}];
 const frozen={id:'j',account_id:'a',store_id:'s',snapshot_id:'snap',status:'CHECKING',stocks,direct_rfbs_evidence:[evidence]};
 const calls={verify:[],events:[]};
 const pool={query:async(sql,args)=>{
  if(sql.includes('FROM submission_jobs j'))return {rows:args[1]==='a'&&args[2]==='s'&&args[3]==='snap'?[frozen]:[]};
  if(sql.includes('FROM warehouses w'))return {rows:args[2].includes('123456')?[warehouse]:[]};
  if(sql.includes('INSERT INTO submission_events')){calls.events.push(args);return {rowCount:1,rows:[{id:1}]};}
  throw Error('unexpected query');
 }};
 const createVerifier=()=>({verifyRfbsWarehouse:async input=>{calls.verify.push(input);return {...evidence,expiresAt:new Date(Date.now()+60000).toISOString()}}});
 const deps={pool,createVerifier,readCredential:async()=>({}),callOzonSellerApi:async()=>{throw Error('mock verifier must prevent network')}};
 return {warehouse,evidence,stocks,frozen,calls,deps,work:{id:'j',account_id:'a',store_id:'s',snapshot_id:'snap'}};
}
test('direct stock phase refreshes expired frozen evidence for only the exact successful subset',async()=>{
 const f=fixture();assert.equal((await authorizeDirectRfbsPhase(f.work,'PRE_STOCK',{...f.deps,stocks:[f.stocks[0]]})).required,true);
 assert.equal(f.calls.verify.length,1);assert.equal(f.calls.events.length,1);
});
test('scope, snapshot, warehouse drift and arbitrary frozen quantities cannot authorize direct RFBS',async()=>{
 for(const change of [{account_id:'other'},{store_id:'other'},{snapshot_id:'other'}]){const f=fixture();await assert.rejects(authorizeDirectRfbsPhase({...f.work,...change},'PRE_STOCK',{...f.deps,stocks:[f.stocks[0]]}),{code:'LISTING_RFBS_PHASE_SCOPE_INVALID'});assert.equal(f.calls.verify.length,0);}
 const f=fixture();await assert.rejects(authorizeDirectRfbsPhase(f.work,'PRE_STOCK',{...f.deps,stocks:[{...f.stocks[0],stock:1}]}),{code:'LISTING_RFBS_PHASE_SCOPE_INVALID'});
 f.warehouse.warehouse_type='FBS';await assert.rejects(authorizeDirectRfbsPhase(f.work,'PRE_STOCK',{...f.deps,stocks:[f.stocks[0]]}),{code:'LISTING_RFBS_PHASE_SCOPE_INVALID'});
});
test('missing frozen RFBS evidence cannot fall through to legacy FBS authorization',async()=>{const f=fixture();f.frozen.direct_rfbs_evidence=[];await assert.rejects(authorizeDirectRfbsPhase(f.work,'PRE_STOCK',{...f.deps,stocks:[f.stocks[0]]}),{code:'LISTING_RFBS_PHASE_SCOPE_INVALID'});});
test('IMPORT_UNKNOWN/reconciling work cannot enter a new direct import authorization',async()=>{const f=fixture();f.frozen.status='RECONCILING';await assert.rejects(authorizeDirectRfbsPhase(f.work,'PRE_IMPORT',f.deps),{code:'LISTING_RFBS_PHASE_SCOPE_INVALID'});assert.equal(f.calls.verify.length,0);});
test('official verification outage is retryable and produces no authorization event',async()=>{const f=fixture();await assert.rejects(authorizeDirectRfbsPhase(f.work,'PRE_STOCK',{...f.deps,stocks:[f.stocks[0]],createVerifier:()=>({verifyRfbsWarehouse:async()=>{throw Error('503')}})}),error=>error.status===503&&error.retryable);assert.equal(f.calls.events.length,0);});
test('preparation checks current database RFBS target independent of a frontend cache',async()=>{const f=fixture();const result=await verifyDirectRfbsTargets({...f.deps,accountId:'a',storeId:'s',stocks:[f.stocks[0]],correlationId:'test'});assert.equal(result.length,1);assert.equal(f.calls.verify.length,1);});
