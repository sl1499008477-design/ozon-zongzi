import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

function probe(script){
  const profile=mkdtempSync(join(tmpdir(),'collector-lifecycle-'));
  try{
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import {mkdir,writeFile,readFile,stat,readdir} from 'node:fs/promises';
      import {join} from 'node:path';
      import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
      import {createCollectorMediaFilePreparer} from ${JSON.stringify(new URL('../dist-electron/services/collection/media-download-cache.services.js',import.meta.url).href)};
      const root=join(process.env.DESKTOP_TEST_USER_DATA,'cache'),files=[],saved=[];let failSource=false,saveAttempts=0,saveFailures=0,failedRow;
      const preparer=createCollectorMediaFilePreparer({root,maxCacheBytes:1,prepareFile:async(source,options)=>{
        if(failSource&&source.purpose==='rich-image')throw Object.assign(Error('source failed'),{code:'ECONNRESET'});
        await mkdir(options.cacheDirectory,{recursive:true});const path=join(options.cacheDirectory,'source');
        await writeFile(path,'prepared image');files.push(path);
        return {path,size:14,contentType:'image/png',md5:'checksum',cleanup:async()=>{}};
      }});
      globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{
        if(request.url.endsWith('/media-uploads'))return {data:{uploadId:request.data.sourceUrl,confirmed:true,mediaObject:{uploadId:request.data.sourceUrl}}};
        if(request.url.endsWith('/items')&&request.method==='get')return {data:{items:failedRow?[failedRow]:[]}};
        if(request.url.endsWith('/items')&&request.method==='post'){
          const item=structuredClone(request.data.items[0]);saved.push(item);
          if(item.status==='QUALIFIED'){
            saveAttempts++;
            for(const path of new Set(files))assert.equal((await stat(path)).isFile(),true,'a save still needs its local staged files');
            if(saveAttempts<=saveFailures)throw Object.assign(Error('save response lost'),{code:'ECONNRESET'});
          }
          return {data:{results:[{item:{id:'saved-item',status:item.status},created:saveAttempts===1}]}};
        }
        return {data:{ok:true}};
      };
      function collection(runId,extra={}){
        const c=new Collection({_id:'task',taskName:'存放验收',targetCount:10,...extra},null,{prepareMediaFile:preparer});
        c.runId=runId;c.leaseToken='lease';c.uuid=runId;c.sellerContext={accountId:'account'};
        c.capabilities={mediaDirectUploadV1:true,exportDataFromRaw:true};return c;
      }
      ${script}
    `],{encoding:'utf8',timeout:15000,env:{...process.env,DESKTOP_TEST_USER_DATA:profile}});
    assert.equal(child.status,0,child.stderr||child.stdout);
  }finally{rmSync(profile,{recursive:true,force:true});}
}

test('Collection retains staging through a lost QUALIFIED response and deletes it only after save acknowledgement',()=>probe(`
  saveFailures=1;const c=collection('run');
  assert.equal(await c.persistRunItem({sku:'1',color_image:'https://source.test/a.png'}),true);
  assert.equal(saveAttempts,2);await assert.rejects(stat(files[0]),{code:'ENOENT'});await c.flushRunEvents();
`));

test('Collection retains staging when all QUALIFIED acknowledgements are lost',()=>probe(`
  saveFailures=3;const c=collection('run');
  await assert.rejects(c.persistRunItem({sku:'1',color_image:'https://source.test/a.png'}),{code:'ECONNRESET'});
  assert.equal(saveAttempts,3);assert.equal(await readFile(files[0],'utf8'),'prepared image');await c.flushRunEvents();
`));

test('an explicit retry learns predecessor ownership even when the failed item never issued a COS intent',()=>probe(`
  failSource=true;const old=collection('old');
  assert.equal(await old.persistRunItem({sku:'1',collectorGroupId:'old-group',color_image:'https://source.test/a.png',richContent:{img:{src:'https://source.test/b.png'}}}),false);
  failedRow={id:'old-item',sourceSku:'1',sourceKey:'old-group',rawPayload:saved.at(-1).rawPayload};
  assert.equal(failedRow.rawPayload.mediaObjects.length,0);assert.equal((await stat(files[0])).isFile(),true);
  failSource=false;const retry=collection('new',{retryFromRunId:'old'});
  retry.selectNewCandidates=async items=>items;retry.processData=async()=>{};retry.waitForAllTasks=async()=>{};
  await retry.retryFailedProducts();
  assert.equal(await retry.persistRunItem({sku:'1',collectorGroupId:'new-group',color_image:'https://source.test/a.png'}),true);
  await assert.rejects(stat(files[0]),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(root,'items')),[],'the successful retry must release the precise old owner');
  await old.flushRunEvents();await retry.flushRunEvents();
`));

test('restoring an exact QUALIFIED server record acknowledges a save whose responses were all lost',()=>probe(`
  saveFailures=3;const interrupted=collection('run');
  await assert.rejects(interrupted.persistRunItem({sku:'1',color_image:'https://source.test/a.png'}),{code:'ECONNRESET'});
  failedRow={id:'saved-item',status:'QUALIFIED',sourceKey:'1',sourceSku:'1',rawPayload:saved.at(-1).rawPayload};
  const restored=collection('run');restored.excelService.DeleteFilled=async()=>{};
  restored.excelService.saveExcel=async()=>true;restored.excelService.getFilePath=async()=>'';
  await restored.restoreSavedResults({progress:{qualifiedCount:1}});
  assert.equal(restored.targetData,1);assert.equal(saveAttempts,3,'restoration must not repeat the saved upload or item');
  await assert.rejects(stat(files[0]),{code:'ENOENT'});assert.deepEqual(await readdir(join(root,'items')),[]);
  await interrupted.flushRunEvents();await restored.flushRunEvents();
`));
