import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {collectEnrichmentNeedsPolling,collectEnrichmentView,collectWorkflowStatus} from '../../app/src/collect-enrichment-view.js';
import {legacyCollectStatus,projectCollectItemEnrichment} from '../collect-enrichment-summary.mjs';

// Execute the actual persisted-row mapper without starting migrations or a network client.
const source=readFileSync(new URL('../listing-pipeline.mjs',import.meta.url),'utf8');
const start=source.indexOf('    if (!enrichment) return publicItem;');
assert.ok(start>=0,'persisted enrichment projection must exist');
const mapRow=new Function('row','enrichment','publicItem','jobsByItem','projectCollectItemEnrichment',source.slice(start,source.indexOf('\n  });',start)));
const project=(...args)=>mapRow(...args,projectCollectItemEnrichment);
const collectId='collect_22674020e5518c446bf0746a';
const summary={status:'PENDING_ENRICHMENT',missingFields:['weightG'],completedSkus:0,totalSkus:43};
const job=(sku,status,extra={})=>({collect_item_id:collectId,sku,status,attempt_count:0,next_attempt_at:null,claim_expires_at:null,last_error_json:null,error_json:null,...extra});
const projectJobs=(jobs,enrichment=summary)=>project({id:collectId},enrichment,{id:collectId,sku:'2102713933',enrichment,listingDraft:{name:'历史中文资料仍可只读',images:[]}},new Map([[collectId,jobs]]));
// Real diagnostic SKU identities; injected causes are regressions, not a reconstruction of the lost historical errors.
const network={code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'Seller /api/v1/search: net::ERR_CONNECTION_RESET',diagnostic:{stage:'seller_search',upstreamCode:'NETWORK_ERROR',requestSent:true,extensionVersion:'1.0.5'}};
const http={code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'Seller /api/v1/product/import/products: HTTP 429',diagnostic:{stage:'bundle_create',upstreamCode:'HTTP_429',upstreamStatus:429,requestSent:true,extensionVersion:'1.0.5'}};

test('legacy public COLLECTED rows join the pending filter without changing enrichment states',()=>{
 assert.equal(legacyCollectStatus('COLLECTED'),'待处理');
 for(const [status,want] of [['SUCCEEDED','已上架'],['FAILED','失败'],['COMPLETE','COMPLETE'],['NEEDS_ATTENTION','NEEDS_ATTENTION']]) {
  assert.equal(legacyCollectStatus(status),want);
 }
 for(const [status,want] of [['PENDING_ENRICHMENT','待处理'],['NEEDS_ATTENTION','待处理'],['COMPLETE','待处理'],['COLLECTION_FAILED','失败']]) {
  const enrichment={status,missingFields:['weightG']};
  const item={status:legacyCollectStatus('COLLECTED'),enrichment};
  assert.equal(collectWorkflowStatus(item),want);
  assert.deepEqual(item.enrichment,{status,missingFields:['weightG']});
 }
});

test('FAILED SKUs remain visible alongside pending and processing siblings with distinct original causes',()=>{
 const jobs=[job('2102713933','PENDING'),job('2102714396','PROCESSING',{claim_expires_at:'2099-01-01T00:00:00Z'}),job('2102713588','FAILED',{attempt_count:3,last_error_json:network,error_json:{code:'ZONGZI_ENRICH_RETRY_EXHAUSTED',message:'自动重试已用尽'}}),job('2102713769','FAILED',{attempt_count:2,error_json:http}),job('2102714113','SUCCESS',{last_error_json:network})];
 const before=structuredClone(jobs);
 const item=projectJobs(jobs);
 assert.equal(item.enrichment.status,'NEEDS_ATTENTION');
 assert.equal(item.enrichment.executionState,'FAILED');
 assert.equal(item.enrichment.hasActiveJobs,true);
 assert.equal(item.enrichment.completedSkus,1);
 assert.equal(item.enrichment.totalSkus,5);
 assert.deepEqual(item.enrichment.missingSkus,['2102713933','2102714396','2102713588','2102713769']);
 assert.deepEqual(item.enrichment.failures,[{sku:'2102713588',status:'FAILED',...network},{sku:'2102713769',status:'FAILED',...http}]);
 assert.equal(item.enrichment.lastErrorCode,network.code);
 assert.equal(item.enrichment.lastErrorMessage,network.message);
 assert.deepEqual(item.enrichment.lastErrorDiagnostic,network.diagnostic);
 assert.deepEqual(jobs,before,'projection must not rewrite persisted jobs');
 assert.equal(item.listingDraft.name,'历史中文资料仍可只读');
 const view=collectEnrichmentView(item.enrichment);
 assert.equal(view.tone,'danger');
 assert.match(view.detail,/2102713588.*seller_search.*NETWORK_ERROR.*ERR_CONNECTION_RESET/);
 assert.match(view.detail,/2102713769.*bundle_create.*HTTP_429.*429/);
 assert.equal(collectEnrichmentNeedsPolling(item.enrichment),true);
});

