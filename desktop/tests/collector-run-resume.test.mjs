import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const moduleUrl=path=>new URL('../dist-electron/'+path,import.meta.url).href;
function probe(body){
 const directory=mkdtempSync(join(tmpdir(),'collector-resume-'));
 try{
  const script=`
   import assert from 'node:assert/strict';
   import {TaskManager} from ${JSON.stringify(moduleUrl('services/collection/task-manager.services.js'))};
   import {Collection} from ${JSON.stringify(moduleUrl('services/collection/collection.services.js'))};
   import {operationStore} from ${JSON.stringify(moduleUrl('store/index.js'))};
   operationStore.set('token','account-a');
   const calls=[],manager=new TaskManager();manager.maxConcurrentTasks=0;
   const frozen={isUseCategorySelect:1,targetUrl:'https://www.ozon.ru/category/original/',targetCount:5,captureScope:'CURRENT',concurrency:2};
   const run={id:'run-old',taskId:'task',accountId:'account-a',status:'FAILED',configurationSnapshot:{configuration:frozen,concurrency:2},progress:{qualifiedCount:1,failedCount:1,filteredCount:1,totalCount:3}};
   const task={id:'task',name:'原任务',status:'FAILED',currentRunId:run.id,currentRun:run,configuration:{...frozen,targetCount:99,targetUrl:'https://www.ozon.ru/category/edited/'}};
   globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{calls.push(request);
    if(request.url==='/collector/tasks')return{data:{tasks:[task]}};
    if(request.url==='/collector/tasks/task')return{data:{task}};
    if(request.url==='/collector/runs/run-old')return{data:{run}};
    if(request.url==='/collector/runs/run-old/resume'){run.status='QUEUED';return{data:{run}};}
    if(request.url.endsWith('/events')||request.url.endsWith('/cancel-request'))return{data:{ok:true}};
    throw Error('unexpected request '+request.url);
   };
   ${body}
  `;
  const result=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8',timeout:15000,env:{...process.env,DESKTOP_TEST_USER_DATA:directory}});
  assert.equal(result.status,0,result.stderr||result.stdout);
 }finally{rmSync(directory,{recursive:true,force:true});}
}

test('cancel all cancels each queued run and releases its route even if one cancellation request fails',()=>probe(`
 let leases=2;
 for(const id of ['queued-a','queued-b']){
  const c=new Collection({_id:id,taskName:id,taskStatus:'pending'},null);
  c.restoreRun({id,status:'QUEUED'});c.sellerRouteLease={release(){leases--;}};
  manager.tasks.set(id,c);manager.taskQueue.push(id);
 }
 const previous=globalThis.__DESKTOP_AXIOS_HANDLER__;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{if(request.url==='/collector/runs/queued-a/cancel-request'){calls.push(request);throw Error('offline cancellation');}return previous(request)};
 await manager.stopAllTasks();
 assert.equal(leases,0,'discarding queued objects must release both route leases');
 assert.equal(calls.filter(r=>r.url.endsWith('/cancel-request')).length,2);
 assert.equal(manager.taskQueue.length,0);assert.equal(manager.tasks.size,0);
`));

test('explicit continue retries an already attempted original run with its frozen configuration and no new run',()=>probe(`
 await manager.getAllTasks({});manager.restoredRunIds.add(run.id);
 const result=await manager.resumeTask({taskId:'task',runId:run.id});
 const c=manager.tasks.get('task');
 assert.equal(result.runId,run.id);assert.deepEqual(manager.taskQueue,['task']);
 assert.equal(c.getRunId(),run.id);assert.equal(c.getTaskInfo().targetCount,5);
 assert.equal(c.getTaskInfo().targetUrl,frozen.targetUrl);
 assert.equal(c.dataProcessService.task.targetCount,5);
 assert.equal(c.resumeRun,true);
 assert.equal(calls.filter(r=>r.url.endsWith('/resume')).length,1);
 assert.equal(calls.some(r=>r.method==='post'&&r.url==='/collector/tasks/task/runs'),false);
 await manager.getAllTasks({});assert.equal(c.getTaskInfo().targetCount,5,'refresh cannot replace a queued frozen configuration');
`));

