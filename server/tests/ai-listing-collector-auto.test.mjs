import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {loadAiListingCollectSources} from '../ai-listing-runtime.mjs';
import {testExports} from '../index.mjs';

const copy=value=>structuredClone(value);
const config={targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true};
const source=(id,skus)=>({collectItemId:id,sku:skus[0],sourceSnapshot:{source:'ozon'},items:skus.map(sku=>({
  sku,images:[`https://source.example/${sku}.png`],listingItem:{weight:100,depth:100,width:100,height:100},
}))});
function fixture({loadSources}={}) {
  const rows=new Map(),owners=new Map(),sources=new Map();let writes=Promise.resolve();
  const repository={
    rows,owners,
    async getMany({accountId,taskIds}){return [...rows.values()].filter(row=>row.accountId===accountId&&taskIds.includes(row.id)).map(copy);},
    async get({accountId,taskId}){const task=rows.get(taskId);return task?.accountId===accountId?copy(task):null;},
    async create(task){if(!rows.has(task.id))rows.set(task.id,{...copy(task),version:1});return copy(rows.get(task.id));},
    async readCollectorAutomaticOwners({accountId,skus}){
      const result=new Map();
      for(const sku of skus){
        const task=rows.get(owners.get(`${accountId}:${sku}`))||[...rows.values()].find(row=>row.accountId===accountId
          && (row.source?.items?.some(item=>item.sku===sku)||row.collectWait?.selectedSkus.includes(sku)));
        if(task)result.set(sku,copy(task));
      }
      return result;
    },
    async createCollectorAutomatic({accountId,skus,prepare}){
      const execute=async()=>{
        const existing=await this.readCollectorAutomaticOwners({accountId,skus});
        const prepared=await prepare(skus.filter(sku=>!existing.has(sku)),existing);
        for(const task of prepared){await this.create(task);for(const sku of task.collectorAuto.skus)existing.set(sku,copy(rows.get(task.id)));}
        for(const [sku,task]of existing)owners.set(`${accountId}:${sku}`,task.id);
        return {owners:existing,createdTaskIds:prepared.map(task=>task.id)};
      };
      const result=writes.then(execute);writes=result.catch(()=>{});return result;
    },
  };
  const service=createAiListingService({repository,loadSources:loadSources|| (async({accountId,collectItemIds})=>collectItemIds.map(id=>copy(sources.get(`${accountId}:${id}`))).filter(Boolean))});
  function request(runId,id,skus,extra={}){return service.createFromCollectorRun({accountId:'a',runId,config,
    groups:[{groupId:'group',source:'ozon',collectItemId:id,skus,legacyCollectItemIds:[]}],...extra});}
  return {service,repository,sources,request};
}

test('automatic collection across runs and merged groups creates work only for new SKUs',async()=>{
  const f=fixture();f.sources.set('a:old',source('old',['101','102']));
  const first=await f.request('run-1','old',['101','102']);
  const original=copy(f.repository.rows.get(first.tasks[0].id));
  f.sources.set('a:new-root',source('new-root',['101','102','103']));
  const second=await f.request('run-2','new-root',['101','102','103'],{config:{...config,stock:9}});
  assert.equal(f.repository.rows.size,2);
  assert.deepEqual(second.results[0].reusedTaskIds,[first.tasks[0].id]);
  const added=second.tasks.find(task=>second.results[0].createdTaskIds.includes(task.id));
  assert.deepEqual(added.images.map(image=>image.sku),['103']);assert.equal(added.config.stock,9);
  assert.deepEqual(f.repository.rows.get(first.tasks[0].id),original);
  const replay=await f.request('run-2','new-root',['101','102','103']);
  assert.equal(f.repository.rows.size,2);assert.deepEqual(replay.results[0].createdTaskIds,[]);
});

test('historical failed, cancelled and waiting tasks retain successful images and state without source or channel validation',async()=>{
  for(const status of ['GENERATION_FAILED','CANCELLED','SUBMISSION_UNCERTAIN','COLLECTING']){
    const f=fixture();f.sources.set('a:old',source('old',['101']));
    const [task]=await f.service.createFromCollect({accountId:'a',collectItemIds:['old'],idempotencyKey:'manual-old',config});
    const stored=f.repository.rows.get(task.id);stored.status=status;
    stored.images[0].generatedUrl='https://generated.example/success.png';
    if(status==='COLLECTING'){stored.collectWait={selectedSkus:['101'],initialSource:stored.source};stored.source=null;stored.images=[];}
    const before=copy(stored);f.sources.clear();
    const result=await f.service.createFromCollectorRun({accountId:'a',runId:'new-run',config:{},
      groups:[{groupId:'different-group',collectItemId:'new-root',skus:['101']}]},{beforeCreate:()=>assert.fail('reused tasks require no new configuration')});
    assert.deepEqual(result.results[0].reusedTaskIds,[task.id]);assert.deepEqual(result.errors,[]);
    assert.deepEqual(f.repository.rows.get(task.id),before);
  }
});

