import test from 'node:test';
import assert from 'node:assert/strict';
import {localStatePathForPage, pageStateNeedsLoading} from '../src/local-runtime-state.js';
import * as pageState from '../src/ai-listing-page-state.js';

test('history opens without downloading unrelated catalog and collection payloads',()=>{
  assert.equal(localStatePathForPage('/ozon/products/import-history/'),'/local/state?view=bootstrap');
  assert.equal(localStatePathForPage('/ozon/products/stocks/'),'/local/state');
});

test('product catalog opens lightweight bootstrap and loads its own page',()=>{
  const productsView=localStatePathForPage('/ozon/products/list/');
  assert.equal(productsView,'/local/state?view=bootstrap');
  assert.equal(pageStateNeedsLoading(productsView,'/local/state?view=bootstrap'),false);
  assert.equal(pageStateNeedsLoading(productsView,productsView),false);
  assert.equal(pageStateNeedsLoading('/local/state?view=bootstrap',''),false);
  assert.equal(pageStateNeedsLoading('/local/state','/local/state?view=bootstrap'),true);
  assert.equal(pageStateNeedsLoading('/local/state?view=bootstrap&collectIds=one','/local/state?view=bootstrap'),true);
});

test('template list uses the templates already included in bootstrap',()=>{
  assert.equal(localStatePathForPage('/ozon/templates/'),'/local/state?view=bootstrap');
});

test('collection list loads summaries separately and editing or AI selection requests only selected details',()=>{
  assert.equal(localStatePathForPage('/ozon/products/collect/'),'/local/state?view=bootstrap');
  assert.equal(localStatePathForPage('/ozon/products/collect/edit/','?id=one'),'/local/state?view=bootstrap&collectIds=one');
  assert.equal(localStatePathForPage('/ozon/tools/ai-listing/','?ids=one,two'),'/local/state?view=bootstrap&collectIds=one&collectIds=two');
});

test('polling stays responsive for active visible tasks and slows idle or hidden pages',()=>{
  assert.equal(pageState.aiListingPollDelay({visible:true,activeTab:'tasks',activeCount:2}),3000);
  assert.equal(pageState.aiListingPollDelay({visible:true,activeTab:'tasks',activeCount:0}),30000);
  assert.equal(pageState.aiListingPollDelay({visible:true,activeTab:'create',activeCount:10}),30000);
  assert.equal(pageState.aiListingPollDelay({visible:false,activeTab:'tasks',activeCount:10}),60000);
});

test('poll scheduler evaluates current visibility and activity after request completes',async()=>{
  let idle=false,finish;const scheduled=[];
  const stop=pageState.startAiListingPolling({load:()=>new Promise(r=>{finish=r;}),getInterval:()=>idle?60000:3000,
    setTimeoutFn:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},clearTimeoutFn:()=>{}});
  idle=true;finish();await new Promise(setImmediate);
  assert.equal(scheduled[0].ms,60000);stop();
});

test('full task detail slows after a terminal result or when the document is hidden',()=>{
  assert.equal(pageState.aiListingDetailPollDelay({status:'GENERATING'},true),3000);
  assert.equal(pageState.aiListingDetailPollDelay({status:'SUBMISSION_FAILED'},true),30000);
  assert.equal(pageState.aiListingDetailPollDelay({status:'COMPLETED'},true),30000);
  assert.equal(pageState.aiListingDetailPollDelay({status:'GENERATING'},false),60000);
});

test('deleted tasks expose only server-authorized restoration and do not imply automatic continuation',()=>{
  const task={status:'SUBMISSION_FAILED',deletedAt:123,taskActions:{retry:true,resume:true,delete:true}};
  const status=pageState.aiListingTaskStatus(task);
  assert.equal(status.label,'已删除');assert.match(status.description,/不会自动/);assert.match(status.description,/手动/);
  assert.equal(pageState.aiListingTaskActions(task).resume,true);
  assert.equal(pageState.aiListingTaskActions(task).retry,false);
  assert.equal(pageState.aiListingTaskActions({...task,taskActions:{resume:false}}).resume,false);
  assert.equal(pageState.aiListingTaskActions({...task,taskActions:undefined}).resume,false);
  assert.equal(pageState.aiListingDetailPollDelay({...task,status:'GENERATING'},true),30000);
});

test('home and root entry use bootstrap, with business counts loaded by the scoped summary endpoint',()=>{
 for(const route of ['/', '/login', '/ozon/dashboard/'])assert.equal(localStatePathForPage(route),'/local/state?view=bootstrap');
});
