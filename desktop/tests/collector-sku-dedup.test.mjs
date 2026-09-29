import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const loader = fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs', import.meta.url));
const collectionUrl = new URL('../dist-electron/services/collection/collection.services.js', import.meta.url).href;
function probe(code) {
  const profile = mkdtempSync(join(tmpdir(), 'desktop-dedup-'));
  try {
    const result = spawnSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Collection } from ${JSON.stringify(collectionUrl)};
      const requests=[], exported=[], detailSkus=[];
      const collection=new Collection({_id:'fixture-task',taskName:'去重验收',targetCount:1,aiSelectType:1},null);
      collection.runId='fixture-run';collection.leaseToken='fixture-lease';
      collection.excelService.saveExcel=async items=>{exported.push(...items);return true;};
      collection.excelService.getFilePath=async()=>'';
      const sample=sku=>({id:sku,_id:sku,sku,price:1000,nameLabel:'商品'+sku,storefrontPrice:{amount:'100.01',currencyCode:'CNY'}});
      ${code}
    `], { env: { ...process.env, DESKTOP_TEST_USER_DATA: profile }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { rmSync(profile, { recursive: true, force: true }); }
}

test('a fully duplicate category page continues to the next page; rejected details release and only new successes count', () => probe(`
  globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
    requests.push(request);
    if(request.url.endsWith('/skus/claim')) return {data:{items:request.data.skus.map(sku=>({sku,state:({101:'COLLECTED',102:'LISTED',103:'COLLECTING'})[sku]||'CLAIMED',taskId:'origin',runId:'origin-run'}))}};
    return {data:{ok:true}};
  };
  const pages=[['101','102','103'],['104','105']];let page=0;
  collection.getCategoryGoodsList=async()=>{const items=pages[page++].map(sample);collection.categoryExhausted=page===pages.length;return items;};
  collection.dataProcessService.filterData=async(items,task,phase)=>phase==='base'?items:items.filter(item=>item.sku!=='105');
  collection.getHtmlDetailData=async item=>{detailSkus.push(item.sku);return sample(item.sku);};
  await collection.categoryMode(1);
  assert.equal(page,2,'skips never satisfy targetCount');
  assert.deepEqual(detailSkus,['104','105'],'saved/listed/busy products never request detail');
  assert.equal(collection.targetData,1);
  assert.deepEqual(exported.map(item=>item.sku),['104']);
  assert.equal(exported[0].price,'100.01');assert.equal(exported[0].sellerAnalyticsPriceRub,1000);
  assert.deepEqual(collection.dedup,{collected:1,listed:1,collecting:1});
  assert.deepEqual(requests.filter(r=>r.url.endsWith('/skus/release')).map(r=>r.data.skus),[['105']]);
  const saved=requests.filter(r=>r.url.endsWith('/items')).flatMap(r=>r.data.items);assert.equal(saved.length,2);
  assert.deepEqual(saved.map(item=>[item.sourceSku,item.status]).sort(),[['104','QUALIFIED'],['105','FILTERED_OUT']]);
  const history=requests.filter(r=>r.data.eventType==='SKU_DUPLICATES');assert.equal(history.length,1);assert.equal(history[0].data.payload.items.length,3);
`));

test('a duplicate discovered at final save is neither exported nor counted, and saving precedes Excel', () => probe(`
  let attempts=0;
  globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
    requests.push(request);
    if(request.url.endsWith('/items')) {attempts++;assert.equal(exported.length,0);return {data:{results:[{created:false,duplicate:true,existing:{sku:'201',state:'COLLECTED',collectItemId:'existing'}}]}};}
    return {data:{ok:true}};
  };
  collection.process=1;await collection.taskHandle(sample('201'));
  assert.equal(attempts,1);assert.equal(collection.targetData,0);assert.deepEqual(exported,[]);
  assert.equal(collection.dedup.collected,1);assert.equal(collection.process,0);
`));

test('failed batch lookup stops before details and reports failure instead of completing silently', () => probe(`
  let pages=0;
  globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
    if(request.url.endsWith('/skus/claim')) throw Object.assign(Error('查重网络故障'),{status:503});
    return {data:{ok:true}};
  };
  collection.getCategoryGoodsList=async()=>++pages===1?[]:[sample('301')];
  collection.dataProcessService.filterData=async items=>items;
  collection.getHtmlDetailData=async()=>{throw Error('must not request details');};
  await assert.rejects(collection.categoryMode(1),/查重网络故障/);
  assert.equal(collection.reason,'failed');assert.equal(collection.targetData,0);assert.deepEqual(exported,[]);
`));

test('reclaimed run restores saved counts and Excel, avoids recapturing its own successes and retains skip counts', () => probe(`
  let deleted=0;
  collection.excelService.DeleteFilled=async()=>deleted++;
  globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
    if(request.method==='get'&&request.url.endsWith('/items'))return {data:{items:[{sourceSku:'401',rawPayload:sample('401'),exportData:sample('401')}]}};
    if(request.method==='get'&&request.url.endsWith('/events'))return {data:{events:[{id:1,payload:{items:[{sku:'402',state:'COLLECTED'}]}}]}};
    throw Error('Unexpected '+request.url);
  };
  await collection.restoreSavedResults({progress:{qualifiedCount:1,totalCount:30},resultSummary:{dedup:{collected:1}}});
  assert.equal(deleted,1);assert.equal(collection.targetData,1);assert.equal(collection.getRunProgress().totalCount,30);
  assert.deepEqual(exported.map(item=>item.sku),['401']);
  assert.deepEqual((await collection.parseService.ozonDetailListParser([sample('401'),sample('403')])).map(item=>item.sku),['403']);
  await collection.recordDuplicateSkus([{sku:'402',state:'COLLECTED'}]);
  assert.equal(collection.dedup.collected,1,'resuming does not count an old skip again');
`));
