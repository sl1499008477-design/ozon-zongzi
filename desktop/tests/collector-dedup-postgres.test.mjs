import '../../server/tests/support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('desktop collection, duplicate skip, collect-box import and automatic AI handoff use real HTTP and PostgreSQL', {
  skip: process.env.SONLI_POSTGRES_TESTS !== '1', timeout: 30000,
}, () => {
  assert.equal(process.env.DATABASE_URL, process.env.SONLI_MIGRATION_TEST_DATABASE_URL);
  assert.equal(new URL(process.env.DATABASE_URL).pathname, '/sonli_audit_20260910');
  const profile = mkdtempSync(join(tmpdir(), 'desktop-dedup-postgres-'));
  try {
    const child = spawnSync(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url)),
      '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import { randomUUID } from 'node:crypto';
      import { shell } from 'electron';
      import * as service from ${JSON.stringify(new URL('../../server/collector-desktop-service.mjs', import.meta.url).href)};
      import { createCollectorHandoffRepository, createCollectorRunHandoffWorker } from ${JSON.stringify(new URL('../../server/collector-run-handoff.mjs', import.meta.url).href)};
      import { createCollectorHttpHandler } from ${JSON.stringify(new URL('../../server/collector-routes.mjs', import.meta.url).href)};
      import { addSelectedCollectorItemsToCollectBox } from ${JSON.stringify(new URL('../../server/collector-selection-service.mjs', import.meta.url).href)};
      import { purgeCollectedItems } from ${JSON.stringify(new URL('../../server/collection-purge.mjs', import.meta.url).href)};
      import { getPostgresPool, closePostgresPool } from ${JSON.stringify(new URL('../../server/db/connection.mjs', import.meta.url).href)};
      import { Collection } from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href)};
      import { TaskManager } from ${JSON.stringify(new URL('../dist-electron/services/collection/task-manager.services.js', import.meta.url).href)};
      import { getCollectorTask } from ${JSON.stringify(new URL('../dist-electron/services/collector-backend.services.js', import.meta.url).href)};
      const pool=await getPostgresPool(), accountId='desktop-dedup-'+randomUUID(), events=[], captured=[];
      const handler=createCollectorHttpHandler({authenticate:async()=>({id:accountId,role:'admin'})});
      const server=http.createServer(async(req,res)=>{
        try {
          const path=new URL(req.url,'http://fixture').pathname, match=path.match(/^\\/collector\\/runs\\/([^/]+)\\/collect-box$/);
          if(match) {
            let raw='';for await(const chunk of req)raw+=chunk;
            const body=JSON.parse(raw),result=await addSelectedCollectorItemsToCollectBox({accountId,runId:match[1],...body});
            res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
          }
          if(await handler(req,res))return;res.writeHead(404);res.end('{}');
        }catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message,code:error.code}));}
      });
      try {
        assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'sonli_audit_20260910');
        await pool.query("INSERT INTO accounts(id,username,role,status) VALUES($1,$1,'admin','active')",[accountId]);
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
          const url=new URL(request.url,'http://127.0.0.1:'+server.address().port);
          for(const [key,value] of Object.entries(request.params||{}))if(value!=null)url.searchParams.set(key,value);
          const response=await fetch(url,{method:request.method||'get',headers:{'content-type':'application/json'},...(request.data?{body:JSON.stringify(request.data)}:{})});
          const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'HTTP failure'),{status:response.status,code:data.code});return {data};
        };
        shell.openExternal=async()=>{throw Error('server-managed handoff must not require a browser');};
        globalThis.__SELLER_CONTEXT__={accountId,source:'ozon_seller_analytics',sourceIdentity:'fixture-seller'};
        async function execute(skus,auto=false) {
          const row=await service.createCollectorTask({accountId,name:'去重专库验收',taskType:'CATEGORY',configuration:{autoSendToAiListing:auto,isUseCategorySelect:0,targetCount:1,categoryIds:[]}});
          const task=await getCollectorTask(row.id), collection=new Collection(task,null), manager=new TaskManager();
          manager.setMainWindow({isDestroyed:()=>false,webContents:{send:(channel,payload)=>events.push({channel,payload})}});
          collection.excelService.DeleteFilled=async()=>{};
          collection.excelService.saveExcel=async()=>true;collection.excelService.getFilePath=async()=>'';
          collection.mainWindowService.createCollectionWindow=async()=>{};collection.mainWindowService.destroy=()=>{};
          collection.expendShop=async()=>{};
          globalThis.__SELLER_ANALYTICS_ITEMS__=skus.map(sku=>({id:sku,_id:sku,sku,nameLabel:'Бумага для печати',price:1541.268,photo:'https://ir-20.ozonstatic.cn/paper-fixture.jpg',href:'https://www.ozon.ru/product/'+sku+'/'}));
          collection.dataProcessService.filterData=async items=>items;
          collection.getHtmlDetailData=async item=>{captured.push(item.sku);return {...item,storefrontPrice:{amount:'128.91',currencyCode:'CNY'}};};
          manager.tasks.set(task._id,collection);await manager.executeTask(task._id);
          assert.equal(task.taskStatus,'completed');
          return await getCollectorTask(task._id);
        }
        const first=await execute(['1508194124']);
        const second=await execute(['1508194124','1508194125'],true);
        assert.deepEqual(captured,['1508194124','1508194125'],'second run never captures the previously saved SKU');
        assert.equal(first.progress.totalCount,1);assert.equal(second.progress.totalCount,1);
        assert.deepEqual(second.progress.dedup,{collected:1,listed:0,collecting:0});
        const pending=(await pool.query('SELECT status,body FROM collector_run_handoffs WHERE run_id=$1 AND account_id=$2',[second.currentRunId,accountId])).rows[0];
        assert.equal(pending.status,'PENDING');assert.deepEqual(pending.body,{receipts:{}});
        let createCalls=0;
        const worker=createCollectorRunHandoffWorker({repository:createCollectorHandoffRepository(pool),
          readRun:({accountId,runId})=>service.getCollectorRunForAccount(accountId,runId),listItems:service.listCollectorRunItems,
          addSelected:addSelectedCollectorItemsToCollectBox,createTasks:async()=>{createCalls++;throw Error('automatic generation is disabled');}});
        await worker.tick();
        const completed=await service.getCollectorRunForAccount(accountId,second.currentRunId);
        assert.equal(completed.handoff.status,'COMPLETED',JSON.stringify(completed.handoff));assert.equal(completed.handoff.processed,1);
        assert.equal(completed.handoff.created,0);assert.equal(completed.handoff.reused,0);assert.equal(createCalls,0);
        assert.equal(completed.handoff.collectItemIds.length,1);const collectId=completed.handoff.collectItemIds[0];
        const saved=(await pool.query('SELECT source_sku FROM collect_items WHERE id=$1 AND account_id=$2',[collectId,accountId])).rows[0];
        assert.equal(saved.source_sku,'1508194125');
        await worker.tick();
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM collect_items WHERE account_id=$1 AND source_sku=$2',[accountId,'1508194125'])).rows[0].count,1);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM collector_run_handoffs WHERE run_id=$1',[second.currentRunId])).rows[0].count,1);
        const third=await execute(['1508194124','1508194125']);
        assert.equal(third.progress.totalCount,0);assert.equal(third.progress.dedup.collected,2);
        assert.deepEqual(captured,['1508194124','1508194125']);
        console.log(JSON.stringify({runs:3,newProducts:2,secondRunDuplicateSkips:1,thirdRunDuplicateSkips:2,collectBoxImported:true,durableHandoffStatus:completed.handoff.status,durableHandoffProcessed:completed.handoff.processed,duplicateCollectItems:0,externalSeller:'representative fixture',paidAi:false,realOzonPublish:false}));
      }catch(error){console.error('FLOW_FAILURE',error);throw error;}finally{
        await new Promise(resolve=>server.close(resolve));
        const client=await pool.connect();
        try{await client.query('BEGIN');const ids=(await client.query('SELECT id FROM collect_items WHERE account_id=$1',[accountId])).rows.map(r=>r.id);await purgeCollectedItems(client,accountId,ids);await client.query('UPDATE collector_tasks SET current_run_id=NULL WHERE account_id=$1',[accountId]);await client.query('DELETE FROM product_restriction_events WHERE account_id=$1',[accountId]);await client.query('DELETE FROM accounts WHERE id=$1',[accountId]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
        await closePostgresPool();
      }
    `], { env: { ...process.env, DESKTOP_TEST_USER_DATA: profile }, encoding: 'utf8', timeout: 28000 });
    assert.equal(child.status, 0, child.stderr + '\n' + child.stdout);
    console.log(child.stdout.trim());
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
