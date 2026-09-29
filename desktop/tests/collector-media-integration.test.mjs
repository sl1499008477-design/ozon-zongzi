import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('actual Collection preserves failed media without a modal and can save the next ready product',()=>{
  const profile=mkdtempSync(join(tmpdir(),'collector-media-wiring-'));
  try{
    const script=`
      import assert from 'node:assert/strict';
      import {dialog} from 'electron';
      import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
      const calls=[],choices=[];
      dialog.showMessageBox=async options=>{choices.push(options);return {response:0};};
      globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{calls.push(request);return {data:{ok:true}};};
      const c=new Collection({_id:'task',taskName:'素材验收',targetCount:10},null);
      c.runId='run';c.leaseToken='lease';c.uuid='instance';c.capabilities={mediaDirectUploadV1:true,exportDataFromRaw:true};
      const item={sku:'123',videos:[{url:'https://source.test/main.mp4'}]};
      assert.equal(await c.persistRunItem(item),false);
      const saved=()=>calls.filter(call=>call.url.endsWith('/items')).at(-1).data.items[0];
      assert.equal(saved().status,'FAILED');assert.equal(saved().errorCode,'COLLECTOR_MEDIA_WAITING');
      assert.deepEqual(saved().rawPayload.videos,[{url:'https://source.test/main.mp4'}]);
      assert.equal(saved().rawPayload.mediaPreparation.status,'waiting');assert.equal(c.outcomes.failed,1);
      assert.equal(choices.length,0,'an individual media error must never block on a dialog');
      assert.equal(calls.some(call=>call.url.includes('/media-uploads')),false,'missing executable must not start an upload');
      const ready={sku:'456',mediaObjects:[{uploadId:'confirmed',sourceSku:'456',purpose:'video',index:0,sourceUrl:'https://source.test/ready.mp4'}],mediaPreparation:{mode:'desktop',status:'ready'}};
      assert.equal(await c.persistRunItem(ready),true);assert.deepEqual(saved().rawPayload.mediaObjects,ready.mediaObjects);
      assert.equal(saved().status,'QUALIFIED');assert.equal(choices.length,0);
      assert.equal(saved().exportDataFromRaw,true);await c.flushRunEvents();
    `;
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),'--input-type=module','-e',script],
      {encoding:'utf8',timeout:20_000,env:{...process.env,COLLECTOR_MEDIA_FFPROBE_PATH:'',DESKTOP_TEST_USER_DATA:profile}});
    assert.equal(child.status,0,child.stderr||child.stdout);
  }finally{rmSync(profile,{recursive:true,force:true});}
});

test('a slow media transfer does not hold the next product save or end the run before its transfer settles',()=>{
  const profile=mkdtempSync(join(tmpdir(),'collector-media-concurrency-'));
  try{
    const script=`
      import assert from 'node:assert/strict';
      import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
      const saved=[];let release,started;
      const gate=new Promise(resolve=>release=resolve),begin=new Promise(resolve=>started=resolve);
      globalThis.__COLLECTOR_MEDIA_IO__={prepareFile:async()=>{started();await gate;throw Object.assign(Error('fixture missing media'),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});}};
      globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{if(request.url.endsWith('/items'))saved.push(request.data.items[0]);return {data:{ok:true}};};
      const c=new Collection({_id:'task',taskName:'并行素材',targetCount:2},null);
      c.runId='run';c.leaseToken='lease';c.uuid='instance';c.capabilities={mediaDirectUploadV1:true};
      c.excelService.saveExcel=async()=>true;c.excelService.getFilePath=async()=>'';
      const slow=c.taskHandle({id:'slow',sku:'slow',storefrontPrice:null,color_image:'https://source.test/slow.png'});
      await begin;
      let fastFinished=false;
      const fast=c.taskHandle({id:'fast',sku:'fast',storefrontPrice:null}).then(()=>{fastFinished=true;});
      await new Promise(resolve=>setTimeout(resolve,30));
      try{assert.equal(fastFinished,true,'ready product must save while the other download is still pending');
        assert.equal(saved.filter(x=>x.status==='QUALIFIED')[0].sourceSku,'fast');
        let active=1,completed=false;c.taskQueueService.getActiveCount=()=>active;
        const finishing=c.waitForAllTasks().then(()=>{completed=true;});
        await new Promise(resolve=>setTimeout(resolve,20));
        assert.equal(completed,false,'run must remain open while media is still active');
        release();await slow;active=0;await finishing;
      }finally{release();await Promise.allSettled([slow,fast]);await c.flushRunEvents();}
    `;
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),
      '--loader',fileURLToPath(new URL('./fixtures/collector-media-loader.mjs',import.meta.url)),'--input-type=module','-e',script],
      {encoding:'utf8',timeout:7000,env:{...process.env,DESKTOP_TEST_USER_DATA:profile}});
    assert.equal(child.status,0,child.stderr||child.stdout);
  }finally{rmSync(profile,{recursive:true,force:true});}
});

test('a prepared product retains its target slot until its durable checkpoint is finalized',()=>{
  const profile=mkdtempSync(join(tmpdir(),'collector-media-target-'));
  try{
    const script=`
      import assert from 'node:assert/strict';
      import {Collection} from ${JSON.stringify(new URL('../dist-electron/services/collection/collection.services.js',import.meta.url).href)};
      let release,started;const gate=new Promise(r=>release=r),begin=new Promise(r=>started=r),saved=[];
      globalThis.__COLLECTOR_MEDIA_IO__={prepareFile:async()=>({size:12,contentType:'image/png',md5:'x',cleanup:async()=>{}}),
        issue:async()=>({uploadId:'one'}),confirm:async()=>{if(!release.confirmed)throw Object.assign(Error('missing'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});return {mediaObject:{uploadId:'one'}};},
        upload:async()=>{started();await gate;release.confirmed=true;}};
      globalThis.__DESKTOP_AXIOS_HANDLER__=async request=>{if(request.url.endsWith('/items'))saved.push(request.data.items[0]);return {data:{ok:true}};};
      const c=new Collection({_id:'task',taskName:'目标名额',targetCount:1},null);
      c.runId='run';c.leaseToken='lease';c.uuid='instance';c.capabilities={mediaDirectUploadV1:true};
      c.excelService.saveExcel=async()=>true;c.excelService.getFilePath=async()=>'';
      const slow=c.taskHandle({id:'slow',sku:'slow',storefrontPrice:null,color_image:'https://source.test/a.png'});
      await begin;const fast=c.taskHandle({id:'fast',sku:'fast',storefrontPrice:null});
      await new Promise(r=>setTimeout(r,30));
      try{assert.equal(saved.filter(x=>x.status==='QUALIFIED').length,0,'reserved product must keep its target slot');}
      finally{release();await Promise.allSettled([slow,fast]);await c.flushRunEvents();}
      assert.equal(c.targetData,1);assert.equal(c.writeQueue.length,0);
      assert.equal(saved.at(-1).sourceSku,'slow');assert.equal(saved.at(-1).status,'QUALIFIED');
      assert.equal(saved.at(-1).rawPayload.mediaPreparation.status,'ready');assert.equal(c.pendingProductSaves,0);
    `;
    const child=spawnSync(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-module-loader.mjs',import.meta.url)),
      '--loader',fileURLToPath(new URL('./fixtures/collector-media-loader.mjs',import.meta.url)),'--input-type=module','-e',script],
      {encoding:'utf8',timeout:7000,env:{...process.env,DESKTOP_TEST_USER_DATA:profile}});
    assert.equal(child.status,0,child.stderr||child.stdout);
  }finally{rmSync(profile,{recursive:true,force:true});}
});
