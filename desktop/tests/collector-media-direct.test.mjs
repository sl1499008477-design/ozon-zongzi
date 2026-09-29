import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCollectorMedia,listCollectorMedia} from '../dist-electron/services/collection/media-preparer.services.js';

const product=()=>({sku:'11',color_image:'https://source.test/color.png',videos:[{url:'https://source.test/video.mp4',coverUrl:'https://source.test/cover.png'},{url:'https://youtu.be/hosted'}],richContent:JSON.stringify({img:{src:'https://source.test/rich.png'}})});
test('desktop fixture preserves media order and URLs, confirms before reuse, uploads each intent only once',async()=>{
  const item=product(),before=structuredClone(item),objects=new Map();let uploaded=0,downloaded=0,cleaned=0;
  const ports={capabilities:{mediaDirectUploadV1:true},runId:'run',leaseToken:'lease',
    prepareFile:async source=>(downloaded++,{path:'/fixture',size:12,contentType:source.purpose.includes('video')&&!source.purpose.includes('poster')?'video/mp4':'image/png',md5:Buffer.alloc(16).toString('base64'),cleanup:async()=>{cleaned++;}}),
    issue:async(_run,_lease,source)=>({uploadId:source.purpose+source.index}),
    confirm:async(_run,_lease,id)=>{if(!objects.has(id))throw Object.assign(Error('not yet'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});return {mediaObject:{uploadId:id}};},
    upload:async ticket=>{objects.set(ticket.uploadId,true);uploaded++;}};
  const result=await prepareCollectorMedia(item,ports);
  assert.equal(result.mediaPreparation.status,'ready');assert.equal(result.mediaObjects.length,4);assert.equal(uploaded,4);assert.equal(downloaded,4);assert.equal(cleaned,4);
  for(const key of Object.keys(before))assert.deepEqual(result[key],before[key]);
  const retried=await prepareCollectorMedia(result,ports);assert.equal(uploaded,4);assert.equal(downloaded,4);assert.deepEqual(retried.mediaObjects,result.mediaObjects);
});
test('old backends retain the URL-only flow and a failed upload waits unless server fallback is explicitly selected',async()=>{
  const item=product();assert.deepEqual(await prepareCollectorMedia(item,{capabilities:{},prepareFile:()=>{throw Error('not called');}}),item);
  const ports={capabilities:{mediaDirectUploadV1:true},prepareFile:async()=>{throw Object.assign(Error('missing probe'),{code:'COLLECTOR_MEDIA_PROBE_UNAVAILABLE'});}};
  const failed=await prepareCollectorMedia(item,ports);assert.equal(failed.mediaPreparation.status,'waiting');assert.deepEqual(failed.videos,item.videos);assert.equal(failed.mediaObjects.length,0);
  let asked=0;
  const fallback=await prepareCollectorMedia(item,{...ports,chooseServerFallback:async()=>{asked++;return true;}});
  assert.equal(asked,1);assert.equal(fallback.mediaPreparation.mode,'server');assert.equal(fallback.mediaPreparation.status,'fallback');assert.deepEqual(fallback.richContent,item.richContent);
});
test('cancellation never becomes a server fallback or a successful upload',async()=>{
  const controller=new AbortController();controller.abort();let asked=false;
  await assert.rejects(prepareCollectorMedia(product(),{capabilities:{mediaDirectUploadV1:true},signal:controller.signal,chooseServerFallback:()=>{asked=true;}}),{name:'AbortError'});
  assert.equal(asked,false);
});
test('an invalid account or run claim stops preparation without offering server fallback',async()=>{
  for(const error of [Object.assign(Error('expired'),{code:'COLLECTOR_RUN_LEASE_EXPIRED'}),Object.assign(Error('scope'),{code:'COLLECTOR_MEDIA_CLAIM_MISMATCH'}),Object.assign(Error('changed'),{code:'ACCOUNT_CHANGED'}),Object.assign(Error('forbidden'),{status:403})]){
    let asked=0,cleaned=0;
    await assert.rejects(prepareCollectorMedia(product(),{capabilities:{mediaDirectUploadV1:true},
      prepareFile:async()=>({size:12,contentType:'image/png',md5:Buffer.alloc(16).toString('base64'),cleanup:async()=>{cleaned++;}}),
      issue:async()=>{throw error;},chooseServerFallback:async()=>{asked++;return true;}}),caught=>caught===error);
    assert.equal(asked,0);assert.equal(cleaned,4,'the entire local group is released after the first upload claim fails');
  }
});
test('source selectors include variant media and skip hosted videos',()=>{
  const sources=listCollectorMedia({...product(),variants:[{sku:'22',color_image:'https://source.test/second.png'}]});
  assert.equal(sources.length,5);assert.equal(sources[4].sourceSku,'22');assert.equal(sources.some(s=>s.sourceUrl.includes('youtu.be')),false);
});