test('a group larger than 100 SKUs keeps every SKU and reports all tasks through one source receipt',async()=>{
  const f=fixture(),skus=Array.from({length:205},(_,index)=>String(1000+index));f.sources.set('a:c',source('c',skus));
  const result=await f.request('run','c',skus);
  assert.equal(result.results.length,1);assert.equal(result.tasks.length,3);
  assert.deepEqual(result.tasks.map(task=>task.images.length),[100,100,5]);
  assert.deepEqual(result.tasks.flatMap(task=>task.images.map(image=>image.sku)).sort(),skus.sort());
});

test('parallel automatic calls share owners while another account and explicit manual generation remain independent',async()=>{
  const f=fixture();for(const accountId of ['a','b'])f.sources.set(`${accountId}:c`,source('c',['101','102']));
  const [one,two]=await Promise.all([f.request('run-1','c',['101','102']),f.request('run-2','c',['101','102'])]);
  assert.deepEqual(one.tasks.map(task=>task.id),two.tasks.map(task=>task.id));assert.equal(f.repository.rows.size,1);
  await f.request('other','c',['101','102'],{accountId:'b'});assert.equal(f.repository.rows.size,2);
  await f.service.createFromCollect({accountId:'a',collectItemIds:['c'],config,idempotencyKey:'explicit-new-images'});
  assert.equal(f.repository.rows.size,3);
});

test('a source preparation error preserves reused tasks and lets another product start',async()=>{
  const f=fixture();f.sources.set('a:old',source('old',['101']));const first=await f.request('old-run','old',['101']);
  f.sources.set('a:bad',source('bad',['101','102']));f.sources.get('a:bad').items[1].images=[];
  f.sources.set('a:good',source('good',['201']));
  const result=await f.service.createFromCollectorRun({accountId:'a',runId:'run',config,groups:[
    {groupId:'g1',collectItemId:'bad',skus:['101','102']},{groupId:'g2',collectItemId:'good',skus:['201']},
  ]});
  assert.deepEqual(result.results[0].reusedTaskIds,[first.tasks[0].id]);
  assert.deepEqual(result.errors.map(error=>({id:error.collectItemId,skus:error.skus,definite:error.definitelyNotCreated})),[{id:'bad',skus:['102'],definite:true}]);
  assert.deepEqual(result.tasks.flatMap(task=>task.images.map(image=>image.sku)).sort(),['101','201']);
});

function collectRecord(skus) {
  const variants=skus.map(sku=>({sku,name:`Товар ${sku}`,images:[`https://source.example/${sku}.png`],price:'15.00',priceCurrency:'CNY',
    packageWeight:100,packageLength:100,packageWidth:100,packageHeight:100}));
  return {id:'group',source:'ozon',sku:skus[0],name:'Товар',images:variants[0].images,variantData:{variants},
    listingDraft:{sku:skus[0],currencyCode:'CNY',price:'15.00',variants:copy(variants)}};
}

test('real collect loader and production listing builder allow 101 and 200 SKU groups to split without truncation',async()=>{
  for(const count of [101,200]){
    const skus=Array.from({length:count},(_,index)=>String(1000+index)),record=collectRecord(skus),before=copy(record);
    const f=fixture({loadSources:input=>loadAiListingCollectSources({...input,pool:{query:async()=>({rows:[]})},
      readCollectItems:async()=>[record],buildListingItems:testExports.buildCollectBoxListingItems})});
    const result=await f.request('run','group',skus);
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.tasks.map(task=>task.images.length),count===101?[100,1]:[100,100]);
    assert.deepEqual(new Set(result.tasks.flatMap(task=>task.images.map(image=>image.sku))),new Set(skus));
    assert.deepEqual(record,before);
  }
});

