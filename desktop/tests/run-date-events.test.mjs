import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
for(const mode of ['save-without-projection','claim-then-fail-events'])test(mode+' retains real execution dates',()=>{
 const profile=mkdtempSync(join(tmpdir(),'sonli-date-events-'));
 const probe=`
 import assert from 'node:assert/strict';
 import {TaskManager} from ${JSON.stringify(new URL('../dist-electron/services/collection/task-manager.services.js',import.meta.url).href)};
 const mode=${JSON.stringify(mode)},created='2026-09-10T00:00:00Z',previous='2026-09-10T01:00:00Z',started='2026-09-10T02:13:08Z';
 const events=[],calls=[];const win={isDestroyed:()=>false,webContents:{send:(name,payload)=>events.push({name,payload:structuredClone(payload)})}};
 globalThis.__SELLER_CONTEXT__={accountId:'date-account',source:'ozon_seller_analytics',sourceIdentity:'seller-page:2681910'};
 globalThis.__DESKTOP_AXIOS_HANDLER__=c=>{
  calls.push(c.url);
  if(c.method==='patch')return {data:{task:{id:'date-task',name:'real-date-task',status:'FAILED',createdAt:created,updatedAt:'2026-09-10T02:12:00Z',configuration:{}}}};
  if(c.url.endsWith('/claim'))return {data:{run:{id:'date-run',status:'RUNNING',startedAt:started},leaseToken:'fixture-lease'}};
  if(c.url.endsWith('/events')||c.url.endsWith('/fail')||c.url.endsWith('/heartbeat'))return {data:{ok:true}};
  throw Error('unexpected request '+c.url);
 };
 const manager=new TaskManager();manager.setMainWindow(win);
 await manager.addTask({_id:'date-task',taskName:'real-date-task',taskStatus:'failed',createTime:created,lastRunningTime:previous});
 const collection=manager.tasks.get('date-task');
 if(mode==='save-without-projection'){
  assert.equal(collection.getTaskInfo().createTime,created);assert.equal(collection.getTaskInfo().lastRunningTime,previous);
 }else{
  // Independently isolate authoritative claim propagation from the save fallback.
  Object.assign(collection.getTaskInfo(),{createTime:created,lastRunningTime:previous});
  collection.restoreRun({id:'date-run',status:'QUEUED'});collection.preparedClean=true;
  collection.mainWindowService.createCollectionWindow=async()=>{throw Error('fixture Seller page timeout');};
  await manager.executeTask('date-task');
  const progress=events.filter(e=>e.name==='task-progress');assert.ok(progress.some(e=>e.payload.collectionTask.taskStatus==='running'));assert.ok(progress.some(e=>e.payload.collectionTask.taskStatus==='failed'));
  for(const event of progress){assert.equal(event.payload.collectionTask.createTime,created);assert.equal(event.payload.collectionTask.lastRunningTime,started);}
  const terminal=events.findLast(e=>e.name==='task-status-update');assert.equal(terminal.payload.status,'failed');assert.equal(terminal.payload.task.lastRunningTime,started);
  assert.equal(calls.filter(p=>p.endsWith('/claim')).length,1);assert.equal(calls.filter(p=>p.endsWith('/fail')).length,1);
 }
 `;
 try{const r=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',probe],{env:{...process.env,DESKTOP_TEST_USER_DATA:profile},encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr||r.stdout);}finally{rmSync(profile,{recursive:true,force:true});}
});
