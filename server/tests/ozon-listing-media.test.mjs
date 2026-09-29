import test from 'node:test';
import assert from 'node:assert/strict';
import {createOzonListingMedia} from '../ozon-listing-media.mjs';
import {normalizeOzonImportItems} from '../ozon-import-normalizer.mjs';

const sourceBase='https://www.example.test/';
const base='https://media.example.test/bucket/';
const prefix='listing-media/v1';
const imageKey=n=>`${prefix}/ai-image-listing/${String(n).padStart(64,'0')}.jpg`;
const videoUrls=['https://v-1.ozone.ru/vod/video-1/a/asset_1_h264.mp4?type=pdp','https://v-1.ozone.ru/vod/video-1/b/asset_1_h264.mp4?type=pdp','https://v-1.ozone.ru/vod/video-1/c/asset_1_h264.mp4?type=pdp'];
const makeItem=()=>({offer_id:'jz-4380440590',images:Array.from({length:11},(_,i)=>sourceBase+imageKey(i+1)),primary_image:sourceBase+imageKey(1),complex_attributes:[{attributes:[{id:21841,complex_id:100001,values:videoUrls.map(value=>({value}))},{id:21837,complex_id:100001,values:[{value:'Первый'},{value:'Второй'},{value:'Третий'}]}]}],attributes:[{id:11254,values:[{value:JSON.stringify({widgets:[{widgetName:'raShowcase',blocks:[{img:{src:sourceBase+imageKey(3)},link:'https://shop.example.test/product/1'}]}]})}]}]});
function setup({failVideo=false}={}){
 const stored=new Map();let downloads=0,cleaned=0;
 for(let i=1;i<=11;i++)stored.set(imageKey(i),{size:162912,metaData:{'content-type':'image/jpeg'}});
 const prepare=createOzonListingMedia({publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,
  statObject:async key=>{if(!stored.has(key))throw Object.assign(new Error('missing'),{code:'NotFound'});return stored.get(key);},
  putObjectFromFile:async({key,contentType,metadata})=>{stored.set(key,{size:640986,metaData:{'content-type':contentType,...metadata}});return {key,size:640986};},
  downloadVideo:async()=>{downloads++;if(failVideo===true||downloads<=Number(failVideo))throw Object.assign(new Error('timeout'),{code:'VIDEO_DOWNLOAD_TIMEOUT'});return {path:'/tmp/injected-video',contentType:'video/mp4',size:640986,sha256:'a'.repeat(64),cleanup:async()=>{cleaned++;}};},
  processVideoFile:async input=>({path:input.inputPath,contentType:input.contentType,size:input.size,processed:false}),
  downloadImage:async()=>assert.fail('generated pictures must use existing storage'),
 });
 return {prepare,stored,counts:()=>({downloads,cleaned})};
}
test('eleven images and three videos preserve source order, names and rich image placement using direct files',async()=>{
 const x=setup(),item=makeItem(),before=structuredClone(item);
 const result=await x.prepare({accountId:'owner',taskId:'task',items:[item]});
 assert.deepEqual(result[0].images,Array.from({length:11},(_,i)=>base+imageKey(i+1)));
 assert.equal(result[0].primary_image,base+imageKey(1));
 const attrs=result[0].complex_attributes[0].attributes;
 assert.equal(attrs[0].values.length,3);assert.equal(new Set(attrs[0].values.map(v=>v.value)).size,3);
 assert(attrs[0].values.every(v=>v.value.startsWith(base+prefix+'/prepared/')&&v.value.endsWith('.mp4')));
 assert.deepEqual(attrs[1].values,[{value:'Первый'},{value:'Второй'},{value:'Третий'}]);
 const rich=JSON.parse(result[0].attributes[0].values[0].value);
 assert.equal(rich.widgets[0].blocks[0].img.src,base+imageKey(3));assert.equal(rich.widgets[0].blocks[0].link,'https://shop.example.test/product/1');
 assert.deepEqual(item,before);assert.deepEqual(x.counts(),{downloads:3,cleaned:3});
 const repeated=await x.prepare({accountId:'owner',taskId:'task',items:[item]});
 assert.deepEqual(repeated,result);assert.deepEqual(x.counts(),{downloads:3,cleaned:3},'a prepared file is reused after a retry');
});
test('a failed video reports its product and index while retaining original picture order',async()=>{
 const x=setup({failVideo:true}),item=makeItem(),before=structuredClone(item);
 await assert.rejects(x.prepare({accountId:'owner',taskId:'task',items:[item]}),error=>error.code==='AI_LISTING_MEDIA_PREPARATION_FAILED'&&/4380440590/.test(error.message)&&/第 1 个视频/.test(error.message));
 assert.deepEqual(item,before);
});
test('one temporary video-source timeout is retried before returning a single complete publication list',async()=>{
 const x=setup({failVideo:1});
 const result=await x.prepare({accountId:'owner',taskId:'task',items:[makeItem()]});
 assert.equal(result[0].images.length,11);
 assert.equal(result[0].complex_attributes[0].attributes[0].values.length,3);
 assert.deepEqual(x.counts(),{downloads:4,cleaned:3});
});
test('missing generated image fails instead of submitting a partial gallery or downloading from the web proxy',async()=>{
 const x=setup();x.stored.delete(imageKey(3));
 await assert.rejects(x.prepare({accountId:'owner',taskId:'task',items:[makeItem()]}),/第 3 张图片/);
 assert.equal(x.counts().downloads,0);
});
test('a page-based video supported by Ozon keeps its URL and does not become an HTML file masquerading as MP4',async()=>{
 const x=setup(),item=makeItem();item.complex_attributes[0].attributes[0].values=[{value:'https://www.youtube.com/watch?v=ZwM0iBn03dY'}];
 const [out]=await x.prepare({accountId:'owner',taskId:'task',items:[item]});
 assert.equal(out.complex_attributes[0].attributes[0].values[0].value,'https://www.youtube.com/watch?v=ZwM0iBn03dY');assert.equal(x.counts().downloads,0);
});
test('rich-content navigation URLs remain links while both inline video and poster are prepared',async()=>{
 const x=setup(),item=makeItem();
 const rich={link:{url:'https://shop.example.test/product/1'},img:{url:sourceBase+imageKey(3)},text:`<video src="${videoUrls[0]}" poster="${sourceBase+imageKey(4)}"></video>`};
 item.attributes[0].values[0].value=JSON.stringify(rich);
 const [out]=await x.prepare({accountId:'owner',taskId:'task',items:[item]});
 const result=JSON.parse(out.attributes[0].values[0].value);
 assert.deepEqual(result.link,rich.link);
 assert.equal(result.img.url,base+imageKey(3));
 assert(result.text.includes(`poster="${base+imageKey(4)}"`));
 assert(!result.text.includes(videoUrls[0]));
});

