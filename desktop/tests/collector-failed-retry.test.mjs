import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const backend = new URL('../dist-electron/services/collector-backend.services.js', import.meta.url).href;
const collection = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
function probe(script){const run=spawnSync(process.execPath,['--loader',loader,'--input-type=module','-e',`import assert from 'node:assert/strict';import * as api from ${JSON.stringify(backend)};${script}`],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr||run.stdout);}
test('failed-only retry creates a separate task using the selected historical run, including its frozen AI configuration',()=>probe(`
 const requests=[];const frozen={taskName:'原任务',isUseCategorySelect:0,aiSelectType:1,categoryIds:[['3']],salePriceMin:100,autoSendToAiListing:true,autoStartAiGeneration:true,aiListingConfigId:'old-version',aiListingConfigSnapshot:{config:{prompt:'原提示词',manualReview:true}}};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{requests.push(request);
  if(request.url==='/collector/runs/old-run')return {data:{run:{id:'old-run',taskId:'task',status:'COMPLETED',configurationSnapshot:{concurrency:3,taskType:'CATEGORY',configuration:frozen}}}};
  if(request.url.endsWith('/items'))return {data:{items:[{sourceSku:'bad',status:'FAILED'}]}};
  if(request.url==='/collector/tasks'&&request.method==='post')return {data:{task:{id:'retry-task',configuration:request.data.configuration}}};
  throw Error('must not refetch mutable current AI settings: '+request.url);
 };
 const result=await api.createCollectorFailedRetry({taskId:'task',runId:'old-run'});
 assert.equal(result._id,'retry-task');const writes=requests.filter(r=>r.method==='post');assert.equal(writes.length,1);
 const data=writes[0].data;assert.equal(data.concurrency,3);assert.equal(data.configuration.retryFromRunId,'old-run');
 assert.deepEqual(data.configuration.aiListingConfigSnapshot,frozen.aiListingConfigSnapshot);assert.equal(data.configuration.salePriceMin,100);
 assert.equal(data.configuration.autoStartAiGeneration,true);assert.equal(data.name,'原任务 · 失败重试');
`));
test('a run belonging to a different task, an active run, or a run without failed items cannot create a retry',()=>probe(`
 for(const mode of ['wrong-task','active','empty']){let writes=0;globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.method==='post')writes++;
  if(request.url==='/collector/runs/run')return {data:{run:{id:'run',taskId:mode==='wrong-task'?'other':'task',status:mode==='active'?'RUNNING':'COMPLETED',configurationSnapshot:{configuration:{}}}}};
  return {data:{items:[]}};
 };await assert.rejects(api.createCollectorFailedRetry({taskId:'task',runId:'run'}));assert.equal(writes,0);}
`));
test('result details include run-level errors even when no SKU was discovered, and preserve the selected run',()=>probe(`
 const requests=[];globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{requests.push(request);return request.url.endsWith('/items')?{data:{items:[]}}:{data:{run:{id:'old',taskId:'task',status:'FAILED',errorCode:'SELLER_LOGIN_REQUIRED',errorMessage:'选品接口 HTTP 403',progress:{qualifiedCount:0,filteredCount:0,failedCount:0}}}};};
 const result=await api.readCollectorRunOutcomes({runId:'old'});assert.match(result.errorMessage,/HTTP 403/);assert.deepEqual(result.items,[]);assert.ok(requests.every(r=>r.url.startsWith('/collector/runs/old')));
`));
test('running result details separate preparing checkpoints from actual failures without changing stored item status',()=>probe(`
 const failed=[
  {sourceSku:'initial',status:'FAILED',rawPayload:{mediaPreparation:{status:'preparing'}}},
  {sourceSku:'uploading',status:'FAILED',rawPayload:{mediaPreparation:{status:'preparing'},mediaIntents:[{id:'intent'}]}},
  {sourceSku:'waiting',status:'FAILED',rawPayload:{mediaPreparation:{status:'waiting'}},errorMessage:'下载失败，等待重试'},
  {sourceSku:'broken',status:'FAILED',errorMessage:'图册读取失败'},
 ];
 const skipped=[{sourceSku:'sold',status:'FILTERED_OUT',errorMessage:'商品已售罄'}];
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  assert.equal(request.method,'get');
  return request.url.endsWith('/items')?{data:{items:request.params.status==='FAILED'?failed:skipped}}
   :{data:{run:{id:'run',taskId:'task',status:'RUNNING',progress:{qualifiedCount:9,failedCount:4}}}};
 };
 const result=await api.readCollectorRunOutcomes({runId:'run'});
 assert.equal(result.status,'RUNNING');assert.equal(result.preparingCount,2);assert.equal(result.failedCount,2);
 assert.equal(result.qualifiedCount,9);assert.equal(result.skippedCount,1);
 assert.deepEqual(result.items.map(item=>[item.sku,item.status]),[['initial','PREPARING'],['uploading','PREPARING'],['waiting','FAILED'],['broken','FAILED'],['sold','FILTERED_OUT']]);
 assert.equal(result.items.find(item=>item.sku==='waiting').message,'下载失败，等待重试');
 assert.ok(failed.every(item=>item.status==='FAILED'),'read projection must not mutate stored rows');
`));
test('preparing checkpoints remain failed outside a running run and terminal runs can retry them',()=>probe(`
 for(const status of ['COMPLETED','FAILED','CANCELLED','QUEUED']){
  const writes=[];globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
   if(request.method==='post'){writes.push(request);return {data:{task:{id:'retry-task',configuration:request.data.configuration}}};}
   if(request.url.endsWith('/items'))return {data:{items:request.params.status==='FAILED'?[{sourceSku:'interrupted',status:'FAILED',rawPayload:{mediaPreparation:{status:'preparing'}}}]:[]}};
   return {data:{run:{id:'run',taskId:'task',status,configurationSnapshot:{taskType:'CATEGORY',configuration:{taskName:'素材中断'}}}}};
  };
  const result=await api.readCollectorRunOutcomes({runId:'run'});
  assert.equal(result.preparingCount,0);assert.equal(result.failedCount,1);assert.equal(result.items[0].status,'FAILED');
  if(status!=='QUEUED'){await api.createCollectorFailedRetry({taskId:'task',runId:'run'});assert.equal(writes.length,1);}
 }
`));
test('failed-only execution reads fresh Seller metrics only for failed SKUs and never expands categories or shops',()=>probe(`
 const {Collection}=await import(${JSON.stringify(collection)});const requested=[];
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url.endsWith('/items')&&request.method==='get')return {data:{items:[{sourceSku:'bad',status:'FAILED'}]}};
  if(request.url.endsWith('/skus/claim'))return {data:{items:request.data.skus.map(sku=>({sku,state:'CLAIMED'}))}};
  return {data:{ok:true}};
 };
 const c=new Collection({_id:'retry',taskName:'重试',retryFromRunId:'old',aiSelectType:1,targetCount:10},null);c.runId='new';c.leaseToken='lease';
 c.dataProcessService.getBaseData=async items=>{requested.push(...items.map(i=>i.id));return items.map(i=>({...i,price:100}));};
 c.getHtmlDetailData=async item=>({...item,storefrontPrice:null});c.excelService.saveExcel=async()=>true;c.excelService.getFilePath=async()=>'';
 await c.retryFailedProducts();assert.deepEqual(requested,['bad']);assert.equal(c.targetData,1);assert.equal(c.reason,'success');
`));