test('removed or directly listed siblings are reported individually while a new available sibling starts',async()=>{
  for(const reason of ['removed','listed']){
    const record=collectRecord(['101','102','103']);
    if(reason==='removed')record.listingDraft.variants=record.listingDraft.variants.filter(variant=>variant.sku!=='102');
    const before=copy(record);
    const f=fixture({loadSources:input=>loadAiListingCollectSources({...input,pool:{query:async sql=>({rows:
      sql.includes('FROM submission_items')&&reason==='listed'?[{sku:'102'}]:[]})},
      readCollectItems:async()=>[record],buildListingItems:testExports.buildCollectBoxListingItems})});
    const first=await f.request('run-1','group',['101']);
    const result=await f.request('run-2','group',['101','102','103']);
    assert.deepEqual(result.results[0].reusedTaskIds,[first.tasks[0].id],reason);
    assert.deepEqual(result.tasks.find(task=>result.results[0].createdTaskIds.includes(task.id))?.images.map(image=>image.sku),['103'],reason);
    assert.deepEqual(result.errors.map(error=>error.skus),[['102']],reason);assert.deepEqual(record,before,reason);
    assert.equal([...f.repository.rows.values()].some(task=>task.images.some(image=>image.sku==='102')),false,reason);
  }
});

test('an automatic source from another platform cannot receive Ozon SKU ownership',async()=>{
  const f=fixture();f.sources.set('a:c',{...source('c',['101']),sourceSnapshot:{source:'1688'}});
  const result=await f.request('run','c',['101']);
  assert.equal(f.repository.rows.size,0);assert.equal(result.errors[0].code,'AI_LISTING_SOURCE_PLATFORM_MISMATCH');
});

test('one group receipt preserves independent edited drafts and each task keeps its actual source for Seller refresh',async()=>{
  for(const reuseB of [false,true]){
    const f=fixture();f.sources.set('a:draft-a',source('draft-a',['101','103']));
    const b=source('draft-b',['102']);b.items[0].listingItem.name='Сохраненное ручное название';
    b.items[0].images=['https://source.example/manually-selected-b.png'];
    if(!reuseB)b.enrichmentJobs=[{sku:'102',status:'PENDING'}];
    f.sources.set('a:draft-b',b);let previous;
    if(reuseB){
      [previous]=await f.service.createFromCollect({accountId:'a',collectItemIds:['draft-b'],config,idempotencyKey:'previous-b'});
      f.repository.rows.get(previous.id).images[0].generatedUrl='https://generated.example/success-b.png';
      f.repository.rows.get(previous.id).status='GENERATION_FAILED';
    }
    const result=await f.service.createFromCollectorRun({accountId:'a',runId:'group-run',config,groups:[{
      groupId:'durable-group',collectItemId:'draft-a',skus:['101','102','103'],sources:[
        {collectItemId:'draft-a',skus:['101','103']},{collectItemId:'draft-b',skus:['102']},
      ],
    }]});
    assert.deepEqual(result.errors,[]);assert.equal(result.results.length,1);assert.equal(result.results[0].collectItemId,'draft-a');
    assert.equal(result.tasks.length,2);assert.equal(result.results[0].createdTaskIds.length,reuseB?1:2);
    const tasks=result.tasks.map(task=>f.repository.rows.get(task.id)),storedB=tasks.find(task=>task.sourceId==='draft-b');
    assert.ok(storedB);assert.equal((storedB.source||storedB.collectWait.initialSource).items[0].listingItem.name,'Сохраненное ручное название');
    assert.deepEqual((storedB.source||storedB.collectWait.initialSource).items[0].images,['https://source.example/manually-selected-b.png']);
    assert.deepEqual(tasks.find(task=>task.sourceId==='draft-a').source.items.map(item=>item.sku),['101','103']);
    if(reuseB){assert.deepEqual(result.results[0].reusedTaskIds,[previous.id]);assert.equal(storedB.status,'GENERATION_FAILED');assert.equal(storedB.images[0].generatedUrl,'https://generated.example/success-b.png');}
    else {assert.equal(storedB.status,'COLLECTING');assert.deepEqual(storedB.collectWait.selectedSkus,['102']);assert.equal(storedB.collectorAuto.groupId,'durable-group');}
  }
});

