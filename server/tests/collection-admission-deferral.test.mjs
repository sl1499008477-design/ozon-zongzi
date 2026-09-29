import assert from 'node:assert/strict';
import test from 'node:test';
import {deferCollectItemEnrichmentWithClientV4} from '../listing-pipeline.mjs';
test('a failed collection admission cannot become complete merely because category and package fields exist',async()=>{
  let updated;
  const row={id:'item',account_id:'account',status:'COMPLETE',summary:{enrichment:{status:'COMPLETE'}},draft_version:1,
    draft_data:{sku:'1234567',sourceCategory:{descriptionCategoryId:123,typeIdCandidate:456},logistics:{weightG:1,lengthMm:1,widthMm:1,heightMm:1}}};
  const result=await deferCollectItemEnrichmentWithClientV4({async query(sql,args){
    if(sql.startsWith('SELECT'))return {rows:[row]};
    updated=JSON.parse(args[2]);return {rows:[{...row,status:args[3],summary:updated}]};
  }},{collectItemId:'item',accountId:'account',status:'RETRYING',
    error:{code:'ZONGZI_ENRICH_UPSTREAM_FAILED',collectionAdmissionFailure:true},
    deferJob:async()=>({id:'job',sku:'1234567',attemptCount:1,nextAttemptAt:'2026-09-27T16:01:00Z'}),
    completeLinkedJobs:async()=>{throw new Error('failed official admission must not be completed');}});
  assert.equal(result.item.status,'RETRYING');assert.equal(updated.enrichment.status,'RETRYING');
});