for(const status of ['CANCELLED','COMPLETED','RUNNING'])test('continue refuses '+status+' with an active lease or terminal result before changing the server',()=>probe(`
 run.status=${JSON.stringify(status)};run.lockExpiresAt=new Date(Date.now()+120000).toISOString();
 await manager.getAllTasks({});
 await assert.rejects(manager.resumeTask({taskId:'task',runId:run.id}),/取消|完成|租约|运行/);
 assert.equal(calls.some(r=>r.url.endsWith('/resume')),false);
`));

test('a changed account during original-run lookup cannot resume or enqueue it',()=>probe(`
 await manager.getAllTasks({});const previous=globalThis.__DESKTOP_AXIOS_HANDLER__;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{const result=await previous(request);if(request.url==='/collector/runs/run-old')operationStore.set('token','account-b');return result};
 await assert.rejects(manager.resumeTask({taskId:'task',runId:run.id}),/账号/);
 assert.equal(manager.taskQueue.length,0);assert.equal(calls.some(r=>r.url.endsWith('/resume')),false);
`));

test('task projection distinguishes resumable interruption from local execution and valid remote lease',()=>probe(`
 let listed=await manager.getAllTasks({});assert.equal(listed.list[0].canResume,true);
 manager.activeTasks.add('task');listed=await manager.getAllTasks({});assert.equal(listed.list[0].canResume,false);assert.match(listed.list[0].resumeBlockedReason,/本机/);
 manager.activeTasks.clear();run.status='RUNNING';run.lockExpiresAt=new Date(Date.now()+120000).toISOString();task.status='RUNNING';
 listed=await manager.getAllTasks({});assert.equal(listed.list[0].canResume,false);assert.match(listed.list[0].resumeBlockedReason,/租约|等待/);
`));

test('continue reuses qualified rows, retries failed rows in the same run and replaces failed status explicitly',()=>probe(`
 const c=new Collection({_id:'task',taskName:'原任务',...frozen},null);c.restoreRun(run,{resume:true});c.leaseToken='lease';
 const rows=[{id:'ok-row',sourceSku:'ok',sourceKey:'ok',status:'QUALIFIED',rawPayload:{id:'ok'}},{id:'bad-row',sourceSku:'bad',sourceKey:'bad',status:'FAILED',rawPayload:{}},{id:'skip-row',sourceSku:'skip',sourceKey:'skip',status:'FILTERED_OUT',rawPayload:{}}];
 const writes=[];globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url.endsWith('/items')&&request.method==='get')return{data:{items:rows.filter(r=>r.status===request.params.status)}};
  if(request.url.endsWith('/items')){writes.push(...request.data.items);return{data:{ok:true}};}
  if(request.url.endsWith('/events'))return{data:{ok:true}};
  throw Error('unexpected '+request.url);
 };
 c.excelService.DeleteFilled=async()=>{};c.excelService.saveExcel=async()=>true;c.excelService.getFilePath=async()=>'';
 await c.restoreSavedResults(run);
 assert.equal(c.goodsData.has('ok'),true);assert.equal(c.outcomeSkus.has('skip'),true);assert.equal(c.outcomeSkus.has('bad'),false);
 c.selectNewCandidates=async items=>items;c.processData=async items=>{assert.deepEqual(items.map(i=>i.id),['bad']);await c.persistRunItem({id:'bad'});};c.waitForAllTasks=async()=>{};
 await c.retryFailedProducts(run.id);
 assert.equal(writes[0].status,'QUALIFIED');assert.equal(writes[0].retry,true);
 assert.equal(c.outcomes.failed,0);assert.equal(c.reason,undefined,'resuming failed rows must not finish remaining source scan');
 assert.equal(c.mediaRetryItems.get('bad').runId,run.id);
 await c.flushRunEvents();
`));

