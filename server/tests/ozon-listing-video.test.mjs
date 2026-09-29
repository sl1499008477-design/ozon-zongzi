import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {readFile,access,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {downloadOzonListingVideo} from '../ozon-listing-video.mjs';

const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(1024,7)]);
const source='https://v-1.ozone.ru/vod/video-69/sample/asset_0_h264.mp4?type=pdp';
const publicLookup=async()=>[{address:'8.8.8.8',family:4}];
function transport(response,calls=[]){return (url,options,onResponse)=>{
 const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=error=>{queueMicrotask(()=>req.emit('error',error));};
 req.end=()=>queueMicrotask(()=>{calls.push(url.href);options.lookup(url.hostname,{all:true},(error,addresses)=>{assert.ifError(error);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});
  const res=Readable.from(response.body===undefined?[bytes]:[response.body]);res.statusCode=response.statusCode||200;res.headers=response.headers||{'content-type':'video/mp4','content-length':String(bytes.length)};onResponse(res);
 });return req;
};}
test('video download writes the whole file, checks actual bytes and cleans up its temporary file',async()=>{
 const result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,request:transport({})});
 assert.equal(result.size,bytes.length);assert.deepEqual(await readFile(result.path),bytes);assert.equal(result.contentType,'video/mp4');
 await result.cleanup();await assert.rejects(access(result.path));
});
test('private DNS and literal metadata addresses are rejected before opening a socket',async()=>{
 let requested=false;const request=()=>{requested=true;throw Error('unexpected request');};
 await assert.rejects(downloadOzonListingVideo(source,{lookupHost:async()=>[{address:'127.0.0.1',family:4}],request}),/私网|本机/);
 await assert.rejects(downloadOzonListingVideo('https://169.254.169.254/latest/',{request}),/私网|本机/);
 assert.equal(requested,false);
});
test('redirects cannot move a public video download to metadata or plain HTTP',async()=>{
 for(const location of ['https://100.100.100.200/latest/','http://v-1.ozone.ru/video.mp4']){
  const calls=[];await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:transport({statusCode:302,headers:{location}},calls)}));assert.equal(calls.length,1);
 }
});
test('an HTML response, partial body or oversized file never becomes a ready video',async()=>{
 for(const response of [
  {body:Buffer.from('<html>blocked</html>'),headers:{'content-type':'text/html'}},
  {body:Buffer.from('<html>not a video</html>'),headers:{'content-type':'video/mp4'}},
  {headers:{'content-type':'video/mp4','content-length':String(bytes.length+100)}},
  {headers:{'content-type':'video/mp4','content-length':'999999999999'}},
 ])await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:transport(response)}));
});

function sequenceTransport(steps,calls){return (url,options,onResponse)=>{
 const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=error=>queueMicrotask(()=>req.emit('error',error));
 req.end=()=>queueMicrotask(()=>{const step=steps[calls.length];calls.push({url:url.href,headers:options.headers});assert.ok(step,'bounded request count');
  const res=step.interrupt?Readable.from((async function*(){yield step.body;throw Object.assign(new Error('reset'),{code:'ECONNRESET'});})()):Readable.from([step.body]);
  res.statusCode=step.status||200;res.headers={'content-type':'video/mp4',...step.headers};onResponse(res);
 });return req;
};}

test('interrupted video resumes only a matching strong ETag and exact Content-Range',async()=>{
 const calls=[],part=bytes.subarray(0,512),events=[];
 const result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,onProgress:event=>events.push(event),request:sequenceTransport([
  {interrupt:true,body:part,headers:{'content-length':String(bytes.length),etag:'"stable"'}},
  {status:206,body:bytes.subarray(512),headers:{'content-length':String(bytes.length-512),etag:'"stable"','content-range':`bytes 512-${bytes.length-1}/${bytes.length}`}},
 ],calls)});
 try{assert.deepEqual(await readFile(result.path),bytes);assert.equal(calls[1].headers.Range,'bytes=512-');assert.equal(calls[1].headers['If-Range'],'"stable"');
 assert.equal(result.diagnostics.resumedBytes,512);assert.equal(result.diagnostics.networkBytes,bytes.length);assert(events.some(event=>event.phase==='complete'));}
 finally{await result.cleanup();}
});

test('a server ignoring Range replaces the partial file with its complete body',async()=>{
 const calls=[];
 const result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,request:sequenceTransport([
  {interrupt:true,body:bytes.subarray(0,512),headers:{'content-length':String(bytes.length),etag:'"stable"'}},
  {body:bytes,headers:{'content-length':String(bytes.length),etag:'"stable"'}},
 ],calls)});
 try{assert.deepEqual(await readFile(result.path),bytes);assert.equal(calls.length,2);assert.equal(result.diagnostics.resumedBytes,0);assert.equal(result.diagnostics.discardedBytes,512);}
 finally{await result.cleanup();}
});

