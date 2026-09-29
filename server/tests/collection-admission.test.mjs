import assert from 'node:assert/strict';
import test from 'node:test';
import {admitCollectedItem as admit} from '../collection-admission.mjs';
const item = () => ({sku:'1234567',name:'Товар',description_category_id:123,type_id:456,
  weightG:500,lengthMm:300,widthMm:200,heightMm:100});
function ports({valid=true,decision='ALLOW',failure,desktop=null}={}) {
  const calls=[];
  return {calls,pool:{async query(sql,args){calls.push(['query',sql,args]);
    if(sql.includes('collector_task_items'))return {rows:desktop?[{raw_payload:desktop}]:[]};
    return {rows:[{id:'store-a'}]};}},
    readCredential:async(storeId,accountId)=>{calls.push(['credential',storeId,accountId]);return {id:storeId,ownerAccountId:accountId,clientId:'id',apiKey:'test'};},
    categories:{async getCategoryTree(){calls.push(['category']);if(failure)throw failure;
      return {items:[{description_category_id:123,disabled:!valid,children:[{type_id:456,children:[]}]}]};}},
    checkRestrictions:async input=>{calls.push(['restrictions',input]);return {decision,matches:decision==='ALLOW'?[]:[{name:'规则',reason:'原因'}]};},
    now:()=>new Date('2026-09-27T16:00:00Z')};
}
test('incomplete collection remains pending without official API reads',async()=>{
  const p=ports();const result=await admit({accountId:'a',item:{sku:'1234567',name:'Товар',collectionAdmission:{status:'PASSED'}}},p);
  assert.equal(result.collectionAdmission,undefined);
  assert.equal(p.calls.some(c=>c[0]==='credential'),false);
});
test('complete collection checks each category once and records review without blocking',async()=>{
  const p=ports({decision:'REVIEW'});const source=item();source.variants=[{...item(),sku:'1234568'}];
  const result=await admit({accountId:'a',item:source},p);
  assert.equal(result.collectionAdmission.status,'PASSED');
  assert.equal(result.collectionAdmission.restrictions.decision,'REVIEW');
  assert.equal(p.calls.filter(c=>c[0]==='category').length,1);
  assert.match(p.calls.find(c=>c[0]==='query')[1],/owner_account_id=\$1/);
  assert.deepEqual(p.calls.find(c=>c[0]==='query')[2],['a']);
});
test('invalid official category and definite prohibited category never become approved',async()=>{
  await assert.rejects(admit({accountId:'a',item:item()},ports({valid:false})),e=>e.code==='COLLECTION_CATEGORY_INVALID'&&e.retryable===false);
  await assert.rejects(admit({accountId:'a',item:item()},ports({decision:'BLOCK'})),e=>e.code==='PRODUCT_RESTRICTION_BLOCK');
});
test('retryable category failure keeps its classification; authorization failure is actionable',async()=>{
  for(const retryable of [true,false])await assert.rejects(admit({accountId:'a',item:item()},ports({failure:{diagnostic:{retryable,sourceStatus:retryable?502:403}}})),e=>e.code==='COLLECTION_CATEGORY_UNAVAILABLE'&&e.retryable===retryable);
});
test('desktop transfer reuses only server saved same-account matching admission',async()=>{
  const approved=await admit({accountId:'a',item:item()},ports());
  const input={...approved,collectorItemId:'desktop-item',collectorRunId:'run'};
  const p=ports({desktop:approved,failure:new Error('must not read Ozon again')});
  assert.deepEqual((await admit({accountId:'a',item:input},p)).collectionAdmission,approved.collectionAdmission);
  const query=p.calls.find(c=>c[0]==='query');assert.match(query[1],/account_id=\$1/);assert.equal(query[2][0],'a');
  await assert.rejects(admit({accountId:'a',item:{...input,name:'Другое'}},p));
});
test('client approved marker cannot bypass checks and complete desktop requires complete facts',async()=>{
  await assert.rejects(admit({accountId:'a',item:{...item(),collectionAdmission:{status:'PASSED'}}},ports({valid:false})));
  await assert.rejects(admit({accountId:'a',item:{sku:'1234567'},requireComplete:true},ports()),e=>e.code==='COLLECT_ENRICHMENT_INCOMPLETE');
});
test('the actually saved MATCHED target must be enabled and checked against prohibited categories',async()=>{
  const mapped={sku:'1234567',listingDraft:{...item(),sourceCategory:{descriptionCategoryId:123,typeId:456},
    categoryResolution:{status:'MATCHED',method:'MANUAL',source:{descriptionCategoryId:123,typeId:456},
      target:{storeId:'store-a',descriptionCategoryId:789,typeId:987}}}};
  const p=ports();
  await assert.rejects(admit({accountId:'a',item:mapped,requireComplete:true},p),{code:'COLLECTION_CATEGORY_INVALID'});
  p.categories.getCategoryTree=async()=>({items:[{description_category_id:789,children:[{type_id:987,children:[]}]}]});
  await admit({accountId:'a',item:mapped,requireComplete:true},p);
  assert.ok(p.calls.find(c=>c[0]==='restrictions')[1].items.some(row=>row.categoryId===789&&row.typeId===987));
});
test('a saved admission never bypasses current required packaging completeness',async()=>{
  const approved=await admit({accountId:'a',item:item()},ports());
  const incomplete={...approved};delete incomplete.weightG;
  await assert.rejects(admit({accountId:'a',item:incomplete,requireComplete:true,trustedAdmission:approved.collectionAdmission},ports()),{code:'COLLECT_ENRICHMENT_INCOMPLETE'});
  await assert.rejects(admit({accountId:'a',item:{...incomplete,collectorItemId:'saved',collectorRunId:'run'},requireComplete:true},ports({desktop:approved})),{code:'COLLECT_ENRICHMENT_INCOMPLETE'});
});
test('JSON intake uses owned current state credentials without requiring PostgreSQL',async()=>{
  const p=ports();p.pool={query:async()=>{throw new Error('JSON mode must not query PG');}};
  p.state={currentStoreIdsByAccount:{a:'store-a'},stores:[{id:'store-a',ownerAccountId:'a',clientId:'id',apiKey:'fixture'}]};
  delete p.checkRestrictions;
  const result=await admit({accountId:'a',item:item()},p);
  assert.equal(result.collectionAdmission.status,'PASSED');
});

