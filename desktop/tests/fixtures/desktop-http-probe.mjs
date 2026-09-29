import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { operationStore } from '../../dist-electron/store/index.js';
import { sonliRequest } from '../../dist-electron/services/sonli-api.services.js';
import { getCollectorTask } from '../../dist-electron/services/collector-backend.services.js';
import { TaskManager } from '../../dist-electron/services/collection/task-manager.services.js';
import { Collection } from '../../dist-electron/services/collection/collection.services.js';
import { buildTaskExcelPath } from '../../dist-electron/services/collection/excel-path.core.js';
const [mode,taskId]=process.argv.slice(2);
operationStore.set('token','desktop-web-a');
if(mode==='authorization') {
 await sonliRequest({method:'get',url:'/collector/tasks'});
 await assert.rejects(sonliRequest({method:'post',url:'/collector/tasks/'+taskId+'/runs'}),e=>e.status===401);
 await sonliRequest({method:'get',url:'/collector/tasks'});
 operationStore.set('token','desktop-web-b');
 await assert.rejects(getCollectorTask(taskId),e=>e.status===404);
 await assert.rejects(sonliRequest({method:'post',url:'/collector/tasks/'+taskId+'/runs'}),e=>e.status===404);
 operationStore.set('token','revoked');
 await assert.rejects(sonliRequest({method:'post',url:'/collector/tasks/'+taskId+'/runs'}),e=>e.status===401);
 console.log(JSON.stringify({mode,crossAccountDenied:true,revokedDenied:true}));
} else {
 const task=await getCollectorTask(taskId),manager=new TaskManager();
 manager.maxConcurrentTasks=2;manager.activeTasks=new Set(['busy-fixture-a','busy-fixture-b']);
 const collection=new Collection(task,null);manager.tasks.set(taskId,collection);
 globalThis.__SELLER_CONTEXT__={accountId:process.env.DESKTOP_TEST_ACCOUNT,source:'ozon_seller_analytics',sourceIdentity:'seller-page:2681910'};
 if(mode==='queue') {
  assert.equal(task.taskStatus,'completed');
  const excelPath=buildTaskExcelPath(process.env.DESKTOP_TEST_USER_DATA,taskId,'fixture');mkdirSync(dirname(excelPath),{recursive:true});writeFileSync(excelPath,'fixture');collection.excelService.excel={getFilePath:()=>excelPath,reset:async()=>{}};
  await manager.reExecuteTask(taskId);
 } else {
  await manager.restorePersistedRun(task,collection);await manager.restorePersistedRun(task,collection);
 }
 assert.deepEqual(manager.taskQueue,[taskId]);assert.ok(collection.getRunId());
 console.log(JSON.stringify({mode,runId:collection.getRunId(),queue:manager.taskQueue}));
}