test('failed media retains an unsigned intent and a new run restores confirmed and unknown objects before downloading',async()=>{
  const item={sku:'11',color_image:'https://source.test/color.png',videos:[{url:'https://source.test/video.mp4'}]};
  const objects=new Set(),intents=new Map(),queries=[];let files=0,puts=0,unknown=true;
  const ports=runId=>({capabilities:{mediaDirectUploadV1:true},runId,leaseToken:runId+'-lease',
    prepareFile:async source=>{files++;return {size:12,contentType:source.purpose==='video'?'video/mp4':'image/png',md5:Buffer.alloc(16).toString('base64'),cleanup:async()=>{}};},
    issue:async(_run,_lease,input)=>{
      if(input.resumeUploadId){assert.equal(input.previousItemId,'failed-item');queries.push(input.resumeUploadId);const intent=intents.get(input.resumeUploadId);
        return {...intent,confirmed:intent.purpose==='color',mediaObject:{uploadId:intent.uploadId},intent};}
      const intent={...input,uploadId:'old-'+input.purpose};intents.set(intent.uploadId,intent);
      return {uploadId:intent.uploadId,url:'https://secret.test/signed?token=do-not-persist',headers:{},intent};
    },
    confirm:async(_run,_lease,id)=>{queries.push(id);if(!objects.has(id))throw Object.assign(Error('absent'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});
      if(id==='old-video'&&unknown)throw Object.assign(Error('unknown'),{code:'ETIMEDOUT'});return {mediaObject:{uploadId:id}};},
    upload:async ticket=>{puts++;objects.add(ticket.uploadId);},chooseServerFallback:async()=>false});
  const failed=await prepareCollectorMedia(item,ports('old-run'));
  assert.equal(failed.mediaPreparation.status,'waiting');assert.equal(files,2);assert.equal(puts,2);
  assert.equal(failed.mediaIntents.length,1);assert.equal(failed.mediaIntents[0].uploadId,'old-video');assert.equal(failed.mediaIntents[0].size,12);
  assert.equal(JSON.stringify(failed).includes('do-not-persist'),false);
  unknown=false;const recovered=await prepareCollectorMedia(item,{...ports('new-run'),recovery:{runId:'old-run',itemId:'failed-item',...failed}});
  assert.equal(recovered.mediaPreparation.status,'ready');assert.equal(files,2);assert.equal(puts,2);
  assert.deepEqual(recovered.mediaObjects.map(ref=>ref.uploadId),['old-color','old-video']);assert.deepEqual(recovered.mediaIntents,[]);
  assert.equal(queries.at(-1),'old-video');assert.deepEqual(recovered.mediaRecovery,{runId:'old-run',itemId:'failed-item'});
});

test('recovery checkpoints every matching predecessor reference before the first reconcile request',async()=>{
  const item={sku:'11',color_image:'https://source.test/color.png',videos:[{url:'https://source.test/video.mp4'}]};
  const recovery={runId:'old-run',itemId:'failed-item',mediaObjects:[
    {sourceSku:'11',purpose:'color',index:0,sourceUrl:item.color_image,uploadId:'old-color'},
  ],mediaIntents:[
    {sourceSku:'11',purpose:'video',index:0,sourceUrl:item.videos[0].url,uploadId:'old-video',size:12,contentType:'video/mp4',md5:Buffer.alloc(16).toString('base64')},
  ]};
  let checkpoint,issues=0;
  const result=await prepareCollectorMedia(item,{capabilities:{mediaDirectUploadV1:true},runId:'new-run',leaseToken:'new-lease',recovery,
    persistIntent:async payload=>{checkpoint=structuredClone(payload);},prepareFile:async()=>{throw Error('must reconcile predecessor references before downloading');},
    issue:async()=>{issues++;throw Object.assign(Error('lost committed takeover response'),{code:'ETIMEDOUT'});},
    confirm:async()=>{throw Error('confirm must not precede the failed issue');},chooseServerFallback:async()=>false});
  assert.equal(result.mediaPreparation.status,'waiting');assert.equal(issues,1);
  assert.deepEqual(checkpoint.mediaObjects.map(ref=>ref.uploadId),['old-color']);
  assert.deepEqual(checkpoint.mediaIntents.map(ref=>ref.uploadId),['old-video']);
  assert.deepEqual(result.mediaIntents.map(ref=>ref.uploadId),['old-video']);
});

