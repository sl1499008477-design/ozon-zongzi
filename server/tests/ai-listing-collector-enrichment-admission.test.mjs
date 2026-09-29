import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiListingService} from '../ai-listing-service.mjs';
import {loadAiListingCollectSources} from '../ai-listing-runtime.mjs';
import {buildCollectBoxListingItems} from '../collect-box-listing-items.mjs';
import {applyAiListingSourceCategorySnapshot,evaluateAiListingSkuPricing} from '../ai-listing-source-facts.mjs';
import {createCollectorRunHandoffWorker} from '../collector-run-handoff.mjs';
import {memoryRepository} from './support/ai-listing-memory-repository.mjs';

const copy=value=>structuredClone(value);
const config={targetStoreId:'store',targetWarehouseId:'warehouse',manualReview:true};
const sku='10001';

function fixture(initialJobStatus) {
  // Persisted public capture has usable media, dimensions and prices; Seller
  // enrichment did not obtain the category, so final collection admission never passed.
  const record={id:'collect-1',source:'ozon',sku,name:'Товар',status:'NEEDS_ATTENTION',
    currencyCode:'CNY',blackPrice:'100.00',greenPrice:'98.00',images:['https://source.test/a.png'],
    enrichment:{status:'NEEDS_ATTENTION',missingFields:['descriptionCategoryId'],lastErrorCode:'ZONGZI_ENRICH_INCOMPLETE'},
    listingDraft:{sku,title:'Товар',currencyCode:'CNY',price:'100.00',images:['https://source.test/a.png'],
      logistics:{weightG:100,lengthMm:100,widthMm:100,heightMm:100}}};
  let jobStatus=initialJobStatus;
  const repository=memoryRepository(),counts={reserves:0,generates:0,prepares:0},prepared=[];
  repository.readCollectorAutomaticOwners=async({accountId,skus})=>new Map([...repository.rows.values()]
    .filter(row=>row.accountId===accountId).flatMap(row=>(row.collectorAuto?.skus||[]).filter(sku=>skus.includes(sku)).map(sku=>[sku,copy(row)])));
  repository.createCollectorAutomatic=async({accountId,skus,prepare})=>{
    const owners=await repository.readCollectorAutomaticOwners({accountId,skus});
    const tasks=await prepare(skus.filter(sku=>!owners.has(sku)),owners);
    for(const task of tasks){const saved=await repository.create(task);for(const sku of saved.collectorAuto.skus)owners.set(sku,saved);}
    return {owners,createdTaskIds:tasks.map(task=>task.id)};
  };
  const loadSources=input=>loadAiListingCollectSources({...input,buildListingItems:buildCollectBoxListingItems,
    readCollectItems:async()=>[copy(record)],pool:{query:async sql=>({rows:sql.includes('FROM collector_ozon_enrichment_jobs')
      ?[{collect_item_id:record.id,sku,status:jobStatus}]:[]})}});
  const service=createAiListingService({repository,clock:()=>1000,loadSources,
    // Same production prepare contract as ai-listing-runtime.mjs. Target store
    // credentials/warehouse validity are already assumed for this local case.
    checkSource:async({source,config,protectedSkus=[]})=>{
      counts.prepares++;
      const result={...applyAiListingSourceCategorySnapshot(source),skuPricing:evaluateAiListingSkuPricing({source,config,store:{currencyCode:'CNY'},protectedSkus})};
      prepared.push(copy(result));return result;
    },
    billing:{reconcile:async input=>{if(input.reserve)counts.reserves++;return {funded:true};}},
    generateImage:async()=>{counts.generates++;return {generatedUrl:'https://generated.test/a.png'};},
    submitListing:async()=>assert.fail('manual review prevents submission'),
  });
  let claimed=false,handoffState;
  const handoff=createCollectorRunHandoffWorker({
    repository:{claim:async()=>claimed?null:(claimed=true,{runId:'run-1',accountId:'account-1',body:{receipts:{}}}),
      save:async(row,body,status)=>{handoffState={status,body:copy(body)};return true;}},
    readRun:async()=>({status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}),
    listItems:async()=>[{id:'collector-item-1',status:'QUALIFIED'}],
    addSelected:async()=>({results:[{collectorItemId:'collector-item-1',collectItemId:record.id}]}),
    createTasks:input=>service.createFromCollectorRun({...input,config,groups:[{groupId:'group-1',collectItemId:record.id,skus:[sku]}]}),
  });
  return {service,repository,counts,prepared,handoff,setJobStatus:status=>{jobStatus=status;},getHandoff:()=>handoffState};
}

test('automatic handoff must not bill or generate when new collection enrichment failed before AI creation',async()=>{
  const env=fixture('FAILED');await env.handoff.tick();
  const created=[...env.repository.rows.values()][0];
  const outcome=await env.service.processNext();
  const evidence={createdStatus:created?.status,finalStatus:outcome?.status,handoff:env.getHandoff()?.status,
    category:env.prepared[0]?.items[0]?.listingItem?.description_category_id,
    admission:env.prepared[0]?.sourceSnapshot?.collectionAdmission,
    pricing:env.prepared[0]?.skuPricing,counts:env.counts};
  assert.equal(env.counts.generates,0,JSON.stringify(evidence));
  assert.equal(env.counts.reserves,0,JSON.stringify(evidence));
  assert.equal(env.repository.rows.size,0);
  assert.equal(env.getHandoff().body.receipts['collector-item-1'].error.code,'AI_LISTING_ENRICHMENT_FAILED');
});

test('an automatic task already waiting for enrichment stops before paid work when Seller job fails',async()=>{
  const env=fixture('PENDING');await env.handoff.tick();
  assert.equal([...env.repository.rows.values()][0].status,'COLLECTING');
  env.setJobStatus('FAILED');
  const outcome=await env.service.processNext();
  assert.equal(outcome.status,'COLLECTION_FAILED');
  assert.deepEqual(env.counts,{reserves:0,generates:0,prepares:0});
});
