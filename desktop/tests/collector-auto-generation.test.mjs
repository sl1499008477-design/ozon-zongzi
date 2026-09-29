import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const backend=new URL('../dist-electron/services/collector-backend.services.js',import.meta.url).href;
const handoff=new URL('../dist-electron/services/collector-ai-listing.services.js',import.meta.url).href;
const run=script=>{const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8',timeout:20000});assert.equal(child.status,0,child.stderr||child.stdout);};

test('desktop freezes the selected owned configuration and prompt; old tasks stay manual',()=>run(`
 import assert from 'node:assert/strict';
 import {createCollectorTask,updateCollectorTask,listCollectorAiConfigs} from ${JSON.stringify(backend)};
 const calls=[];let saved;
 const config={targetStoreId:'store-a',targetWarehouseId:'warehouse-a',manualReview:false,promptId:'prompt-a',priceMultiplier:'1.125',image:{language:'ru'}};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{calls.push(req);
  if(req.url==='/ai-listing/presets/configs')return {data:{items:[{id:'preset-a',name:'已保存配置',updatedAt:'rev-a',config}]}};
  if(req.url==='/ai-listing/presets/configs/preset-a')return {data:{item:{id:'preset-a',name:'已保存配置',updatedAt:'rev-a',config}}};
  if(req.url==='/ai-listing/presets/prompts/prompt-a')return {data:{item:{id:'prompt-a',updatedAt:'prompt-rev',content:'原始已确认提示词'}}};
  if(req.url.startsWith('/collector/tasks')){saved=req.data;return {data:{task:{id:'task-a',configuration:saved.configuration}}};}
  throw Error('unexpected '+req.url);
 };
 const presets=await listCollectorAiConfigs();assert.equal(presets.items[0].id,'preset-a');assert.equal(new URL(presets.url).pathname,'/ozon/tools/ai-listing');
 await createCollectorTask({taskName:'old',autoSendToAiListing:true});assert.equal(saved.configuration.autoStartAiGeneration,false);assert.equal(saved.configuration.aiListingConfigSnapshot,undefined);
 const input={taskName:'auto',autoSendToAiListing:true,autoStartAiGeneration:true,aiListingConfigId:'preset-a',aiListingConfigUpdatedAt:'rev-a',aiAutoSubmitConfirmed:true,aiListingConfigSnapshot:{config:{prompt:'forged'}}};
 await createCollectorTask(input);const snapshot=saved.configuration.aiListingConfigSnapshot;
 assert.equal(snapshot.id,'preset-a');assert.equal(snapshot.config.prompt,'原始已确认提示词');assert.equal(snapshot.config.promptId,undefined);assert.equal(snapshot.config.targetStoreId,'store-a');assert.equal(snapshot.config.priceMultiplier,'1.125');
 assert.equal(input.aiListingConfigSnapshot.config.prompt,'forged','caller data stays untouched');
 await updateCollectorTask('task-a',{...input,autoSendToAiListing:false},2);assert.equal(saved.configuration.autoStartAiGeneration,false);assert.equal(saved.configuration.aiListingConfigSnapshot,undefined);
`));

test('stale, missing or unconfirmed automatic-submission selections cannot save a collector task',()=>run(`
 import assert from 'node:assert/strict';import {createCollectorTask} from ${JSON.stringify(backend)};
 let writes=0;
 globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{if(req.url.startsWith('/collector/')){writes++;return {data:{task:{id:'bad'}}};}return {data:{item:{id:'preset-a',updatedAt:'current',config:{manualReview:false,promptId:'prompt-a'}}}};};
 const data={autoSendToAiListing:true,autoStartAiGeneration:true,aiListingConfigId:'preset-a',aiListingConfigUpdatedAt:'old',aiAutoSubmitConfirmed:true};
 await assert.rejects(createCollectorTask(data),/更新|变化|重新/);
 await assert.rejects(createCollectorTask({...data,aiListingConfigUpdatedAt:'current',aiAutoSubmitConfirmed:false}),/自动.*提交|自动.*上架|确认/);
 await assert.rejects(createCollectorTask({...data,aiListingConfigId:''}),/配置/);
 assert.equal(writes,0);
`));

const receiptSource = `
 const receipt = ids => ({
  tasks:ids.map(id=>({id:'task-'+id,collectItemId:id,status:'QUEUED'})),errors:[],
  results:ids.map(id=>({collectItemId:id,taskIds:['task-'+id],createdTaskIds:['task-'+id],reusedTaskIds:[],unprocessedSkus:[]}))
 });
`;

test('automatic and manual resend send only the exact run and sources through every dedicated batch',()=>run(`
 import assert from 'node:assert/strict';import {shell} from 'electron';import {sendCollectorResultsToAiListing} from ${JSON.stringify(handoff)};
 ${receiptSource}
 const created=[],opens=[];shell.openExternal=async url=>opens.push(url);
 globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{
  if(req.url.endsWith('/collect-box'))return {data:{ok:true,selected:25,added:25,results:Array.from({length:25},(_,i)=>({collectItemId:'collect-'+i})),errors:[],missing:[]}};
  if(req.url==='/collector/runs/run-a')return {data:{run:{id:'run-a',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}}};
  if(req.url==='/ai-listing/tasks/from-collector-run'){created.push(req.data);return {data:receipt(req.data.collectItemIds)};}
  throw Error('unexpected '+req.url);
 };
 for(let i=0;i<2;i++){const result=await sendCollectorResultsToAiListing({runId:'run-a',itemIds:['item-a']});assert.equal(result.code,200);assert.equal(result.data.aiTasks.length,25);assert.equal(result.data.aiGenerationRequested,true);}
 assert.deepEqual(created.map(c=>c.collectItemIds.length),[10,10,5,10,10,5]);
 assert.deepEqual(created.slice(0,3),created.slice(3));
 assert.ok(created.every(c=>c.runId==='run-a'&&Object.keys(c).sort().join(',')==='collectItemIds,runId'));
 assert.ok(opens.every(url=>!new URL(url).searchParams.has('ids')));
`));

test('one source can reuse old tasks and create new tasks while shared tasks are counted once across batches',()=>run(`
 import assert from 'node:assert/strict';import {startCollectorRunAiListing} from ${JSON.stringify(backend)};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{
  if(req.url==='/collector/runs/run-a')return {data:{run:{id:'run-a',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}}};
  if(req.url==='/ai-listing/tasks/from-collector-run')return {data:{
   tasks:[{id:'old',collectItemId:'historical-other-root',status:'GENERATION_FAILED'},{id:'new-'+req.data.collectItemIds[0],status:'QUEUED'}],errors:[],
   results:req.data.collectItemIds.map(id=>({collectItemId:id,taskIds:['old','new-'+req.data.collectItemIds[0]],createdTaskIds:['new-'+req.data.collectItemIds[0]],reusedTaskIds:['old'],unprocessedSkus:[]}))
  }};
  throw Error('unexpected '+req.url);
 };
 const result=await startCollectorRunAiListing({runId:'run-a',results:Array.from({length:11},(_,i)=>({collectItemId:'collect-'+i}))});
 assert.equal(result.aiTasks.length,3);assert.equal(result.aiStartResults.length,11);assert.equal(result.aiStartErrors.length,0);
 assert.deepEqual(result.aiCreatedTaskIds,['new-collect-0','new-collect-10']);assert.deepEqual(result.aiReusedTaskIds,['old']);
`));

test('a complete partial source receipt preserves successes and continues later batches',()=>run(`
 import assert from 'node:assert/strict';import {shell} from 'electron';import {sendCollectorResultsToAiListing} from ${JSON.stringify(handoff)};
 ${receiptSource}
 shell.openExternal=async()=>{};const writes=[];
 const failure={collectItemId:'collect-19',skus:['19'],code:'AI_LISTING_LOGISTICS_REQUIRED',message:'Missing packaging',definitelyNotCreated:true};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{
  if(req.url.endsWith('/collect-box'))return {data:{ok:true,selected:21,results:Array.from({length:21},(_,i)=>({collectItemId:'collect-'+i})),errors:[],missing:[]}};
  if(req.url==='/collector/runs/run-a')return {data:{run:{id:'run-a',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}}};
  if(req.url==='/ai-listing/tasks/from-collector-run'){
   writes.push(req.data);const output=receipt(req.data.collectItemIds);
   if(req.data.collectItemIds.includes(failure.collectItemId)){
    output.tasks=output.tasks.filter(task=>task.collectItemId!==failure.collectItemId);output.errors=[failure];
    Object.assign(output.results.find(row=>row.collectItemId===failure.collectItemId),{taskIds:[],createdTaskIds:[],reusedTaskIds:[],unprocessedSkus:['19']});
   }
   return {data:output};
  }
  throw Error('unexpected '+req.url);
 };
 const result=await sendCollectorResultsToAiListing({runId:'run-a',itemIds:['item-a']});
 assert.equal(result.code,207);assert.equal(result.data.aiTasks.length,20);assert.deepEqual(result.data.aiStartErrors,[failure]);
 assert.deepEqual(writes.map(req=>req.collectItemIds.length),[10,10,1]);
 assert.ok(result.data.aiTasks.some(task=>task.collectItemId==='collect-20'));
`));

test('unknown or conflicting automatic receipts stop later batches and preserve only confirmed earlier results',()=>run(`
 import assert from 'node:assert/strict';import {startCollectorRunAiListing} from ${JSON.stringify(backend)};
 ${receiptSource}
 for(const kind of ['missing-result','duplicate-source','foreign-source','duplicate-task','missing-task','unreferenced-task','overlap','duplicate-failure','foreign-failure','unknown-failure','missing-failure','malformed-errors','auth-401','conflict-409','timeout']){
  let writes=0;
  globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{
   if(req.url==='/collector/runs/run-a')return {data:{run:{id:'run-a',status:'COMPLETED',configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}}};
   if(req.url==='/ai-listing/tasks/from-collector-run'){
    writes++;const output=receipt(req.data.collectItemIds);if(writes!==2)return {data:output};
    if(kind==='auth-401'||kind==='conflict-409')throw Object.assign(Error(kind),{status:kind==='auth-401'?401:409});
    if(kind==='timeout')throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});
    if(kind==='missing-result')output.results.pop();
    if(kind==='duplicate-source')output.results[9].collectItemId=output.results[8].collectItemId;
    if(kind==='foreign-source')output.results[9].collectItemId='foreign';
    if(kind==='duplicate-task')output.tasks[9].id=output.tasks[8].id;
    if(kind==='missing-task')output.tasks.pop();
    if(kind==='unreferenced-task')output.tasks.push({id:'unknown'});
    if(kind==='overlap')output.results[0].reusedTaskIds=output.results[0].createdTaskIds;
    if(['duplicate-failure','foreign-failure','unknown-failure','missing-failure'].includes(kind)){
     const failure={collectItemId:'collect-19',skus:['19'],definitelyNotCreated:true};
     output.results[9].unprocessedSkus=['19'];output.errors=kind==='missing-failure'?[]:[failure];
     if(kind==='duplicate-failure')output.errors.push(failure);
     if(kind==='foreign-failure')failure.collectItemId='foreign';
     if(kind==='unknown-failure')failure.definitelyNotCreated=false;
    }
    if(kind==='malformed-errors')output.errors={};
    return {data:output};
   }
   throw Error('unexpected '+req.url);
  };
  const result=await startCollectorRunAiListing({runId:'run-a',results:Array.from({length:21},(_,i)=>({collectItemId:'collect-'+i}))});
  assert.equal(writes,2,kind);assert.equal(result.aiTasks.length,10,kind);assert.equal(result.aiStartResults.length,10,kind);assert.equal(result.aiStartErrors.length,11,kind);
  assert.match(result.aiStartErrors[0].message,/未确认/,kind);assert.equal(result.aiStartErrors[0].definitelyNotCreated,undefined,kind);assert.match(result.aiStartErrors.at(-1).message,/尚未创建/,kind);
 }
`));


test('explicit manual resend sends qualified results from interrupted runs while automatic completion remains gated',()=>run(`
 import assert from 'node:assert/strict';import {startCollectorRunAiListing} from ${JSON.stringify(backend)};
 ${receiptSource}
 for(const status of ['FAILED','CANCELLED','QUEUED','RUNNING']){
  const writes=[];
  globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{
   if(req.url==='/collector/runs/run-a')return {data:{run:{id:'run-a',status,configurationSnapshot:{configuration:{autoSendToAiListing:true,autoStartAiGeneration:true}}}}};
   if(req.url==='/ai-listing/tasks/from-collector-run'){writes.push(req.data);return {data:receipt(req.data.collectItemIds)};}
   throw Error('unexpected '+req.url);
  };
  const input={runId:'run-a',results:[{collectItemId:'collect-a'}]};
  assert.equal((await startCollectorRunAiListing(input)).aiStartErrors.length,1);assert.equal(writes.length,0);
  const manual=await startCollectorRunAiListing(input,{manual:true});
  assert.equal(manual.aiStartErrors.length,0);assert.equal(writes.length,1);assert.equal(writes[0].manual,true);
 }
`));