test('ordinary video count above five fails explicitly before any source download',async()=>{
 const x=setup(),item=makeItem();item.complex_attributes[0].attributes[0].values=Array.from({length:6},(_,index)=>({value:`https://source.test/${index}.mp4`}));
 await assert.rejects(x.prepare({accountId:'owner',taskId:'task',items:[item]}),error=>error.reasonCode==='ZONGZI_VIDEO_COUNT_LIMIT');
 assert.equal(x.counts().downloads,0);
});

test('the real normalizer-to-media path refuses a sixth ordinary video instead of truncating it',async()=>{
 const x=setup(),videos=Array.from({length:6},(_,index)=>({url:`https://source.test/${index+1}.mp4`}));
 const item={offer_id:'six-videos',name:'Товар',description_category_id:10,type_id:20,price:'100.00',currency_code:'RUB',
  weight:100,depth:100,width:100,height:100,videos};
 await assert.rejects((async()=>{
  const normalized=await normalizeOzonImportItems([item],{strictTypeMatch:true,
   getCategoryAttributes:async()=>[21841,21837].map(id=>({id}))});
  return x.prepare({accountId:'owner',taskId:'task',items:normalized.items});
 })(),error=>error.code==='ZONGZI_VIDEO_COUNT_LIMIT');
 assert.equal(x.counts().downloads,0);
});

test('server fallback passes ordinary, cover and Rich purposes to the bounded video processor',async()=>{
 const purposes=[],stored=new Map(),videos=[
  {id:21841,value:'https://source.test/ordinary.mp4'},
  {id:21845,value:'https://source.test/cover.mp4'},
 ];
 const prepare=createOzonListingMedia({publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,
  statObject:async key=>{if(!stored.has(key))throw Object.assign(Error('missing'),{code:'NotFound'});return stored.get(key);},
  downloadVideo:async()=>({path:'/tmp/source-video',size:100,sha256:'a'.repeat(64),contentType:'video/mp4',cleanup:async()=>{}}),
  processVideoFile:async input=>{purposes.push(input.purpose);return {path:input.inputPath,size:input.size,contentType:input.contentType,processed:false};},
  putObjectFromFile:async({key})=>{stored.set(key,{size:100});return {size:100};},
 });
 const item={offer_id:'one',attributes:videos.map(row=>({id:row.id,values:[{value:row.value}]})).concat({id:11254,values:[{value:JSON.stringify({video:{src:'https://source.test/rich.mp4'}})}]})};
 await prepare({accountId:'owner',taskId:'task',items:[item]});
 assert.deepEqual(purposes,['video','video-cover','rich-video']);
});

