import test from 'node:test';import assert from 'node:assert/strict';
import {withoutListedSkus,findCollectedSku} from '../collection-sku-rules.mjs';
import {createOzonSkuCollectionService} from '../ozon-sku-collection-service.mjs';
test('duplicate skips scraping and writing',async()=>{
 const item={id:'existing',sku:'123'};
 const service=createOzonSkuCollectionService({findExisting:async({accountId,sku})=>{assert.equal(accountId,'a');assert.equal(sku,'123');return item;},scrapeProductDetail:()=>{throw Error('must not scrape');},normalizeItem:x=>x,saveItem:()=>{throw Error('must not save');}});
 assert.equal((await service.collectOzonSkuForAccount({account:{id:'a'},sku:'123'})).duplicate,true);
});
test('completed SKU hidden; unfinished variants preserved without mutating source',()=>{
 const items=[{sku:'1'},{sku:'2',variants:[{sku:'2'},{sku:'3'}],listingDraft:{variants:[{sku:'2'},{sku:'3'}]}}];
 const result=withoutListedSkus(items,[{source:{items:[{sku:'1'},{sku:'2'}]}}]);
 assert.equal(result.length,1);assert.deepEqual(result[0].variants,[{sku:'3'}]);assert.equal(items[1].variants.length,2);
});
test('duplicate query excludes deleted items except successful listings',async()=>{
 const client={query:async(sql,args)=>{assert.equal(args[0],'account');assert.ok(sql.includes('deleted_at IS NULL OR EXISTS'));assert.ok(sql.includes("t.status='COMPLETED'"));return {rows:[{id:'old',source_sku:'1',deleted_at:'date',draft:{title:'saved'}}]};}};
 assert.equal((await findCollectedSku(client,'account','1')).previouslyDeleted,true);
});
test('successful listing still prevents recollection after collection record is physically removed',async()=>{
 let calls=0;const client={async query(sql,args){calls++;assert.equal(args[0],'account');return {rows:calls===1?[]:[{id:'completed-task'}]};}};
 assert.equal((await findCollectedSku(client,'account','123456789')).collectionState,'LISTED');
});
test('a partially imported task hides only successful SKUs, including while stock is pending',()=>{
 const result=withoutListedSkus([{sku:'1',variants:[{sku:'1'},{sku:'2'}]}],[{
  status:'SUBMISSION_FAILED',source:{items:[{sku:'1'},{sku:'2'}]},
  submissionResults:[{sku:'1',importStatus:'SUCCEEDED',stockStatus:'PENDING'},{sku:'2',importStatus:'FAILED'}],
 }]);
 assert.deepEqual(result[0].variants,[{sku:'2'}]);
});
test('listed variants are removed from public source arrays too, without changing stored evidence',()=>{
 const variants=[{sku:'1',name:'Listed'},{sku:'2',name:'New'}];
 const item={sku:'1',variants,listingDraft:{variants},variantData:{variants,attributes:['keep']},raw:{variantData:{variants}}};
 const projected=withoutListedSkus([item],[{status:'COMPLETED',source:{items:[{sku:'1'}]}}])[0];
 for(const list of [projected.variants,projected.listingDraft.variants,projected.variantData.variants,projected.raw.variantData.variants])assert.deepEqual(list.map(v=>v.sku),['2']);
 assert.deepEqual(projected.variantData.attributes,['keep']);
 assert.equal(item.variantData.variants.length,2);assert.equal(item.raw.variantData.variants.length,2);
});
test('a single remaining listed child is filtered even when the record still names its parent SKU',()=>{
 const item={sku:'parent',listingDraft:{variants:[{sku:'1602438352'}]}};
 const completed=[{status:'COMPLETED',source:{items:[{sku:'1602438352'}]}}];
 assert.deepEqual(withoutListedSkus([item],completed),[]);
 assert.deepEqual(item.listingDraft.variants,[{sku:'1602438352'}]);
 assert.deepEqual(withoutListedSkus([item],[]),[item]);
});
