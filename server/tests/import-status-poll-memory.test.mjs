import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {activeStore} from '../account-context.mjs';
import {createJsonStateTransactionBoundary} from '../json-state-transaction.mjs';

// Execute the actual polling functions without starting the HTTP server,
// database migrations, Ozon clients or unrelated runtime workers.
const source=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');
const pollSource=source.slice(source.indexOf('function normalizeImportTaskStatus('),source.indexOf('\nfunction publicImportTask('));

function harness({jobs={},response={result:{items:[{status:'imported'}]}},apiError=null}={}) {
  const light={currentAccountId:'account-a',accounts:[{id:'account-a'}],stores:[{id:'store-a',ownerAccountId:'account-a',status:'active'}],jobs:structuredClone(jobs),caches:{collectBox:[]}};
  const full={...structuredClone(light),caches:{collectBox:[{id:'item-a',accountId:'account-a',storeId:'store-a',status:'上架中',images:['kept.jpg'],videos:['kept.mp4']}]}};
  const reads=[],saved=[],calls=[],scheduled=[];
  const deps={activeStore,lifecycle:{stopping:false},process:{env:{}},console,
    jsonStateTransaction:createJsonStateTransactionBoundary({enabled:()=>false}),
    loadState:async(options={})=>{reads.push(options.hydrateCatalog!==false);return options.hydrateCatalog===false?light:full;},
    saveState:async state=>{saved.push(structuredClone(state));},
    callOzonSellerApi:async(store,path,body)=>{calls.push({storeId:store.id,path,body});if(apiError)throw apiError;return response;},
    setTimeout:(_callback,delay)=>{scheduled.push(delay);return{unref(){}};},
  };
  const poll=new Function('deps',`const {${Object.keys(deps).join(',')}}=deps;${pollSource};return runPendingImportStatusPolls;`)(deps);
  return{poll,reads,saved,calls,scheduled};
}

const legacyJob={id:'legacy-a',listing:true,accountId:'account-a',storeId:'store-a',collectBoxId:'item-a',ozonTaskId:'123',status:'RUNNING'};

test('idle legacy import polling does not hydrate the unrelated catalog',async()=>{
  const h=harness();await h.poll();
  assert.deepEqual(h.reads,[false],'startup polling must inspect lightweight state before loading catalog data');
  assert.equal(h.saved.length,0);assert.equal(h.calls.length,0);assert.equal(h.scheduled.length,0);
});

test('V3 jobs never make the legacy poller hydrate catalog or contact Ozon',async()=>{
  const h=harness({jobs:{v3:{...legacyJob,id:'v3',pipelineVersion:'v3'}}});await h.poll();
  assert.deepEqual(h.reads,[false]);assert.equal(h.saved.length,0);assert.equal(h.calls.length,0);
});

test('pending legacy import retains its product status update and existing media',async()=>{
  const h=harness({jobs:{'legacy-a':legacyJob}});await h.poll();
  assert.deepEqual(h.calls,[{storeId:'store-a',path:'/v1/product/import/info',body:{task_id:123}}]);
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].jobs['legacy-a'].status,'SUCCESS');
  assert.equal(h.saved[0].caches.collectBox[0].status,'已上架');
  assert.deepEqual(h.saved[0].caches.collectBox[0].images,['kept.jpg']);
  assert.deepEqual(h.saved[0].caches.collectBox[0].videos,['kept.mp4']);
  assert.equal(h.scheduled.length,0);
});

test('legacy import network failure remains pollable and persists the original error',async()=>{
  const h=harness({jobs:{'legacy-a':legacyJob},apiError:new Error('temporary upstream failure')});await h.poll();
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].jobs['legacy-a'].status,'RUNNING');
  assert.equal(h.saved[0].jobs['legacy-a'].statusCheckError,'temporary upstream failure');
  assert.equal(h.saved[0].jobs['legacy-a'].statusCheckFailures,1);
  assert.equal(h.saved[0].caches.collectBox[0].status,'上架中');assert.deepEqual(h.scheduled,[30000]);
});