test('pause raised during server video processing stops before upload and keeps the original control error',async()=>{
 const stop=Object.assign(new Error('paused'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});let cleaned=0,uploaded=0,checks=0;
 const prepare=createOzonListingMedia({publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,
  statObject:async()=>{throw Object.assign(Error('missing'),{code:'NotFound'});},
  downloadVideo:async()=>({path:'/tmp/source-video',size:100,sha256:'a'.repeat(64),contentType:'video/mp4',cleanup:async()=>{cleaned++;}}),
  processVideoFile:async input=>{await input.checkControl();return {path:input.inputPath,size:input.size,contentType:input.contentType,processed:false};},
  putObjectFromFile:async()=>{uploaded++;return {size:100};},
 });
 await assert.rejects(prepare({accountId:'owner',taskId:'task',items:[{offer_id:'one',attributes:[{id:21841,values:[{value:videoUrls[0]}]}]}],
  checkControl:async()=>{if(++checks>=4)throw stop;}}),error=>error===stop);
 assert.equal(uploaded,0);assert.equal(cleaned,1);
});

test('material preparation propagates cancellation unchanged and keeps an already uploaded file reusable',async()=>{
 const stored=new Map(),stop=Object.assign(new Error('paused'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});let cancelled=false,downloads=0,uploads=0,checks=0;
 const prepare=createOzonListingMedia({publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,
 statObject:async key=>{if(!stored.has(key))throw Object.assign(Error('missing'),{code:'NotFound'});return stored.get(key);},
 downloadImage:async()=>{downloads++;return {bytes:Buffer.from('validated source'),contentType:'image/png',contentHash:'a'.repeat(64)};},
 putObjectFromBuffer:async({key,buffer})=>{uploads++;stored.set(key,{size:buffer.length});cancelled=true;},
 });
 const input={accountId:'owner',taskId:'cancel-task',items:[{offer_id:'one',images:['https://source.test/a.png','https://source.test/b.png']}],checkControl:async()=>{checks++;if(cancelled)throw stop;}};
 await assert.rejects(prepare(input),error=>error===stop);assert.equal(uploads,1);assert.equal(checks>1,true);
 const result=await prepare({...input,checkControl:async()=>{}});assert.equal(result[0].images.length,2);assert.equal(uploads,2);assert.equal(downloads,2);
});

test('video storage transient failure retries identical file and emits byte/timing diagnostics',async()=>{
 const writes=[],diagnostics=[];let downloads=0,cleaned=0;
 const prepare=createOzonListingMedia({publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,onDiagnostic:event=>diagnostics.push(event),
 statObject:async()=>{throw Object.assign(Error('missing'),{code:'NotFound'});},
 downloadVideo:async()=>{downloads++;return {path:'/tmp/ready-video',size:100,sha256:'a'.repeat(64),contentType:'video/mp4',diagnostics:{networkBytes:110,resumedBytes:50,downloadMs:40},cleanup:async()=>{cleaned++;}};},
 processVideoFile:async input=>({path:input.inputPath,contentType:input.contentType,size:input.size,processed:false}),
 putObjectFromFile:async input=>{writes.push(input);if(writes.length===1)throw Object.assign(Error('reset'),{code:'ECONNRESET'});return {size:100};},
 });
 const result=await prepare({accountId:'owner',taskId:'retry-task',items:[{offer_id:'one',attributes:[{id:21841,values:[{value:videoUrls[0]}]}]}]});
 assert.equal(downloads,1);assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(cleaned,1);assert.equal(result.length,1);
 assert(diagnostics.some(event=>event.phase==='download'&&event.bytes===100&&event.networkBytes===110));assert(diagnostics.some(event=>event.phase==='upload'&&Number.isFinite(event.elapsedMs)));
});