test('a recovered whole group retires its old failed anchor only after the group has been saved',()=>probe(`
 const c=new Collection({_id:'task',taskName:'整组恢复',...frozen},null);c.restoreRun(run,{resume:true});c.leaseToken='lease';c.outcomes.failed=1;
 c.retryingRunSkus=new Set(['anchor']);c.mediaRetryItems.set('anchor',{runId:run.id,itemId:'failed-anchor',sourceKey:'anchor'});
 const writes=[];globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{if(request.url.endsWith('/items')){writes.push(...request.data.items);return{data:{ok:true}};}if(request.url.endsWith('/events'))return{data:{ok:true}};throw Error('unexpected '+request.url)};
 await c.persistRunItem({id:'anchor',sku:'anchor',collectorGroupId:'group',captureScope:'ALL'});
 assert.deepEqual(writes.map(x=>[x.sourceKey,x.status]),[['group','QUALIFIED'],['anchor','FILTERED_OUT']]);
 assert.equal(writes[1].retry,true);assert.equal(writes[1].errorCode,'COLLECTOR_GROUP_RECOVERED');assert.equal(c.outcomes.failed,0);
 await c.flushRunEvents();
`));

test('continue cannot silently use an edited task when the original configuration is missing',()=>probe(`
 delete run.configurationSnapshot.configuration;
 await assert.rejects(manager.resumeTask({taskId:'task',runId:run.id}),/配置快照/);
 assert.equal(calls.some(r=>r.url.endsWith('/resume')),false);
`));

test('TaskManager continue executes the same run through failed-item recovery and remaining collection',()=>probe(`
 const rows=new Map([['ok',{id:'ok-row',sourceKey:'ok',sourceSku:'ok',status:'QUALIFIED',rawPayload:{id:'ok'}}],['bad',{id:'bad-row',sourceKey:'bad',sourceSku:'bad',status:'FAILED',rawPayload:{}}]]);
 run.progress.filteredCount=0;const observed=[];let c;
 const previous=globalThis.__DESKTOP_AXIOS_HANDLER__;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url.endsWith('/claim')&&!request.url.endsWith('/skus/claim')){calls.push(request);run.status='RUNNING';return{data:{run,leaseToken:'lease'}};}
  if(request.url==='/collector/capabilities')return{data:{capabilities:{}}};
  if(request.url.endsWith('/skus/claim'))return{data:{items:request.data.skus.map(sku=>({sku,state:'CLAIMED'}))}};
  if(request.url.endsWith('/items')){
   calls.push(request);if(request.method==='get')return{data:{items:[...rows.values()].filter(x=>x.status===request.params.status)}};
   for(const item of request.data.items){if(item.sourceKey==='bad')assert.equal(item.retry,true);rows.set(item.sourceKey,{...item,id:item.sourceKey});observed.push(item.sourceKey);}
   return{data:{ok:true}};
  }
  if(request.url.endsWith('/heartbeat'))return{data:{ok:true}};
  if(request.url.endsWith('/complete')){calls.push(request);run.status='COMPLETED';return{data:{run}};}
  return previous(request);
 };
 const create=manager.createCollection.bind(manager);manager.createCollection=data=>{
  c=create(data);
  c.mainWindowService.createCollectionWindow=async url=>assert.equal(url,frozen.targetUrl);
  c.dataProcessService.getBaseData=async items=>items.map(item=>({...item,storefrontPrice:{amount:30,currencyCode:'CNY'}}));
  c.getHtmlData=async()=>{assert.deepEqual(observed,['bad']);await c.processData([{id:'fresh'}]);await c.waitForAllTasks();c.reason='success';};
  c.expendShop=async()=>{};
  c.excelService.DeleteFilled=async()=>{};c.excelService.saveExcel=async()=>true;c.excelService.flushToDisk=async()=>true;c.excelService.getFilePath=async()=>'';
  return c;
 };
 await manager.resumeTask({taskId:'task',runId:run.id});
 manager.maxConcurrentTasks=1;manager.taskQueue.shift();await manager.executeTask('task');
 assert.equal(run.status,'COMPLETED');assert.deepEqual(observed,['bad','fresh']);
 assert.equal(rows.size,3);assert.equal(rows.get('bad').status,'QUALIFIED');
 assert.equal(c.targetData,3);assert.equal(c.outcomes.failed,0);
 assert.equal(calls.some(r=>r.method==='post'&&r.url==='/collector/tasks/task/runs'),false);
 assert.equal(calls.filter(r=>r.url.endsWith('/complete')).length,1);
 assert.equal(manager.activeTasks.size,0);assert.equal(c.sellerRouteLease,null);
`));


