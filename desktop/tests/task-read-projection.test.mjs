import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('task reads retain persisted progress, owned export paths and currentRun recovery without N+1',()=>{
 const profile=mkdtempSync(join(tmpdir(),'sonli-task-projection-'));
 const probe=`
 import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {dirname} from 'node:path';
 import {TaskManager} from ${JSON.stringify(new URL('../dist-electron/services/collection/task-manager.services.js',import.meta.url).href)};
 import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
 import {buildTaskExcelPath} from ${JSON.stringify(new URL('../dist-electron/services/collection/excel-path.core.js',import.meta.url).href)};
 const path=buildTaskExcelPath(process.env.DESKTOP_TEST_USER_DATA,'done','original name');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'fixture');
 const progress={totalCount:7,processedCount:7,qualifiedCount:2};
 const rows=[
  {id:'done',name:'renamed task',status:'COMPLETED',currentRunId:'run-done',currentRun:{id:'run-done',status:'COMPLETED',progress,resultSummary:{exportedFilePath:path}},lastStartedAt:'2026-09-10T02:00:00Z'},
  {id:'foreign-file',name:'other',status:'FAILED',currentRun:{id:'run-other',status:'FAILED',progress,resultSummary:{exportedFilePath:path}}},
  {id:'missing-file',name:'missing',status:'COMPLETED',currentRun:{id:'run-missing',status:'COMPLETED',progress,resultSummary:{exportedFilePath:path+'.missing'}}},
  {id:'queued',name:'queued',status:'QUEUED',currentRunId:'run-queued',currentRun:{id:'run-queued',status:'QUEUED',progress:{totalCount:3,processedCount:3,qualifiedCount:1},configurationSnapshot:{}}},
  {id:'active',name:'active',status:'RUNNING',lastStartedAt:'2026-09-10T03:00:00Z',currentRunId:'run-active',currentRun:{id:'run-active',status:'RUNNING',progress}},
 ];
 const calls=[];globalThis.__DESKTOP_AXIOS_HANDLER__=c=>{calls.push(c.url);if(c.url==='/collector/tasks')return {data:{tasks:structuredClone(rows)}};if(c.url.endsWith('/events'))return {data:{ok:true}};throw Error('unexpected request '+c.url);};
 const manager=new TaskManager();manager.maxConcurrentTasks=2;manager.activeTasks=new Set(['active','busy-fixture']);
 const live=new Collection({_id:'active',taskStatus:'running',currentRunId:'run-active',progress:{current:2,total:99,totalCount:4}},null);manager.tasks.set('active',live);
 manager.filePathList.set('done',{progress:{current:0,total:0,totalCount:0}});
 for(let i=0;i<2;i++){
  const result=await manager.getAllTasks({});const byId=Object.fromEntries(result.list.map(t=>[t._id,t]));
  assert.deepEqual(byId.done.progress,{current:0,total:7,totalCount:2,dedup:{collected:0,listed:0,collecting:0}});assert.equal(byId.done.tableFilePath,path);
  assert.equal(byId['foreign-file'].tableFilePath,buildTaskExcelPath(process.env.DESKTOP_TEST_USER_DATA,'foreign-file','other'));
  assert.equal(byId['missing-file'].tableFilePath,buildTaskExcelPath(process.env.DESKTOP_TEST_USER_DATA,'missing-file','missing'));
  assert.notEqual(byId['foreign-file'].tableFilePath,path,'foreign paths are never exposed as downloadable; only a fresh owned recovery target is allowed');
  assert.deepEqual(byId.active.progress,{current:2,total:99,totalCount:4});assert.equal(live.getTaskInfo().lastRunningTime,'2026-09-10T03:00:00Z');
  assert.deepEqual(byId.queued.progress,{current:0,total:3,totalCount:1,dedup:{collected:0,listed:0,collecting:0}});
  assert.equal(manager.tasks.get('done').getTaskInfo().tableFilePath,path);
 }
 assert.equal(manager.tasks.get('queued').getRunId(),'run-queued');assert.deepEqual(manager.taskQueue,['queued']);
 assert.equal(calls.filter(p=>p.endsWith('/runs')).length,0);
 `;
 try{const result=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',probe],{env:{...process.env,DESKTOP_TEST_USER_DATA:profile},encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr||result.stdout);}finally{rmSync(profile,{recursive:true,force:true});}
});
