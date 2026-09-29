import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('saved groups, replacement receipts, restore and cleanup preserve actual SKU progress',()=>{
 const profile=mkdtempSync(join(tmpdir(),'collector-sku-progress-'));
 const script=`
 import assert from 'node:assert/strict';
 import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
 const group={id:'anchor',sku:'a',collectorGroupId:'group-a',captureScope:'ALL',variantData:{variants:[{sku:'a'},{sku:'b'},{sku:'c'}]}};
 const single={id:'single',sku:'d',captureScope:'CURRENT'};
 const c=new Collection({_id:'task',taskName:'商品与SKU',targetCount:20},null);
 c.persistRunItem=async()=>true;
 c.writeQueue=[[group],[single]];await c.writeTable();
 assert.equal(c.task.progress.totalCount,2);
 assert.equal(c.task.progress.skuCount,4,'three variants plus one current SKU');
 c.writeQueue=[[group]];await c.writeTable();
 assert.equal(c.task.progress.totalCount,2);assert.equal(c.task.progress.skuCount,4,'receipt replay must not double count');
 c.persistRunItem=async()=>false;c.writeQueue=[[{id:'not-saved',sku:'e'}]];await c.writeTable();
 assert.equal(c.task.progress.skuCount,4,'unconfirmed result is not counted');
 c.clearStatus();assert.equal(c.task.progress.totalCount,2);assert.equal(c.task.progress.skuCount,4,'completed count survives memory cleanup');
 const restored=new Collection({_id:'task',taskName:'原轮次',targetCount:20},null);
 restored.runId='saved-run';
 restored.excelService.DeleteFilled=async()=>{};
 globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
  if(request.url==='/collector/runs/saved-run/items')return {data:{items:[{sourceSku:'a',sourceKey:'group-a',rawPayload:group},{sourceSku:'d',sourceKey:'single',rawPayload:single}]}};
  if(request.url==='/collector/runs/saved-run/events')return {data:{ok:true}};
  throw Error('Unexpected '+request.url);
 };
 await restored.restoreSavedResults({progress:{qualifiedCount:2}});
 assert.equal(restored.task.progress.totalCount,2);assert.equal(restored.task.progress.skuCount,4);
 await restored.flushRunEvents();restored.clearStatus();await restored.flushRunEvents();
 `;
 try{
  const result=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8',timeout:20000,env:{...process.env,DESKTOP_TEST_USER_DATA:profile}});
  assert.equal(result.status,0,result.stderr||result.stdout);
 }finally{rmSync(profile,{recursive:true,force:true});}
});
