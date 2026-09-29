import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {submissionStockRequestHashV3} from '../listing-pipeline.mjs';

const source=readFileSync(new URL('../listing-worker.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function finishSuccessfulImport(');
const finishSource=source.slice(start,source.indexOf('\nasync function processCheck(',start));

function harness({count=2,ready=true,capacity={allowed:true},stockResponse,initialJournal,readinessError,readinessProducts}={}) {
  const stocks=Array.from({length:count},(_,i)=>({offer_id:`offer-${String(i).padStart(3,'0')}`,warehouse_id:'warehouse-1',stock:5}));
  const work={id:'job-1',account_id:'account-1',snapshot_id:'snapshot-1',store_id:'store-1',ozon_task_id:'123',correlation_id:'corr-1',stocks,
    submissionItems:stocks.map((s,i)=>({offerId:s.offer_id,submissionItemId:`item-${i}`})),result_summary:{}};
  const info={status:'SUCCEEDED',success:count,failed:0,skipped:0,items:stocks.map(s=>({offerId:s.offer_id,status:'SUCCEEDED'}))};
  const calls={api:[],capacity:[],begin:[],transitions:[],enqueue:[]};const journal=new Map();const resolved=new Map();let uuid=0;
  const deps={
    workerId:'fixture-worker',crypto:{randomUUID:()=>`uuid-${++uuid}`},submissionStockRequestHashV3,
    getPostgresPool:async()=>({fixture:true,query:async()=>({rows:initialJournal?[{status:initialJournal}]:[]})}),
    reserveOzonWriteCapacity:async command=>{calls.capacity.push(command);return typeof capacity==='function'?capacity(calls.capacity.length):capacity},
    prepareSubmissionStockWriteV3:async command=>{
      if(!journal.has(command.requestHash))journal.set(command.requestHash,initialJournal||'PREPARED');
      return {status:journal.get(command.requestHash)};
    },
    resolveSubmissionStockResponseV3:async(command,summary)=>{journal.set(command.requestHash,'RESOLVED');resolved.set(command.requestHash,summary.stockResults.filter(r=>command.stocks.some(s=>s.offerId===r.offerId&&s.warehouseId===r.warehouseId)));work.result_summary=summary;return {status:'RESOLVED'}},
    readResolvedStockResponseV3:async command=>resolved.get(command.requestHash)||[],
    reprepareResolvedStockWriteV3:async command=>{journal.set(command.requestHash,'PREPARED');return {status:'PREPARED'}},
    beginSubmissionStockWriteV3:async command=>{calls.begin.push(command);journal.set(command.requestHash,'IN_FLIGHT');return {status:'IN_FLIGHT'}},
    completeSubmissionStockWriteV3:async command=>{journal.set(command.requestHash,'DONE');return {status:'DONE'}},
    markSubmissionStockWriteAmbiguousV3:async command=>{journal.set(command.requestHash,'AMBIGUOUS');return {status:'AMBIGUOUS'}},
    authorizeListingRfbsWritePhase:async()=>{},readStoreCredentialV3:async()=>({clientId:'seller-shared',apiKey:'fixture-key'}),
    callOzonSellerApi:async(_credential,url,body)=>{
      calls.api.push({url,body});
      if(url==='/v3/product/info/list' && readinessError){const error=readinessError;readinessError=null;throw error;}
      if(url==='/v3/product/info/list' && readinessProducts)return {items:readinessProducts(body.offer_id)};
      if(url==='/v3/product/info/list')return {items:body.offer_id.map(offer_id=>({offer_id,statuses:{status:ready?'price_sent':'processing'}}))};
      if(url==='/v2/products/stocks')return stockResponse?stockResponse(body.stocks):{result:body.stocks.map(s=>({...s,updated:true,errors:[]}))};
      throw Error('unexpected endpoint '+url);
    },
    transitionSubmissionJobV3:async(_id,status,patch)=>{calls.transitions.push({status,patch});work.result_summary=patch.resultSummary||work.result_summary;return {status}},
    enqueueSubmissionActionV3:async(...args)=>{calls.enqueue.push(args)},patchLegacyCollectStatusV3:async()=>{},collectPatch:()=>({}),
  };
  const finish=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;${finishSource};return finishSuccessfulImport;`)(deps);
  return {work,info,calls,journal,finish};
}

const stockCalls=h=>h.calls.api.filter(c=>c.url==='/v2/products/stocks');
const last=h=>h.calls.transitions.at(-1);

test('stock capacity waiting queues STATUS_CHECK without beginning a write or failing the job',async()=>{
 const h=harness({capacity:{allowed:false,retryAfterMs:31000}});await h.finish(h.work,h.info);
 assert.equal(last(h).status,'CHECKING');assert.equal(h.calls.begin.length,0);assert.equal(stockCalls(h).length,0);
 assert.equal(h.calls.enqueue[0][1],'check');assert.ok(h.calls.enqueue[0][2]>=31);
 assert.deepEqual([...h.journal.values()],['PREPARED']);
});

test('official price_sent readiness precedes stock capacity reservation and begin',async()=>{
 const h=harness({ready:false});await h.finish(h.work,h.info);
 assert.equal(last(h).status,'CHECKING');assert.equal(h.calls.capacity.length,0);assert.equal(h.calls.begin.length,0);
 assert.equal(stockCalls(h).length,0);assert.equal(h.calls.api[0].url,'/v3/product/info/list');
});

test('partial import writes only successful SKU inventory',async()=>{
 const h=harness();h.info.status='PARTIAL_SUCCESS';h.info.success=1;h.info.failed=1;h.info.items[1].status='FAILED';
 await h.finish(h.work,h.info);
 assert.equal(stockCalls(h).length,1);assert.deepEqual(stockCalls(h)[0].body.stocks,[h.work.stocks[0]]);
 assert.equal(last(h).status,'PARTIAL_SUCCESS');assert.equal(last(h).patch.resultSummary.stockSuccessCount,1);
});

test('stock batches are at most 100 and share seller capacity; DONE journals replay without writes',async()=>{
 const h=harness({count:101});await h.finish(h.work,h.info);
 assert.deepEqual(stockCalls(h).map(c=>c.body.stocks.length),[100,1]);
 assert.equal(h.calls.capacity.length,2);
 for(const reservation of h.calls.capacity){assert.equal(reservation.sellerId,'seller-shared');assert.equal(reservation.operation,'stock');assert.equal(reservation.limit,80);assert.equal(reservation.units,1);assert.equal(typeof reservation.clock,'function');}
 assert.notEqual(h.calls.capacity[0].requestKey,h.calls.capacity[1].requestKey);
 assert.equal(h.calls.capacity[0].pairKeys.length,100);
 await h.finish(h.work,h.info);assert.equal(stockCalls(h).length,2);assert.equal(h.calls.capacity.length,2);
 assert.equal(last(h).status,'SUCCEEDED');
});

test('HTTP200 per-item rejection preserves successful rows and never marks the whole batch DONE',async()=>{
 const h=harness({stockResponse:stocks=>({result:stocks.map((s,i)=>({...s,updated:i===0,errors:i?[{code:'INVALID_STOCK',message:'fixture rejection'}]:[]}))})});
 await h.finish(h.work,h.info);
 assert.equal(last(h).status,'PARTIAL_SUCCESS');
 const outcomes=last(h).patch.resultSummary.stockResults;
 assert.deepEqual(outcomes.map(r=>r.status),['SUCCEEDED','FAILED']);assert.deepEqual(outcomes[1].errors,['INVALID_STOCK']);
 assert.deepEqual([...h.journal.values()],['RESOLVED']);
 await h.finish(h.work,h.info);assert.equal(stockCalls(h).length,1);
 assert.equal(last(h).patch.resultSummary.stockResults[0].status,'SUCCEEDED');
});

test('an in-flight stock journal is treated as ambiguous after restart, without resending',async()=>{
 const h=harness({initialJournal:'IN_FLIGHT'});await h.finish(h.work,h.info);
 assert.equal(stockCalls(h).length,0);assert.equal(h.calls.capacity.length,0);assert.deepEqual([...h.journal.values()],['AMBIGUOUS']);
 assert.equal(last(h).status,'PARTIAL_SUCCESS');
});

test('capacity wait after a completed batch preserves its successes and resumes only the next batch',async()=>{
 const h=harness({count:101,capacity:call=>({allowed:call!==2,retryAfterMs:60000})});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'CHECKING');assert.equal(last(h).patch.resultSummary.stockSuccessCount,100);
 await h.finish(h.work,h.info);assert.deepEqual(stockCalls(h).map(c=>c.body.stocks.length),[100,1]);assert.equal(last(h).status,'SUCCEEDED');
});


test('pre-upgrade whole-snapshot IN_FLIGHT journal blocks new smaller batches',async()=>{
 const h=harness({count:101,initialJournal:'IN_FLIGHT'});await h.finish(h.work,h.info);
 assert.equal(stockCalls(h).length,0);assert.equal(h.calls.capacity.length,0);
 assert.equal(last(h).status,'PARTIAL_SUCCESS');assert.equal(last(h).patch.resultSummary.stockResults.length,101);
});

for (const error of [
  Object.assign(new Error('rate limited'), {status:429}),
  Object.assign(new Error('upstream unavailable'), {status:503}),
  Object.assign(new Error('timed out'), {code:'ZONGZI_TIMEOUT'}),
  Object.assign(new Error('connection lost'), {code:'ZONGZI_NETWORK_ERROR'}),
]) test(`temporary read-only stock readiness failure queues a safe retry: ${error.code || error.status}`,async()=>{
 const h=harness({readinessError:error});await h.finish(h.work,h.info);
 assert.equal(last(h).status,'CHECKING');assert.equal(h.calls.begin.length,0);assert.equal(stockCalls(h).length,0);
 assert.equal(h.calls.capacity.length,0);assert.equal(h.calls.enqueue[0][1],'check');
 assert.deepEqual([...h.journal.values()],['PREPARED']);
 await h.finish(h.work,h.info);assert.equal(stockCalls(h).length,1);assert.equal(last(h).status,'SUCCEEDED');
});
test('permanent readiness authorization rejection does not enqueue an infinite retry',async()=>{
 const h=harness({readinessError:Object.assign(new Error('forbidden'),{status:403})});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'PARTIAL_SUCCESS');assert.equal(h.calls.enqueue.length,0);
 assert.equal(stockCalls(h).length,0);assert.deepEqual([...h.journal.values()],['PREPARED']);
});

test('explicit temporary item failure retries only its subset across repeated checks',async()=>{
 let attempt=0;
 const h=harness({stockResponse:stocks=>({result:stocks.map(s=>({...s,updated:s.offer_id.endsWith('000')||attempt++>1,errors:s.offer_id.endsWith('000')||attempt>2?[]:[{code:'PRODUCT_HAS_NOT_BEEN_TAGGED_YET'}]}))})});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'CHECKING');
 assert.deepEqual([...h.journal.values()],['RESOLVED']);
 await h.finish(h.work,h.info);assert.equal(last(h).status,'CHECKING');
 await h.finish(h.work,h.info);assert.equal(last(h).status,'SUCCEEDED');
 assert.deepEqual(stockCalls(h).map(c=>c.body.stocks.map(s=>s.offer_id)),[['offer-000','offer-001'],['offer-001'],['offer-001']]);
});
test('a singleton explicit rate rejection can reuse its hash only after a resolved receipt',async()=>{
 let calls=0;const h=harness({count:1,stockResponse:stocks=>({result:stocks.map(s=>({...s,updated:++calls>1,errors:calls===1?[{code:'TOO_MANY_REQUESTS'}]:[]}))})});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'CHECKING');
 await h.finish(h.work,h.info);assert.equal(last(h).status,'SUCCEEDED');assert.equal(h.journal.size,1);assert.equal(stockCalls(h).length,2);
});
test('missing or contradictory item result remains unknown while known retryable item can recover',async()=>{
 let calls=0;const h=harness({count:3,stockResponse:stocks=>({result:++calls===1?[{...stocks[0],updated:true,errors:[]},{...stocks[1],updated:false,errors:[{code:'TOO_MANY_REQUESTS'}]}]:stocks.map(s=>({...s,updated:true,errors:[]}))})});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'CHECKING');
 await h.finish(h.work,h.info);assert.equal(last(h).status,'PARTIAL_SUCCESS');
 assert.deepEqual(stockCalls(h)[1].body.stocks.map(s=>s.offer_id),['offer-001']);
 assert.equal(last(h).patch.resultSummary.stockResults[2].status,'UNKNOWN');
});

test('immutable resolved receipts restore a lost summary without resending prior successes',async()=>{
 let calls=0;const h=harness({stockResponse:stocks=>({result:stocks.map(s=>({...s,updated:++calls!==2,errors:calls===2?[{code:'TOO_MANY_REQUESTS'}]:[]}))})});
 await h.finish(h.work,h.info);await h.finish(h.work,h.info);assert.equal(last(h).status,'SUCCEEDED');
 h.work.result_summary={};await h.finish(h.work,h.info);
 assert.equal(last(h).status,'SUCCEEDED');assert.deepEqual(stockCalls(h).map(c=>c.body.stocks.length),[2,1]);
});
test('contradictory updated true plus error is unknown, never eligible for retry',async()=>{
 const h=harness({count:1,stockResponse:stocks=>({result:stocks.map(s=>({...s,updated:true,errors:[{code:'TOO_MANY_REQUESTS'}]}))})});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'PARTIAL_SUCCESS');
 assert.equal(last(h).patch.resultSummary.stockResults[0].status,'UNKNOWN');
 await h.finish(h.work,h.info);assert.equal(stockCalls(h).length,1);
});
test('response loss on a retry replaces old retryable evidence with unknown and cannot resend again',async()=>{
 let calls=0;const h=harness({count:1,stockResponse:stocks=>{if(++calls===2)throw Object.assign(new Error('timeout'),{code:'ZONGZI_TIMEOUT'});return {result:stocks.map(s=>({...s,updated:false,errors:[{code:'TOO_MANY_REQUESTS'}]}))}}});
 await h.finish(h.work,h.info);await h.finish(h.work,h.info);
 assert.equal(last(h).status,'PARTIAL_SUCCESS');assert.equal(last(h).patch.resultSummary.stockResults[0].status,'UNKNOWN');
 await h.finish(h.work,h.info);assert.equal(stockCalls(h).length,2);assert.deepEqual([...h.journal.values()],['AMBIGUOUS']);
});

test('official moderation decline ends waiting for that SKU while ready imported SKU still receives stock',async()=>{
 const h=harness({readinessProducts:offers=>offers.map((offer_id,i)=>({offer_id,statuses:i?{status:'price_sent'}:{status:'variant_wait',moderate_status:'declined',status_failed:'declined',is_created:false},errors:i?[]:[{code:'DESCRIPTION_DECLINE',attribute_id:11254,state:'declined',level:'ERROR_LEVEL_ERROR'}]}))});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'PARTIAL_SUCCESS');assert.equal(last(h).patch.successCount,2);
 assert.deepEqual(stockCalls(h)[0].body.stocks.map(s=>s.offer_id),['offer-001']);assert.equal(h.calls.enqueue.length,0);
 const failed=last(h).patch.resultSummary.stockResults.find(r=>r.offerId==='offer-000');assert.equal(failed.status,'FAILED');assert.ok(failed.errors.includes('DESCRIPTION_DECLINE'));
});

test('historical declined edit on an already created price_sent product does not block inventory',async()=>{
 const h=harness({count:1,readinessProducts:offers=>offers.map(offer_id=>({offer_id,statuses:{status:'price_sent',moderate_status:'declined',is_created:true}}))});
 await h.finish(h.work,h.info);assert.equal(last(h).status,'SUCCEEDED');assert.equal(stockCalls(h).length,1);
});

test('real numeric platform warehouse IDs project to canonical journal strings without changing API stock payload',async()=>{
 const h=harness();for(const stock of h.work.stocks){stock.warehouse_id=1020005029861840;stock.stock=0;}
 await h.finish(h.work,h.info);assert.equal(last(h).status,'SUCCEEDED');assert.equal(stockCalls(h).length,1);
 assert.ok(h.calls.begin[0].stocks.every(s=>s.warehouseId==='1020005029861840'));
 assert.ok(stockCalls(h)[0].body.stocks.every(s=>s.warehouse_id===1020005029861840&&s.stock===0));
});