test('changed ETag or invalid Content-Range is never appended and falls back to one full download',async()=>{
 for(const headers of [{etag:'"changed"','content-range':`bytes 512-${bytes.length-1}/${bytes.length}`},{etag:'"stable"','content-range':`bytes 0-${bytes.length-513}/${bytes.length}`}]){
  const calls=[];
  const result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,request:sequenceTransport([
   {interrupt:true,body:bytes.subarray(0,512),headers:{'content-length':String(bytes.length),etag:'"stable"'}},
   {status:206,body:Buffer.alloc(bytes.length-512,99),headers:{'content-length':String(bytes.length-512),...headers}},
   {body:bytes,headers:{'content-length':String(bytes.length),etag:'"new"'}},
  ],calls)});
  try{assert.deepEqual(await readFile(result.path),bytes);assert.equal(calls.length,3);assert.equal(calls[2].headers.Range,undefined);}
  finally{await result.cleanup();}
 }
});

test('cancellation during a partial read preserves its sentinel and removes temporary video files',async()=>{
 const stop=Object.assign(new Error('paused'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});let checkpoints=0;
 const temporaryRoot=await mkdtemp(join(tmpdir(),'video-cancel-test-'));
 try{
  const body=Buffer.concat([bytes,Buffer.alloc(8*1024**2)]);
  await assert.rejects(downloadOzonListingVideo(source,{temporaryRoot,lookupHost:publicLookup,request:transport({body,headers:{'content-type':'video/mp4','content-length':String(body.length+100)}}),
   checkControl:async()=>{if(++checkpoints>=4)throw stop;}}),caught=>caught===stop);
  assert.deepEqual(await readdir(temporaryRoot),[]);assert.equal(stop.mediaDiagnostics.networkBytes,body.length);
 }finally{await rm(temporaryRoot,{recursive:true,force:true});}
});

test('repeated resets without a strong validator stop after three body requests',async()=>{
 const calls=[];
 await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:sequenceTransport(Array.from({length:3},()=>({interrupt:true,body:bytes.subarray(0,512),headers:{'content-length':String(bytes.length),etag:'W/"weak"'}})),calls)}),{code:'ECONNRESET'});
 assert.equal(calls.length,3);assert(calls.every(call=>call.headers.Range===undefined));
});

const largeVideo=Buffer.alloc(4*1024**2);
for(let part=0;part<4;part++)largeVideo.fill(part+1,part*1024**2,(part+1)*1024**2);
bytes.copy(largeVideo,0,0,12);
const digest=value=>createHash('sha256').update(value).digest('hex');
function rangeSource({data=largeVideo,headers={},changePart,replace=data,stallParts=false,stallHeaders=false,failFallback=false}={}){
 const calls=[],responses=[];let activeParts=0,peakParts=0,closedBeforeParts=true,partialReads=0;
 const request=(url,options,onResponse)=>{
  const req=new EventEmitter();let res;req.setTimeout=()=>{};
  req.destroy=error=>{res?.destroy(error);if(error)queueMicrotask(()=>req.emit('error',error));};
  req.end=()=>queueMicrotask(()=>{
   const index=calls.length,range=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range||'');
   calls.push({url:url.href,...options});
   if(range)closedBeforeParts&&=responses[0].destroyed;
   const start=range?Number(range[1]):0,end=range?Number(range[2]):data.length-1;
   const full=index?replace:data;
   let plan={status:range?206:200,body:range?data.subarray(start,end+1):full,
    headers:{'content-type':'video/mp4','content-length':String(range?end-start+1:full.length),etag:'"stable"','accept-ranges':'bytes',...headers,
     ...(range?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})}};
   if(range&&changePart)plan={...plan,...changePart({start,end,plan})};
   if(!range&&index&&failFallback)plan={status:503,body:Buffer.alloc(0),headers:{}};
   res=range&&stallParts?new Readable({read(){if(!this.sent){this.sent=true;partialReads++;this.push(plan.body.subarray(0,65536));}}}):Readable.from((async function*(){
    for(let offset=0;offset<plan.body.length;offset+=65536){await new Promise(resolve=>setImmediate(resolve));yield plan.body.subarray(offset,offset+65536);}
   })());
   res.statusCode=plan.status;res.headers=plan.headers;res.on('error',()=>{});responses.push(res);
   if(range){activeParts++;peakParts=Math.max(peakParts,activeParts);res.once('close',()=>activeParts--);}
   if(!(range&&stallHeaders))onResponse(res);
  });return req;
 };
 return {request,calls,responses,get peakParts(){return peakParts;},get activeParts(){return activeParts;},get partialReads(){return partialReads;},get closedBeforeParts(){return closedBeforeParts;}};
}

for(const acceptRanges of ['bytes','bytes, bytes'])test(`large video with Accept-Ranges ${acceptRanges} downloads four disjoint parts on the pinned IP and hashes the ordered file`,async()=>{
 const fixture=rangeSource({headers:{'accept-ranges':acceptRanges}}),result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request});
 try{
  assert.deepEqual(await readFile(result.path),largeVideo);assert.equal(result.sha256,digest(largeVideo));
  assert.equal(fixture.calls.length,5);assert.equal(fixture.peakParts,4);assert.equal(fixture.closedBeforeParts,true);
  assert.deepEqual(fixture.calls.slice(1).map(call=>call.headers.Range),['bytes=0-1048575','bytes=1048576-2097151','bytes=2097152-3145727','bytes=3145728-4194303']);
  for(const call of fixture.calls){assert.equal(call.agent,false);assert.equal(call.rejectUnauthorized,undefined);
   call.lookup('v-1.ozone.ru',{all:true},(error,addresses)=>{assert.ifError(error);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});}
  assert(fixture.calls.slice(1).every(call=>call.headers['If-Range']==='"stable"'));
  assert.equal(result.diagnostics.networkBytes,largeVideo.length);assert.equal(result.diagnostics.parallelConnections,4);
 }finally{await result.cleanup();}
});

