import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService,normalizeAiListingConfig} from '../ai-listing-service.mjs';
import {normalizeOzonImportItems} from '../ozon-import-normalizer.mjs';
import {quotaAllows,createAiListingStoreRouting} from '../ai-listing-store-routing.mjs';
const config=normalizeAiListingConfig({targetStoreId:'store',targetWarehouseId:'warehouse'});
const item=(sku='one')=>({sku,images:['https://source.test/a.png'],listingItem:{offer_id:sku,name:sku,price:'20',description_category_id:10,type_id:20,weight:240,depth:150,width:160,height:170}});
function creation(source){let writes=0;return {service:createAiListingService({repository:{getMany:async()=>[],create:async t=>(writes++,{...t,version:1})},loadSources:async()=>[source]}),writes:()=>writes};}
const request={accountId:'account',collectItemIds:['collect'],idempotencyKey:'key',config};
test('AI create rejects missing logistics before a task can reserve money or generate',async()=>{const group=item();delete group.listingItem.weight;const x=creation({collectItemId:'collect',items:[group]});await assert.rejects(x.service.createFromCollect(request),{code:'AI_LISTING_LOGISTICS_REQUIRED'});assert.equal(x.writes(),0);});
test('101 selected SKUs rejected before task persistence',async()=>{const x=creation({collectItemId:'collect',items:Array.from({length:101},(_,i)=>item(String(i)))});await assert.rejects(x.service.createFromCollect(request),{code:'AI_LISTING_SKU_LIMIT'});assert.equal(x.writes(),0);});
test('normalizer refuses fictional logistics, while preserving actual source packaging',async()=>{const x=item().listingItem;delete x.weight;await assert.rejects(normalizeOzonImportItems([x],{strictTypeMatch:true}),{code:'ZONGZI_IMPORT_LOGISTICS_REQUIRED'});x._sourceVariant={attributes:[{id:4497,values:[{value:'275'}]}]};const r=await normalizeOzonImportItems([x],{strictTypeMatch:true});assert.equal(r.items[0].weight,275);assert.equal(r.items[0].depth,150);});
test('minute request limits do not redefine daily SKU allowance',()=>{const q={daily_create:{limit:100,usage:0},total:{limit:100,usage:0},operation_limits:{limit:1,limit_type:'RATE_LIMIT_PER_MINUTE'}};assert.equal(quotaAllows(q,[item(),item('two')]),true);});
test('store routing skips otherwise available incompatible currency before commit',async()=>{const client={query:async()=>({rows:[]}),release(){}};const route=createAiListingStoreRouting({pool:{connect:async()=>client},validateTarget:async({config})=>({store:{currencyCode:config.targetStoreId==='wrong'?'CNY':'RUB'}}),readCredential:async()=>({clientId:'x',apiKey:'x'}),fetchFn:async()=>({ok:true,json:async()=>({daily_create:{limit:100,usage:0},total:{limit:1000,usage:0}})})});let chosen;const group=item();group.listingItem.currency_code='RUB';const result=await route({task:{accountId:'a',id:'t',config:{...config,targetStoreId:'wrong',fallbackStores:[{targetStoreId:'right',targetWarehouseId:'w'}]},source:{items:[group],sourceSnapshot:{currency:'RUB',price:'20'}}},commit:async t=>{chosen=t.targetStoreId}});assert.equal(result.selected,true);assert.equal(chosen,'right');});

test('UNSPECIFIED minute zero does not forbid an otherwise eligible import',()=>{assert.equal(quotaAllows({daily_create:{limit:100,usage:0},total:{limit:100,usage:0},operation_limits:{limit:0,limit_type:'UNSPECIFIED'}},[item()]),true);});

test('latest source-identity mapping repairs frozen category without collect lookup and invalidation stops reuse',async()=>{
 const {resolveAiListingSourceCategories}=await import('../ai-listing-source-facts.mjs');let status='ACTIVE';let reads=0;
 const pool={async query(sql,values){assert.match(sql,/FROM account_ozon_shared_categories/);assert.equal(values[0],'account');reads++;return {rows:[{id:'shared',account_id:'account',source_description_category_id:10,source_type_id:20,taxonomy_scope:'OZON:DEFAULT',current_description_category_id:11,current_type_id:21,status,source:'SOURCE_DIRECT',version:2,source_evidence_id:'evidence',taxonomy_fingerprint:null,validated_at:null}]};}};
 const source={collectItemId:'deleted',items:[{...item(),categoryResolution:{status:'ACTIVE',sourceDescriptionCategoryId:10,sourceTypeId:20,taxonomyScope:'OZON:DEFAULT',currentDescriptionCategoryId:10,currentTypeId:20}}]};
 const resolved=await resolveAiListingSourceCategories({accountId:'account',source,pool});assert.equal(resolved.items[0].listingItem.description_category_id,11);assert.equal(reads,1);status='INVALIDATED';await assert.rejects(resolveAiListingSourceCategories({accountId:'account',source,pool}),{code:'AI_LISTING_CATEGORY_UNRESOLVED'});assert.equal(reads,2);
});

test('category metadata does not block daily allowance for plain import items',()=>{assert.equal(quotaAllows({daily_create:{limit:100,usage:0},total:{limit:100,usage:0,quota_by_category:[{category_id:10,limit:0,usage:0}]}},[item().listingItem]),true);});

test('official current type parent repairs stale frozen category before brand dictionary',async()=>{const {resolveAiListingSourceCategories}=await import('../ai-listing-source-facts.mjs');const group=item();group.listingItem.description_category_id=99;const source=await resolveAiListingSourceCategories({accountId:'account',source:{items:[group]},pool:{query:async()=>({rows:[]})},getCategoryTree:async()=>[{description_category_id:10,children:[{type_id:20,type_name:'Lamp',children:[]}]}]});assert.equal(source.items[0].listingItem.description_category_id,10);});

test('one multi-SKU source resolves against one official tree request',async()=>{
 const {resolveAiListingSourceCategories}=await import('../ai-listing-source-facts.mjs');
 let treeReads=0;
 const source=await resolveAiListingSourceCategories({accountId:'account',source:{items:['one','two','three'].map(sku=>item(sku))},pool:{query:async()=>({rows:[]})},getCategoryTree:async()=>{treeReads++;return [{description_category_id:10,children:[{type_id:20,type_name:'Lamp',children:[]}]}];}});
 assert.equal(treeReads,1);
 assert.deepEqual(source.items.map(group=>group.listingItem.description_category_id),[10,10,10]);
});