test('saved current category IDs are the official target regardless of resolution status',async()=>{
  const source={...item(),categoryResolution:{status:'NEEDS_REVIEW',currentDescriptionCategoryId:789,currentTypeId:987}};
  const p=ports();
  await assert.rejects(admit({accountId:'a',item:source,requireComplete:true},p),{code:'COLLECTION_CATEGORY_INVALID'});
  p.categories.getCategoryTree=async()=>({items:[{description_category_id:789,children:[{type_id:987,children:[]}]}]});
  await admit({accountId:'a',item:source,requireComplete:true},p);
  assert.ok(p.calls.find(c=>c[0]==='restrictions')[1].items.some(row=>row.categoryId===789&&row.typeId===987));
});

test('source storefront category maps to the actual Seller parent before target restrictions and saving',async()=>{
  const source={...item(),description_category_id:86539915,type_id:91884};
  const p=ports();p.categories.getCategoryTree=async()=>({items:[{description_category_id:86539914,children:[{type_id:91884,children:[]}]}]});
  const approved=await admit({accountId:'a',item:source,requireComplete:true},p);
  assert.equal(approved.categoryResolution.target.descriptionCategoryId,86539914);
  assert.equal(approved.sourceCategory.descriptionCategoryId,86539915);
  assert.equal(approved.collectionAdmission.targets[0].target.typeId,91884);
  const rows=p.calls.find(c=>c[0]==='restrictions')[1].items;
  assert.deepEqual(new Set(rows.map(row=>row.categoryId)),new Set([86539914,86539915]));
  const replay=ports({desktop:approved,failure:new Error('server saved result must not recheck')});
  const transferred=await admit({accountId:'a',item:{...source,collectorItemId:'saved',collectorRunId:'run'}},replay);
  assert.equal(transferred.categoryResolution.target.descriptionCategoryId,86539914);
  assert.equal(replay.calls.some(c=>c[0]==='category'),false);
});
