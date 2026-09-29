import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a full desktop queue persists a rerun before acknowledging it and restores that run', () => {
  const userData = mkdtempSync(join(tmpdir(), 'sonli-requeue-'));
  const managerUrl = new URL('../dist-electron/services/collection/task-manager.services.js', import.meta.url).href;
  const collectionUrl = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
  const pathsUrl = new URL('../dist-electron/services/collection/excel-path.core.js', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { TaskManager } from ${JSON.stringify(managerUrl)};
    import { Collection } from ${JSON.stringify(collectionUrl)};
    import { buildTaskExcelPath } from ${JSON.stringify(pathsUrl)};
    const task = { _id:'rerun', taskName:'fixture', taskStatus:'completed', categoryIds:[], progress:{} };
    const runs=[];
    let rejectCreate=false;
    globalThis.__SELLER_CONTEXT__={accountId:'account-a',source:'ozon_seller_analytics',sourceIdentity:'seller-page:2681910'};
    globalThis.__DESKTOP_AXIOS_HANDLER__=config=>{
      if(config.url==='/collector/tasks/rerun/runs' && config.method==='post') {
        if(rejectCreate) throw Error('fixture database unavailable');
        assert.ok(config.data.idempotencyKey);
        const run={id:'run-1',status:'QUEUED',accountId:'account-a',configurationSnapshot:{sourceContext:globalThis.__SELLER_CONTEXT__}};
        runs.push(run);task.taskStatus='pending';return {data:{run}};
      }
      if(config.url==='/collector/tasks/rerun/runs') return {data:{runs}};
      if(config.url.endsWith('/events')) return {data:{ok:true}};
      throw Error('unexpected fixture request '+config.url);
    };
    function fullManager() {
      const manager=new TaskManager();manager.maxConcurrentTasks=2;manager.activeTasks=new Set(['busy-a','busy-b']);return manager;
    }
    const manager=fullManager();
    const collection=new Collection({...task},null);
    const excelPath=buildTaskExcelPath(process.env.DESKTOP_TEST_USER_DATA,'rerun','fixture');
    mkdirSync(dirname(excelPath),{recursive:true});writeFileSync(excelPath,'fixture');
    manager.tasks.set('rerun',collection);
    await manager.reExecuteTask('rerun');
    assert.equal(runs.length,1,'accepted rerun must have a persisted QUEUED run');
    assert.deepEqual(manager.taskQueue,['rerun']);
    const restarted=fullManager();
    const restored=new Collection({...task},null);restarted.tasks.set('rerun',restored);
    await restarted.restorePersistedRun(task,restored);
    await restarted.restorePersistedRun(task,restored);
    assert.equal(restored.getRunId(),'run-1');
    assert.deepEqual(restarted.taskQueue,['rerun']);
    assert.equal(runs.length,1,'restore must not create a new run');
    const failed=fullManager();const failedCollection=new Collection({...task,taskStatus:'failed'},null);
    failed.tasks.set('rerun',failedCollection);rejectCreate=true;
    await assert.rejects(failed.reExecuteTask('rerun'),/fixture database unavailable/);
    assert.deepEqual(failed.taskQueue,[]);
    assert.notEqual(failedCollection.getTaskInfo().taskStatus,'pending');
  `;
  try {
    const result=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',probe],{
      encoding:'utf8',env:{...process.env,DESKTOP_TEST_USER_DATA:userData,DESKTOP_TEST_REAL_EXCEL:'1'},timeout:15000,
    });
    assert.equal(result.status,0,result.stderr || result.stdout);
  } finally { rmSync(userData,{recursive:true,force:true}); }
});