for(const failedPhase of ['download','process','upload'])test(`video ${failedPhase} timeout retains its failing phase and completed stage timings`,async()=>{
 const events=[],failure=Object.assign(new Error('upstream timeout'),{code:failedPhase==='download'?'VIDEO_DOWNLOAD_TIMEOUT':failedPhase==='process'?'ZONGZI_VIDEO_PROCESS_TIMEOUT':'RequestTimeout'});
 if(failedPhase==='download')failure.mediaDiagnostics={downloadMs:300_000,networkBytes:1024,timeoutPhase:'body'};
 const prepare=createOzonListingMedia({publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,onDiagnostic:event=>events.push(event),
  statObject:async()=>{throw Object.assign(Error('missing'),{code:'NotFound'});},
  downloadVideo:async()=>{if(failedPhase==='download')throw failure;return {path:'/tmp/source-video',size:100,sha256:'a'.repeat(64),contentType:'video/mp4',cleanup:async()=>{}};},
  processVideoFile:async input=>{if(failedPhase==='process')throw failure;return {path:input.inputPath,size:input.size,contentType:input.contentType,processed:false};},
  putObjectFromFile:async()=>{throw failure;},
 });
 await assert.rejects(prepare({accountId:'owner',taskId:'stages',items:[{offer_id:'BX02-2',attributes:[{id:21841,values:[{value:videoUrls[0]}]}]}]}),error=>{
  assert.equal(error.mediaStage,failedPhase);
  assert.equal(error.definitelyNotSubmitted,true);
  assert.equal(error.mediaDiagnostics.phase,failedPhase);
  assert(Number.isFinite(error.mediaDiagnostics.timings[`${failedPhase}Ms`]));
  assert.match(error.message,failedPhase==='download'?/视频下载超时/:failedPhase==='process'?/视频处理超时/:/视频上传超时/);
  assert.doesNotMatch(error.message,/下载或处理超时/);
  if(failedPhase==='download')assert.equal(error.mediaDiagnostics.timeoutPhase,'body');
  return true;
 });
 assert(events.some(event=>event.phase==='failed'&&event.failedPhase===failedPhase&&event.label==='第 1 个视频'));
 if(failedPhase!=='download')assert(events.some(event=>event.phase==='download'&&Number.isFinite(event.elapsedMs)));
 if(failedPhase==='upload')assert(events.some(event=>event.phase==='process'&&Number.isFinite(event.elapsedMs)));
});

test('a fresh preparation after the second video fails reuses the first upload and retains every source video',async()=>{
 const stored=new Map(),downloaded=[],events=[];let rejectSecond=true;
 const dependencies={publication:{baseUrl:sourceBase,prefix},downloadBaseUrl:base,onDiagnostic:event=>events.push(event),
  statObject:async key=>{if(!stored.has(key))throw Object.assign(Error('missing'),{code:'NotFound'});return stored.get(key);},
  downloadVideo:async url=>{downloaded.push(url);if(url===videoUrls[1]&&rejectSecond)throw Object.assign(Error('timeout'),{code:'VIDEO_DOWNLOAD_TIMEOUT',mediaDiagnostics:{downloadMs:300_000}});
   return {path:'/tmp/source-video',size:100,sha256:'a'.repeat(64),contentType:'video/mp4',cleanup:async()=>{}};},
  processVideoFile:async input=>({path:input.inputPath,size:input.size,contentType:input.contentType,processed:false}),
  putObjectFromFile:async({key})=>{stored.set(key,{size:100});return {size:100};},
 };
 const original={offer_id:'G03-1',attributes:[{id:21841,values:videoUrls.slice(0,2).map(value=>({value}))},{id:21837,values:[{value:'视频一'},{value:'视频二'}]}]};
 const input={accountId:'owner',taskId:'partial-videos',items:[original]},before=structuredClone(input);
 await assert.rejects(createOzonListingMedia(dependencies)(input),/第 2 个视频/);
 assert.equal(stored.size,1);assert.deepEqual(input,before);
 rejectSecond=false;
 const [result]=await createOzonListingMedia(dependencies)(input);
 assert.deepEqual(downloaded,[videoUrls[0],videoUrls[1],videoUrls[1]]);
 assert.equal(stored.size,2);assert.equal(result.attributes[0].values.length,2);
 assert.deepEqual(result.attributes[1],original.attributes[1]);assert.deepEqual(input,before);
 assert(events.some(event=>event.phase==='reuse'&&event.label==='第 1 个视频'&&event.bytes===100));
});