test('automatic retry retains that SKU last failure without making it a terminal failure',()=>{
 const item=projectJobs([job('2102713588','PENDING',{attempt_count:1,next_attempt_at:'2099-01-01T00:00:00Z',last_error_json:network})]);
 assert.equal(item.enrichment.status,'PENDING_ENRICHMENT');
 assert.equal(item.enrichment.executionState,'PENDING');
 assert.deepEqual(item.enrichment.failures,[{sku:'2102713588',status:'PENDING',...network}]);
 assert.equal(collectEnrichmentView(item.enrichment).retryable,false);
});

test('expired processing claim is waiting for the extension and creates no failure evidence',()=>{
 const item=projectJobs([job('2102714396','PROCESSING',{claim_expires_at:'2000-01-01T00:00:00Z'})]);
 assert.equal(item.enrichment.status,'PENDING_ENRICHMENT');
 assert.equal(item.enrichment.executionState,'WAITING_FOR_EXTENSION');
 assert.deepEqual(item.enrichment.failures,[]);
 assert.equal(item.enrichment.attemptCount,0);
 assert.equal(item.enrichment.hasActiveJobs,true);
 assert.equal(collectEnrichmentView(item.enrichment).label,'等待扩展恢复');
});

test('legacy synthetic expiry failures are recovery waits but actual upstream TIMEOUT remains a failure',()=>{
 const old=projectJobs([job('2102714396','FAILED',{attempt_count:5,last_error_json:{code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'扩展执行超时，未收到补全结果'}})]);
 assert.equal(old.enrichment.status,'PENDING_ENRICHMENT');
 assert.equal(old.enrichment.executionState,'WAITING_FOR_EXTENSION');
 assert.deepEqual(old.enrichment.failures,[]);
 const actual={code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'Seller socket timeout',diagnostic:{stage:'seller_search',upstreamCode:'TIMEOUT',requestSent:true}};
 const failed=projectJobs([job('2102713588','FAILED',{last_error_json:actual})]);
 assert.equal(failed.enrichment.status,'NEEDS_ATTENTION');
 assert.deepEqual(failed.enrichment.failures,[{sku:'2102713588',status:'FAILED',...actual}]);
});

test('legacy missing diagnostics and empty last_error_json do not hide saved terminal errors',()=>{
 const item=projectJobs([job('2102713588','FAILED',{last_error_json:{},error_json:{code:'ZONGZI_ENRICH_NOT_FOUND',message:'SKU 2102713588 was not found'}}),job('2102713769','FAILED')]);
 assert.deepEqual(item.enrichment.failures,[{sku:'2102713588',status:'FAILED',code:'ZONGZI_ENRICH_NOT_FOUND',message:'SKU 2102713588 was not found'},{sku:'2102713769',status:'FAILED',code:'',message:''}]);
 assert.equal(item.enrichment.hasActiveJobs,false);
 assert.match(collectEnrichmentView(item.enrichment).detail,/2102713769.*阶段未记录.*原因未记录/);
});

test('43 successful category/package jobs clear stale failure evidence without claiming media completeness',()=>{
 const jobs=Array.from({length:43},(_,index)=>job(String(2102713500+index),'SUCCESS',{last_error_json:network}));
 const item=projectJobs(jobs,{status:'COMPLETE',missingFields:[],failures:[{sku:'old',...network}],hasActiveJobs:true});
 assert.deepEqual(item.enrichment.failures,[]);
 assert.equal(item.enrichment.hasActiveJobs,false);
 assert.equal(item.enrichment.completedSkus,43);
 assert.equal(item.enrichment.totalSkus,43);
 assert.equal(collectEnrichmentView(item.enrichment).label,'类目与包装已补全');
 assert.match(collectEnrichmentView(item.enrichment).detail,/43\/43/);
 assert.equal(collectEnrichmentNeedsPolling(item.enrichment),false);
});

test('items with no jobs or enrichment keep their existing public shape',()=>{
 const legacy={status:'COMPLETE',missingFields:[]};
 assert.deepEqual(projectJobs([],legacy).enrichment,legacy);
 const item={id:collectId,listingDraft:{name:'legacy'}};
 assert.equal(project({id:collectId},null,item,new Map()),item);
});

test('an already successful SKU with a legacy expiry record never keeps failed siblings polling',()=>{
 const item=projectJobs([
  job('2102714113','SUCCESS',{last_error_json:{code:'ZONGZI_ENRICH_UPSTREAM_FAILED',message:'扩展执行超时，未收到补全结果'}}),
  job('2102713588','FAILED',{last_error_json:network}),
 ]);
 assert.equal(item.enrichment.hasActiveJobs,false);
 assert.equal(item.enrichment.completedSkus,1);
 assert.deepEqual(item.enrichment.failures,[{sku:'2102713588',status:'FAILED',...network}]);
 assert.equal(collectEnrichmentNeedsPolling(item.enrichment),false);
});