test('independent drafts in one captured group keep the primary model without replacing manual models or other SKU facts',async()=>{
  const f=fixture(),primary=source('primary',['201']),silver=source('silver',['101']),manual=source('manual',['301']);
  for(const row of [primary,silver,manual])row.items[0].listingItem.scraped_model_name=row.sku;
  manual.items[0].listingItem.scraped_model_name='Ручная отдельная модель';
  silver.items[0].listingItem.name='Серебристый G03-1';silver.items[0].listingItem.attributes=[{id:10096,values:[{value:'серебристый'}]}];
  for(const row of [primary,silver,manual])f.sources.set('a:'+row.collectItemId,row);
  const before=copy([...f.sources]);
  const result=await f.service.createFromCollectorRun({accountId:'a',runId:'run',config,groups:[{
    groupId:'captured-family',collectItemId:'primary',skus:['101','201','301'],sources:[
      {collectItemId:'silver',skus:['101']},{collectItemId:'manual',skus:['301']},{collectItemId:'primary',skus:['201']},
    ],
  }]});
  assert.deepEqual(result.errors,[]);
  const stored=[...f.repository.rows.values()],item=id=>stored.find(t=>t.sourceId===id).source.items[0];
  assert.equal(item('silver').listingItem.scraped_model_name,'201');
  assert.equal(item('primary').listingItem.scraped_model_name,'201');
  assert.equal(item('manual').listingItem.scraped_model_name,'Ручная отдельная модель');
  assert.deepEqual(item('silver'),{...copy(silver.items[0]),listingItem:{...silver.items[0].listingItem,scraped_model_name:'201'}});
  assert.deepEqual([...f.sources],before);
});

test('new siblings keep the existing automatic group model even when its old draft is no longer loaded',async()=>{
  const f=fixture(),old=source('old',['101']);old.items[0].listingItem.scraped_model_name='101';f.sources.set('a:old',old);
  const first=await f.request('run-1','old',['101']),before=copy(f.repository.rows.get(first.tasks[0].id));
  const added=source('new',['102']);added.items[0].listingItem.scraped_model_name='102';f.sources.clear();f.sources.set('a:new',added);
  const next=await f.request('run-2','new',['101','102']);
  assert.deepEqual(next.errors,[]);
  const created=f.repository.rows.get(next.results[0].createdTaskIds[0]);
  assert.equal(created.source.items[0].listingItem.scraped_model_name,'101');
  assert.deepEqual(f.repository.rows.get(first.tasks[0].id),before);
});

test('a concurrent later handoff uses the group owner created after its initial source read',async()=>{
  const f=fixture();
  for(const [id,sku] of [['old','101'],['new','102']]){
    const row=source(id,[sku]);row.items[0].listingItem.scraped_model_name=sku;f.sources.set('a:'+id,row);
  }
  const [first,later]=await Promise.all([f.request('one','old',['101']),f.request('two','new',['101','102'])]);
  assert.deepEqual(later.results[0].reusedTaskIds,[first.tasks[0].id]);
  assert.equal(f.repository.rows.get(later.results[0].createdTaskIds[0]).source.items[0].listingItem.scraped_model_name,'101');
});

test('a trusted group can continue its same-store historical owner model without automatic metadata',async()=>{
  const f=fixture();const old=source('old',['101']);old.items[0].listingItem.scraped_model_name='101';f.sources.set('a:old',old);
  const [created]=await f.service.createFromCollect({accountId:'a',collectItemIds:['old'],config,idempotencyKey:'historical-model'});
  const previous=copy(f.repository.rows.get(created.id));f.sources.delete('a:old');
  const added=source('new',['102']);added.items[0].listingItem.scraped_model_name='102';f.sources.set('a:new',added);
  const result=await f.request('later','old',['101','102'],{groups:[{groupId:'same-family',collectItemId:'old',skus:['101','102'],sources:[
    {collectItemId:'old',skus:['101']},{collectItemId:'new',skus:['102']},
  ]}]});
  assert.equal(f.repository.rows.get(result.results[0].createdTaskIds[0]).source.items[0].listingItem.scraped_model_name,'101');
  assert.deepEqual(f.repository.rows.get(created.id),previous);
});

test('existing owners in a different store or explicitly different group do not supply the new group model',async()=>{
  for(const boundary of ['store','group']){
    const f=fixture();const old=source('old',['101']);old.items[0].listingItem.scraped_model_name='101';f.sources.set('a:old',old);
    await f.request('old','old',['101'],boundary==='store'?{config:{...config,targetStoreId:'other-store'}}:{});
    const added=source('new',['102']);added.items[0].listingItem.scraped_model_name='102';f.sources.set('a:new',added);
    const result=await f.request('later','new',['101','102'],{groups:[{groupId:boundary==='group'?'other-group':'group',collectItemId:'new',skus:['101','102']}]});
    assert.equal(f.repository.rows.get(result.results[0].createdTaskIds[0]).source.items[0].listingItem.scraped_model_name,'102');
  }
});