test('small videos and sources without explicit ranges, strong ETag or known length retain a single request',async()=>{
 for(const options of [{data:bytes},{headers:{'accept-ranges':undefined}},{headers:{'accept-ranges':'kilobytes'}},{headers:{etag:'W/"weak"'}},{headers:{'content-length':undefined}}]){
  const fixture=rangeSource(options),result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request});
  try{assert.equal(fixture.calls.length,1);assert.deepEqual(await readFile(result.path),options.data||largeVideo);}
  finally{await result.cleanup();}
 }
});

test('ignored, changed, malformed or incomplete ranges are discarded before one whole-file fallback',async()=>{
 const replacement=Buffer.from(largeVideo);replacement.fill(99,1024);
 const changes=[
  plan=>({status:200,headers:{...plan.headers,'content-length':String(largeVideo.length)}}),
  plan=>({headers:{...plan.headers,etag:'"changed"'}}),
  plan=>({headers:{...plan.headers,'content-range':'bytes 1-1048576/4194304'}}),
  plan=>({headers:{...plan.headers,'content-type':'video/quicktime'}}),
  plan=>({headers:{...plan.headers,'content-encoding':'gzip'}}),
  plan=>({headers:{...plan.headers,'content-length':undefined}}),
  plan=>({body:plan.body.subarray(0,1024)}),
  plan=>({body:Buffer.concat([plan.body,Buffer.from([1])])}),
  plan=>({status:302,headers:{location:'https://127.0.0.1/private'}}),
 ];
 for(const change of changes){
  const fixture=rangeSource({replace:replacement,changePart:({start,plan})=>start===0?change(plan):{}});
  const result=await downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request});
  try{assert.equal(digest(await readFile(result.path)),digest(replacement));assert.equal(result.sha256,digest(replacement));
   assert.equal(fixture.calls.length,6);assert.equal(fixture.calls.at(-1).headers.Range,undefined);assert.equal(fixture.activeParts,0);
   assert(result.diagnostics.parallelFallback);}
  finally{await result.cleanup();}
 }
});

test('parallel failure cannot multiply the regular retry budget',async()=>{
 const fixture=rangeSource({failFallback:true,changePart:({plan})=>({headers:{...plan.headers,etag:'"changed"'}})});
 await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request}),{code:'VIDEO_DOWNLOAD_HTTP_503'});
 assert.equal(fixture.calls.length,7);assert.equal(fixture.calls.filter(call=>call.headers.Range).length,4);assert.equal(fixture.activeParts,0);
});

test('pause during missing range headers or a partial body aborts every part and removes temporary files',async()=>{
 for(const stallHeaders of [false,true]){
  const fixture=rangeSource({stallParts:true,stallHeaders}),stop=Object.assign(new Error('paused'),{code:'AI_LISTING_TASK_CONTROL_REQUESTED'});
  const temporaryRoot=await mkdtemp(join(tmpdir(),'video-range-pause-'));
  try{
   await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request,temporaryRoot,timeoutMs:3000,
    checkControl:async()=>{if(fixture.calls.length===5&&(stallHeaders||fixture.partialReads))throw stop;}}),caught=>caught===stop);
   assert.equal(fixture.calls.length,5);assert.equal(fixture.activeParts,0);assert(fixture.responses.every(res=>res.destroyed));
   if(!stallHeaders)assert(stop.mediaDiagnostics.networkBytes>0);
   assert.deepEqual(await readdir(temporaryRoot),[]);
  }finally{await rm(temporaryRoot,{recursive:true,force:true});}
 }
});

test('stalled parallel ranges share the original deadline and never fall back after it expires',async()=>{
 const fixture=rangeSource({stallParts:true}),temporaryRoot=await mkdtemp(join(tmpdir(),'video-range-timeout-'));
 try{
  await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request,temporaryRoot,timeoutMs:70}),{code:'VIDEO_DOWNLOAD_TIMEOUT'});
  assert.equal(fixture.calls.length,5);assert.equal(fixture.activeParts,0);assert.deepEqual(await readdir(temporaryRoot),[]);
 }finally{await rm(temporaryRoot,{recursive:true,force:true});}
});

test('complete parallel bytes still require a valid MP4 header',async()=>{
 const fixture=rangeSource({data:Buffer.alloc(4*1024**2,0)});
 await assert.rejects(downloadOzonListingVideo(source,{lookupHost:publicLookup,request:fixture.request}),{code:'VIDEO_FILE_INVALID'});
 assert.equal(fixture.calls.length,5);assert.equal(fixture.activeParts,0);
});
