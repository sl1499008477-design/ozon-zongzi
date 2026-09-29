import test from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../dist-electron/services/collection/media-preparer.services.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function ports(overrides={}){
  const uploaded=new Set(),files=[],puts=[],checkpoints=[];
  let next=0;
  return {files,puts,checkpoints,options:{
    capabilities:{mediaDirectUploadV1:true,mediaSharedReferencesV1:true},concurrency:3,
    prepareFile:async source=>{files.push(source);return {size:12,contentType:'image/png',md5:Buffer.alloc(16).toString('base64'),cleanup:async()=>{}};},
    issue:async()=>({uploadId:'upload-'+(++next)}),
    confirm:async(_run,_lease,id)=>{if(!uploaded.has(id))throw Object.assign(Error('missing'),{code:'COLLECTOR_MEDIA_NOT_UPLOADED'});return {mediaObject:{uploadId:id}};},
    persistIntent:async payload=>{checkpoints.push(structuredClone(payload));},
    upload:async ticket=>{puts.push(ticket.uploadId);uploaded.add(ticket.uploadId);},...overrides,
  }};
}
const row=sku=>({sku,videos:[{url:'https://source.test/a.mp4',coverUrl:'https://source.test/a.png'},
  {url:'https://source.test/b.mp4',coverUrl:'https://source.test/b.png'}],
  richContent:{content:Array.from({length:44},(_,i)=>({img:{src:`https://source.test/rich-${i}.png`}}))}});

test('eight variants keep all 384 logical slots while transferring only 48 shared assets',async()=>{
  const product={...row('1'),variants:Array.from({length:7},(_,i)=>row(String(i+2)))},p=ports();
  const result=await media.prepareCollectorMedia(product,p.options);
  assert.equal(result.mediaPreparation.status,'ready');assert.equal(result.mediaObjects.length,384);
  assert.equal(p.files.length,48);assert.equal(p.puts.length,48);
  assert.equal(new Set(result.mediaObjects.map(ref=>ref.uploadId)).size,48);
  assert.deepEqual(result.mediaObjects.map(({uploadId,...source})=>source),media.listCollectorMedia(product));
  assert.deepEqual(result.mediaIntents,[]);
});

test('older API capabilities retain separate upload receipts for separate slots',async()=>{
  const product={...row('1'),variants:[row('2')]},p=ports({capabilities:{mediaDirectUploadV1:true}});
  const result=await media.prepareCollectorMedia(product,p.options);
  assert.equal(result.mediaObjects.length,96);assert.equal(p.puts.length,96);
});

test('shared and variant-specific pictures and videos retain their exact SKU slots',async()=>{
  const product={sku:'red',color_image:'https://source.test/red.png',videos:[{url:'https://source.test/common.mp4'},{url:'https://source.test/red.mp4'}],
    richContent:{img:{src:'https://source.test/common.png'}},variants:[
      {sku:'blue',color_image:'https://source.test/blue.png',videos:[{url:'https://source.test/common.mp4'},{url:'https://source.test/blue.mp4'}],
        richContent:{img:{src:'https://source.test/common.png'}}},
    ]};
  const p=ports(),result=await media.prepareCollectorMedia(product,p.options);
  const refs=result.mediaObjects;
  assert.equal(refs.length,8);assert.equal(p.puts.length,6);
  for(const purpose of ['video','rich-image']){
    const common=refs.filter(ref=>ref.sourceUrl===`https://source.test/common.${purpose==='video'?'mp4':'png'}`);
    assert.equal(common.length,2);assert.equal(common[0].uploadId,common[1].uploadId);
  }
  const distinct=refs.filter(ref=>/\/(red|blue)\./.test(ref.sourceUrl));
  assert.equal(new Set(distinct.map(ref=>ref.uploadId)).size,4);
  for(const ref of distinct)assert.ok(ref.sourceUrl.includes('/'+ref.sourceSku+'.'));
  assert.deepEqual(refs.map(({uploadId,...source})=>source),media.listCollectorMedia(product));
});

