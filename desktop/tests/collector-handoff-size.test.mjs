import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('automatic handoff reads identities and imports all 200 groups in bounded batches', () => {
 const script = `
 import assert from 'node:assert/strict';
 import {addCollectorResultsToCollectBox} from ${JSON.stringify(new URL('../dist-electron/services/collector-backend.services.js',import.meta.url).href)};
 const batches=[];
 globalThis.__DESKTOP_AXIOS_HANDLER__=async req=>{
  if(req.method==='get') { assert.equal(req.params.view,'identity'); return {data:{items:Array.from({length:200},(_,i)=>({id:'item-'+i,sourceKey:'group-'+i}))}}; }
  assert.ok(req.data.itemIds.length<=10);batches.push(req.data.itemIds);
  return {data:{selected:req.data.itemIds.length,added:req.data.itemIds.length,results:req.data.itemIds.map(id=>({collectorItemId:id,collectItemId:'collect-'+id})),errors:[],missing:[]}};
 };
 const result=await addCollectorResultsToCollectBox({runId:'run',allQualified:true});
 assert.equal(result.results.length,200);assert.equal(result.ok,true);assert.equal(batches.length,20);
 assert.equal(new Set(batches.flat()).size,200);
 `;
 const result=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