test('batch recovery keeps current evidence and deduplicates predecessor slots and upload ids',async()=>{
  const item={sku:'11',color_image:'https://source.test/color.png',videos:[{url:'https://source.test/video.mp4'}],mediaIntents:[
    {sourceSku:'11',purpose:'color',index:0,sourceUrl:'https://source.test/color.png',uploadId:'current-color',size:12,contentType:'image/png',md5:Buffer.alloc(16).toString('base64')},
  ]};
  const oldColor={sourceSku:'11',purpose:'color',index:0,sourceUrl:item.color_image,uploadId:'old-color'};
  const oldVideo={sourceSku:'11',purpose:'video',index:0,sourceUrl:item.videos[0].url,uploadId:'old-video',size:12,contentType:'video/mp4',md5:Buffer.alloc(16).toString('base64')};
  let checkpoint;
  const result=await prepareCollectorMedia(item,{capabilities:{mediaDirectUploadV1:true},runId:'new-run',leaseToken:'new-lease',
    recovery:{runId:'old-run',itemId:'failed-item',mediaObjects:[oldColor,oldColor],mediaIntents:[oldVideo,oldVideo]},
    persistIntent:async payload=>{checkpoint=structuredClone(payload);},prepareFile:async()=>{throw Error('must not download');},
    issue:async(_run,_lease,input)=>{assert.equal(input.resumeUploadId,'current-color');assert.equal(input.previousItemId,undefined);
      throw Object.assign(Error('stop after inspecting first reconcile'),{code:'ETIMEDOUT'});},
    confirm:async()=>{throw Error('must not confirm');},chooseServerFallback:async()=>false});
  assert.deepEqual(checkpoint.mediaObjects,[]);
  assert.deepEqual(checkpoint.mediaIntents.map(ref=>ref.uploadId),['current-color','old-video']);
  assert.equal(new Set(checkpoint.mediaIntents.map(ref=>ref.uploadId)).size,2);
  assert.deepEqual(result.mediaIntents.map(ref=>ref.uploadId),['current-color','old-video']);
});

test('failure to persist the upload intent stops before PUT',async()=>{
  let puts=0,cleaned=0;
  const result=await prepareCollectorMedia({sku:'11',color_image:'https://source.test/color.png'},
    {capabilities:{mediaDirectUploadV1:true},runId:'run',leaseToken:'lease',
      prepareFile:async()=>({size:12,contentType:'image/png',md5:Buffer.alloc(16).toString('base64'),cleanup:async()=>{cleaned++;}}),
      issue:async()=>({uploadId:'pending'}),confirm:async()=>{throw Object.assign(Error('absent'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});},
      persistIntent:async payload=>{assert.equal(payload.mediaIntents[0].uploadId,'pending');throw Object.assign(Error('save failed'),{code:'ENETUNREACH'});},
      upload:async()=>{puts++;},chooseServerFallback:async()=>false});
  assert.equal(result.mediaPreparation.status,'waiting');assert.equal(puts,0);assert.equal(cleaned,1);assert.equal(result.mediaIntents[0].uploadId,'pending');
});

test('cancellation during final temporary-file cleanup cannot report a ready product',async()=>{
  const controller=new AbortController();
  await assert.rejects(prepareCollectorMedia({sku:'11',color_image:'https://source.test/image.png'},
    {capabilities:{mediaDirectUploadV1:true},signal:controller.signal,
      prepareFile:async()=>({size:12,contentType:'image/png',md5:'x',cleanup:async()=>controller.abort()}),
      issue:async()=>({uploadId:'one',confirmed:true,mediaObject:{uploadId:'one'}})}),{name:'AbortError'});
});