test('startup failure stays visible after actual TaskManager cleanup and list refresh without hiding a newer run',()=>probe(`
 const {Collection}=await import(${JSON.stringify(collection)});
 const {TaskManager}=await import(${JSON.stringify(new URL('../dist-electron/services/collection/task-manager.services.js',import.meta.url).href)});
 let currentRunId='old';const rows=()=>[{id:'task',name:'原任务',status:'COMPLETED',currentRunId,currentRun:{id:currentRunId,status:'COMPLETED',progress:{qualifiedCount:1}}}];
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{if(request.url==='/collector/tasks')return {data:{tasks:rows()}};return {data:{ok:true}};};
 const c=new Collection({_id:'task',taskName:'原任务',taskStatus:'completed',currentRunId:'old'},null);
 c.prepareRun=async()=>{throw Object.assign(Error('Seller 登录等待超时'),{code:'SELLER_LOGIN_REQUIRED'});};
 const manager=new TaskManager();manager.tasks.set('task',c);await manager.executeTask('task');
 const result=await manager.getAllTasks({});assert.equal(result.list[0].taskStatus,'failed');assert.equal(result.list[0].startError.message,'Seller 登录等待超时');assert.equal(result.list[0].currentRunId,'old','old results are retained separately');
 currentRunId='new';const refreshed=await manager.getAllTasks({});assert.equal(refreshed.list[0].startError,undefined);assert.equal(refreshed.list[0].taskStatus,'completed');
 assert.equal(manager.getTask('task').startError,undefined,'a newer run must also clear the stored Collection error');
`));

