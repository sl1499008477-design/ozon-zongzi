import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const collectionUrl = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
function probe(script) {
 const dir = mkdtempSync(join(tmpdir(), 'collector-item-recovery-'));
 try {
  const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
   import assert from 'node:assert/strict';
   import { Collection } from ${JSON.stringify(collectionUrl)};
   const saved=[], requested=[], released=[], exported=[];
   globalThis.__DESKTOP_AXIOS_HANDLER__ = async request => {
    if(request.url.endsWith('/skus/claim')) return {data:{items:request.data.skus.map(sku=>({sku,state:'CLAIMED'}))}};
    if(request.url.endsWith('/skus/release')) released.push(...request.data.skus);
    else if(request.url.endsWith('/items')) saved.push(...request.data.items);
    return {data:{ok:true}};
   };
   const task={_id:'task',taskName:'mixed category',isUseCategorySelect:0,aiSelectType:1,targetCount:100,concurrency:4};
   const c=new Collection(task,null);c.runId='run';c.leaseToken='lease';c.uuid='uuid';
   c.excelService.saveExcel=async items=>{exported.push(...items);return true;};c.excelService.getFilePath=async()=>'';
   const good=id=>({id,nameLabel:'Product '+id,price:100,storefrontPrice:{amount:'10',currencyCode:'CNY'},images:['https://example.com/'+id+'-1.jpg','https://example.com/'+id+'-2.jpg']});
   ${script}
  `],{env:{...process.env,DESKTOP_TEST_USER_DATA:dir},encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr||result.stdout);
 } finally {rmSync(dir,{recursive:true,force:true});}
}
for(const mode of ['category','url']) test(mode+' saves good items around a sold-out item and an incomplete item',()=>probe(`
 c.getHtmlDetailData=async item=>{requested.push(item.id);if(item.id==='sold')throw Object.assign(Error('商品已售罄，原图册不可用'),{code:'ZONGZI_PRODUCT_UNAVAILABLE'});if(item.id==='broken')throw Object.assign(Error('缺少原商品图册'),{code:'ZONGZI_DETAIL_INCOMPLETE'});return good(item.id);};
 const items=['first','sold','broken','last'].map(id=>({id,price:100,nameLabel:id}));
 if(${JSON.stringify(mode)}==='category')await c.categoryProcess(items);
 else {c.process=items.length;c.taskQueueService.addTask(items);await c.taskQueueService.startProcessing();}
 await c.waitForAllTasks();
 assert.deepEqual(saved.filter(i=>i.status==='QUALIFIED').map(i=>i.sourceSku).sort(),['first','last']);
 assert.equal(saved.find(i=>i.sourceSku==='sold').status,'FILTERED_OUT');
 assert.equal(saved.find(i=>i.sourceSku==='sold').errorCode,'ZONGZI_PRODUCT_UNAVAILABLE');
 assert.equal(saved.find(i=>i.sourceSku==='broken').status,'FAILED');
 assert.equal(requested.filter(id=>id==='sold').length,1,'do not retry confirmed unavailable products');
 assert.equal(requested.filter(id=>id==='broken').length,2,'incomplete product gets one bounded retry');
 assert.equal(c.targetData,2);assert.equal(exported.length,2);assert.ok(exported.every(i=>i.images.length===2));
 assert.deepEqual(c.task.progress.outcomes,{skipped:1,failed:1});
 assert.equal(c.detailFailure,null,'one bad product must not fail the entire run');
`));
test('a transient detail failure recovers once without saving a false FAILED record',()=>probe(`
 c.getHtmlDetailData=async item=>{requested.push(item.id);if(requested.length===1)throw Object.assign(Error('temporary connection'),{code:'ZONGZI_NETWORK_ERROR'});return good(item.id);};
 c.process=1;await c.taskHandle({id:'recover'});
 assert.equal(requested.length,2);assert.equal(c.targetData,1);assert.deepEqual(saved.map(i=>i.status),['QUALIFIED']);
`));
test('access denial stops new detail requests but lets already successful work finish and records pending SKUs',()=>probe(`
 c.taskQueueService.maxConcurrency=2;
 c.getHtmlDetailData=async item=>{requested.push(item.id);if(item.id==='blocked')throw Object.assign(Error('请完成访问验证'),{code:'ZONGZI_ACCESS_BLOCKED',status:403});return good(item.id);};
 const items=['blocked','good','later1','later2'].map(id=>({id,price:100}));
 await assert.rejects(c.categoryProcess(items),error=>error.code==='ZONGZI_ACCESS_BLOCKED');
 assert.deepEqual(requested.sort(),['blocked','good']);
 assert.equal(saved.find(i=>i.sourceSku==='good').status,'QUALIFIED');
 assert.deepEqual(saved.filter(i=>i.status==='FAILED').map(i=>i.sourceSku).sort(),['blocked','later1','later2']);
 assert.equal(c.targetData,1);
`));
test('three consecutive unresolved detail failures stop the queue without swallowing item outcomes',()=>probe(`
 c.taskQueueService.maxConcurrency=2;
 c.getHtmlDetailData=async item=>{requested.push(item.id);throw Object.assign(Error('网络连接失败'),{code:'ZONGZI_NETWORK_ERROR'});};
 await assert.rejects(c.categoryProcess(['1','2','3','4','5','6'].map(id=>({id,price:100}))),error=>error.code==='ZONGZI_NETWORK_ERROR');
 assert.ok(new Set(requested).size<=4);assert.equal(saved.filter(i=>i.status==='FAILED').length,6);assert.equal(c.targetData,0);
`));

for(const concurrency of [2,4])test('actual task queue respects category concurrency '+concurrency+' for 30 products',()=>probe(`
 const {mock}=await import('node:test');const gates=[];let active=0,maxActive=0;
 c.taskQueueService.maxConcurrency=${concurrency};
 c.getHtmlDetailData=async item=>{requested.push(item.id);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>gates.push(resolve));active--;return good(item.id);};
 mock.timers.enable({apis:['setTimeout']});const running=c.categoryProcess(Array.from({length:30},(_,i)=>({id:String(i+1),price:100})));
 try{await new Promise(setImmediate);assert.equal(requested.length,${concurrency});
  while(requested.length<30){for(const done of gates.splice(0))done();await new Promise(setImmediate);mock.timers.tick(1500);await new Promise(setImmediate);}
  for(const done of gates.splice(0))done();await running;
  assert.equal(maxActive,${concurrency});assert.equal(c.targetData,30);
 }finally{mock.timers.reset();}
`));
test('cancelling an active category stops queued requests and cannot save late detail responses',()=>probe(`
 const {mock}=await import('node:test');const gates=[];
 c.taskQueueService.maxConcurrency=2;
 c.getHtmlDetailData=async item=>{requested.push(item.id);await new Promise(resolve=>gates.push(resolve));return good(item.id);};
 mock.timers.enable({apis:['setTimeout']});const running=c.categoryProcess(['1','2','3','4'].map(id=>({id,price:100})));
 try{await new Promise(setImmediate);await c.cancel();for(const done of gates)done();await new Promise(setImmediate);mock.timers.tick(1500);await running;
 assert.deepEqual(requested,['1','2']);assert.equal(c.targetData,0);assert.equal(saved.length,0);
 }finally{mock.timers.reset();}
`));
