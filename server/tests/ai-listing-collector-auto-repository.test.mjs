import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingRepository} from '../ai-listing-repository.mjs';

test('an automatically protected Excel row follows its later canonical merge without creating new work',async()=>{
  const original={id:'old-row',account_id:'a',source_sku:'101',status:'MERGED',body:{importBatchId:'batch',mergedTaskId:'canonical'},version:1};
  const canonical={id:'canonical',account_id:'a',status:'GENERATING',body:{importBatchId:'batch'},version:2};
  const repository=createAiListingRepository({pool:{query:async sql=>({rows:sql.includes('collector_ai_sku_owners')?[original]:[canonical]})}});
  const owners=await repository.readCollectorAutomaticOwners({accountId:'a',skus:['101']});
  assert.equal(owners.get('101').id,'canonical');assert.equal(owners.get('101').status,'GENERATING');
  assert.equal(original.status,'MERGED');
});