test('a slow video does not hold up independent image preparation in its group',async()=>{
  const slow=deferred(),image=deferred();
  const p=ports({prepareFile:async source=>{
    if(source.purpose==='video')await slow.promise;else image.resolve();
    return {size:12,contentType:source.purpose==='video'?'video/mp4':'image/png',md5:Buffer.alloc(16).toString('base64'),cleanup:async()=>{}};
  }});
  const running=media.prepareCollectorMedia({sku:'1',videos:[{url:'https://source.test/a.mp4',coverUrl:'https://source.test/a.png'}]},p.options);
  try{await Promise.race([image.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('image blocked by video')),200))]);}
  finally{slow.resolve();await running;}
});

test('concurrent media checkpoints are serialized and include each intent before its PUT',async()=>{
  let saving=0,maxSaving=0;const durable=new Set();
  const p=ports({persistIntent:async payload=>{
    saving++;maxSaving=Math.max(maxSaving,saving);await new Promise(resolve=>setImmediate(resolve));
    for(const ref of [...payload.mediaObjects,...payload.mediaIntents])durable.add(ref.uploadId);saving--;
  }});
  const upload=p.options.upload;
  p.options.upload=async ticket=>{assert.ok(durable.has(ticket.uploadId));await upload(ticket);};
  const result=await media.prepareCollectorMedia(row('1'),p.options);
  assert.equal(result.mediaPreparation.status,'ready');assert.equal(maxSaving,1);
});

test('shared completed references survive failed-run recovery with every variant slot',async()=>{
  const product={sku:'1',color_image:'https://source.test/a.png',variants:[{sku:'2',color_image:'https://source.test/a.png'}]};
  const refs=media.listCollectorMedia(product).map(source=>({...source,uploadId:'old-shared'}));
  let issues=0,checkpoints=[];
  const result=await media.prepareCollectorMedia(product,{
    capabilities:{mediaDirectUploadV1:true,mediaSharedReferencesV1:true},concurrency:3,
    recovery:{runId:'old-run',itemId:'old-item',mediaObjects:refs,mediaIntents:[]},
    persistIntent:async payload=>checkpoints.push(structuredClone(payload)),
    issue:async(_run,_lease,input)=>{issues++;assert.equal(input.resumeUploadId,'old-shared');return {uploadId:'old-shared',confirmed:true,mediaObject:{uploadId:'old-shared'}};},
    prepareFile:async()=>{throw Error('must reuse confirmed object');},
  });
  assert.equal(checkpoints[0].mediaObjects.length,2);
  assert.equal(issues,1);assert.deepEqual(result.mediaObjects,refs);assert.equal(result.mediaPreparation.status,'ready');
});

test('global transfer slots admit at most four files and two videos, allowing images past queued videos',async()=>{
  assert.equal(typeof media.createCollectorMediaWorkQueue,'function');
  const queue=media.createCollectorMediaWorkQueue(),release=deferred(),started=deferred();
  let active=0,videos=0,maxActive=0,maxVideos=0;const starts=[];
  const jobs=['video','video','video','rich-image','rich-image','rich-image'].map((purpose,i)=>queue.run(async()=>{
    active++;if(purpose==='video')videos++;maxActive=Math.max(maxActive,active);maxVideos=Math.max(maxVideos,videos);
    starts.push(i);if(starts.length===4)started.resolve();await release.promise;
    active--;if(purpose==='video')videos--;
  },{source:{purpose}}));
  await started.promise;assert.deepEqual(starts,[0,1,3,4]);release.resolve();await Promise.all(jobs);
  assert.equal(maxActive,4);assert.equal(maxVideos,2);
});

test('cancelling a queued transfer never starts its I/O',async()=>{
  assert.equal(typeof media.createCollectorMediaWorkQueue,'function');
  const queue=media.createCollectorMediaWorkQueue({concurrency:1}),gate=deferred(),started=deferred();
  const first=queue.run(async()=>{started.resolve();await gate.promise;});await started.promise;
  const controller=new AbortController();let executed=false;
  const second=queue.run(async()=>{executed=true;},{signal:controller.signal});
  controller.abort();await assert.rejects(second,{name:'AbortError'});gate.resolve();await first;assert.equal(executed,false);
});