test('polling cannot enqueue or replace a pending explicit resume before its POST response arrives',()=>probe(`
 let entered,finish;const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>finish=resolve);
 const previous=globalThis.__DESKTOP_AXIOS_HANDLER__;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url.endsWith('/resume')){calls.push(request);run.status='QUEUED';task.status='QUEUED';entered();await pending;return{data:{run}};}
  return previous(request);
 };
 const operation=manager.resumeTask({taskId:'task',runId:run.id});await started;
 const listed=await manager.getAllTasks({});
 assert.equal(manager.taskQueue.length,0,'poll must leave this explicit resume to its owner');
 assert.equal(manager.tasks.has('task'),false,'poll must not create a competing Collection');
 assert.equal(listed.list[0].canResume,false);assert.match(listed.list[0].resumeBlockedReason,/恢复/);
 finish();await operation;
 assert.deepEqual(manager.taskQueue,['task']);assert.equal(manager.tasks.get('task').resumeRun,true);
`));

test('an automatic lookup already underway cannot enqueue over a subsequent explicit resume',()=>probe(`
 let entered,finish,posted,reply;const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>finish=resolve),postStarted=new Promise(resolve=>posted=resolve),response=new Promise(resolve=>reply=resolve);
 const c=new Collection({_id:'task',taskName:'原任务',taskStatus:'pending',...frozen},null);manager.tasks.set('task',c);
 const previous=globalThis.__DESKTOP_AXIOS_HANDLER__;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url==='/collector/tasks/task/runs'){entered();await pending;return{data:{runs:[{...run,status:'QUEUED'}]}};}
  if(request.url.endsWith('/resume')){run.status='QUEUED';posted();await response;return{data:{run}};}
  return previous(request);
 };
 const automatic=manager.restorePersistedRun(c.getTaskInfo(),c);await started;
 const explicit=manager.resumeTask({taskId:'task',runId:run.id});await postStarted;finish();await automatic;
 assert.equal(c.getRunId(),'','stale automatic Collection must not acquire the run');
 assert.equal(manager.taskQueue.length,0);reply();await explicit;
 const resumed=manager.tasks.get('task');assert.notEqual(resumed,c);assert.deepEqual(manager.taskQueue,['task']);assert.equal(resumed.resumeRun,true);
`));

test('a resume POST response cannot overwrite a task that became occupied locally',()=>probe(`
 let occupied;const previous=globalThis.__DESKTOP_AXIOS_HANDLER__;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  const result=await previous(request);
  if(request.url.endsWith('/resume')){occupied=new Collection({_id:'task',taskName:'执行中'},null);manager.tasks.set('task',occupied);manager.activeTasks.add('task');}
  return result;
 };
 await assert.rejects(manager.resumeTask({taskId:'task',runId:run.id}),/本机|执行|排队/);
 assert.equal(manager.tasks.get('task'),occupied);assert.equal(manager.taskQueue.length,0);
`));

test('a lost resume response can reload the original run with its durable failed-retry intent',()=>probe(`
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url.endsWith('/resume')){run.status='QUEUED';task.status='QUEUED';run.resultSummary={resumeRequested:true};throw Error('response lost');}
  if(request.url==='/collector/tasks/task')return{data:{task}};
  if(request.url==='/collector/runs/run-old')return{data:{run}};
  if(request.url==='/collector/tasks')return{data:{tasks:[task]}};
  throw Error('unexpected '+request.url);
 };
 await assert.rejects(manager.resumeTask({taskId:'task',runId:run.id}),/response lost/);
 const restarted=new TaskManager();restarted.maxConcurrentTasks=0;await restarted.getAllTasks({});
 assert.deepEqual(restarted.taskQueue,['task']);assert.equal(restarted.tasks.get('task').getRunId(),run.id);
 assert.equal(restarted.tasks.get('task').resumeRun,true,'confirmed resume intent survives an ambiguous POST response and reload');
 assert.equal(run.progress.qualifiedCount,1);assert.equal(run.progress.failedCount,1);
`));