test('a queued run claims its lease before Seller revalidation so a changed company can be failed durably',()=>probe(`
 const {Collection}=await import(${JSON.stringify(collection)});const calls=[];
 globalThis.__SELLER_CONTEXT__={accountId:'a',source:'ozon_seller_analytics',sourceIdentity:'seller-page:999'};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{calls.push(request.url);if(request.url.endsWith('/claim'))return {data:{run:{id:'queued'},leaseToken:'lease'}};return {data:{ok:true}};};
 const c=new Collection({_id:'task',taskName:'排队任务',isUseCategorySelect:1},null);
 c.restoreRun({id:'queued',status:'QUEUED',configurationSnapshot:{sourceContext:{accountId:'a',source:'ozon_seller_analytics',sourceIdentity:'seller-page:123'}}});
 await c.run();assert.equal(c.task.taskStatus,'failed');assert.equal(c.task.lastErrorCode,'SELLER_SOURCE_CONTEXT_CHANGED');
 assert.ok(calls.some(url=>url.endsWith('/claim')));assert.ok(calls.some(url=>url.endsWith('/fail')));assert.equal(c.runId,'');
`));

for (const [method, status, backendStatus, previousRunId] of [
 ['startTaskById', 'noExecuted', 'NOT_STARTED', ''],
 ['reExecuteTask', 'completed', 'COMPLETED', 'old-run'],
]) test(method+' retains a queue-full startup failure without replacing the older export cache',()=>probe(`
 const {Collection}=await import(${JSON.stringify(collection)});
 const {TaskManager}=await import(${JSON.stringify(new URL('../dist-electron/services/collection/task-manager.services.js',import.meta.url).href)});
 const events=[];const mainWindow={isDestroyed:()=>false,webContents:{send:(channel,payload)=>events.push({channel,payload:structuredClone(payload)})}};
 const manager=new TaskManager();manager.setMainWindow(mainWindow);manager.maxConcurrentTasks=2;
 manager.activeTasks=new Set(['busy-one','busy-two']);
 const c=new Collection({_id:'task',taskName:'排队启动',taskStatus:${JSON.stringify(status)},currentRunId:${JSON.stringify(previousRunId)}},mainWindow);
 c.prepareRun=async()=>{throw Object.assign(Error('Seller 登录等待超时'),{code:'SELLER_LOGIN_REQUIRED'});};
 manager.tasks.set('task',c);
 const prior={taskId:'task',runId:${JSON.stringify(previousRunId)},filePath:'/old-export.xlsx',progress:{totalCount:7}};
 manager.filePathList.set('task',structuredClone(prior));
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  assert.equal(request.method,'get');assert.equal(request.url,'/collector/tasks');
  return {data:{tasks:[{id:'task',name:'排队启动',status:${JSON.stringify(backendStatus)},currentRunId:${JSON.stringify(previousRunId)},currentRun:null}]}};
 };
 await assert.rejects(manager.${method}('task'),error=>error.code==='SELLER_LOGIN_REQUIRED');
 const cached=manager.filePathList.get('task');assert.equal(cached.filePath,prior.filePath);assert.equal(cached.runId,prior.runId);assert.deepEqual(cached.progress,prior.progress);
 const row=(await manager.getAllTasks({})).list[0];
 assert.equal(row.taskStatus,'failed');assert.equal(row.startError.message,'Seller 登录等待超时');assert.equal(row.startError.code,'SELLER_LOGIN_REQUIRED');
 assert.equal(row.currentRunId,${JSON.stringify(previousRunId)});assert.equal(manager.taskQueue.includes('task'),false);
 assert.ok(events.some(event=>event.channel==='task-progress'&&event.payload.collectionTask.startError?.message==='Seller 登录等待超时'));
`));
