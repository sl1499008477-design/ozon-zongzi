import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
import {prepareCollectorMediaFile} from '../dist-electron/services/collection/media-preparer.services.js';

const source={sourceUrl:'https://v-1.ozone.ru/recovery.png',purpose:'color'};
async function fixture(t,handler){
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  const temporaryRoot=await mkdtemp(join(tmpdir(),'collector-recovery-'));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporaryRoot,{recursive:true,force:true});});
  return {temporaryRoot,lookupHost:async()=>[{address:'8.8.8.8',family:4}],retryDelayMs:0,
    request:(_target,options,callback)=>http.request({host:'127.0.0.1',port:server.address().port,path:'/',method:'GET',
      headers:options.headers,signal:options.signal,agent:false},callback)};
}
async function picture(){return sharp({create:{width:24,height:32,channels:3,background:'#123456'}}).png().toBuffer();}
function partial(res,bytes){res.write(bytes);const timer=setTimeout(()=>res.destroy(),20);res.on('close',()=>clearTimeout(timer));}

test('a dropped download resumes the same bytes without downloading its saved prefix again',async t=>{
  const bytes=await picture(),offset=35,requests=[];
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    if(requests.length===1){res.writeHead(200,{'content-length':bytes.length,etag:'"original"'});partial(res,bytes.subarray(0,offset));}
    else{res.writeHead(206,{'content-length':bytes.length-offset,etag:'"original"','content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`});res.end(bytes.subarray(offset));}
  });
  const file=await prepareCollectorMediaFile(source,options);
  assert.deepEqual(await readFile(file.path),bytes);assert.equal(requests.length,2);
  assert.equal(requests[1].range,'bytes=35-');assert.equal(requests[1]['if-range'],'"original"');
  await file.cleanup();assert.deepEqual(await readdir(options.temporaryRoot),[]);
});

test('a changed representation is fetched afresh instead of joining unrelated partial files',async t=>{
  const bytes=await picture(),requests=[];
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    if(requests.length===1){res.writeHead(200,{'content-length':bytes.length,etag:'"old"'});partial(res,bytes.subarray(0,35));}
    else if(requests.length===2){res.writeHead(206,{'content-length':bytes.length-35,etag:'"new"','content-range':`bytes 35-${bytes.length-1}/${bytes.length}`});res.end(Buffer.alloc(bytes.length-35));}
    else{res.writeHead(200,{'content-length':bytes.length,etag:'"new"'});res.end(bytes);}
  });
  const file=await prepareCollectorMediaFile(source,options);
  assert.deepEqual(await readFile(file.path),bytes);assert.equal(requests.length,3);assert.equal(requests[2].range,undefined);
  await file.cleanup();
});

test('an internally expired stream reports download timeout after bounded recovery and removes partial files',async t=>{
  const bytes=await picture();let requests=0;
  const options=await fixture(t,(_req,res)=>{requests++;res.writeHead(200,{'content-length':bytes.length});res.write(bytes.subarray(0,35));});
  const controller=new AbortController(),fallback=setTimeout(()=>controller.abort(),2500);
  try{await assert.rejects(prepareCollectorMediaFile(source,{...options,signal:controller.signal,downloadTimeoutMs:75,idleTimeoutMs:75}),{code:'COLLECTOR_MEDIA_DOWNLOAD_TIMEOUT'});}
  finally{clearTimeout(fallback);}
  assert.equal(requests,3);assert.deepEqual(await readdir(options.temporaryRoot),[]);
});

test('user cancellation interrupts a stalled read without retrying or changing the cancellation reason',async t=>{
  const controller=new AbortController();let requests=0;
  const options=await fixture(t,(_req,res)=>{requests++;res.writeHead(200,{'content-length':1000});res.write(Buffer.alloc(30));setTimeout(()=>controller.abort(),25);});
  await assert.rejects(prepareCollectorMediaFile(source,{...options,signal:controller.signal}),{name:'AbortError'});
  assert.equal(requests,1);assert.deepEqual(await readdir(options.temporaryRoot),[]);
});

test('a healthy slow stream keeps downloading beyond the request timeout while bytes keep arriving',async t=>{
  const bytes=await picture();let requests=0;
  const options=await fixture(t,(_req,res)=>{
    requests++;res.writeHead(200,{'content-length':bytes.length,etag:'"slow"'});
    let offset=0;
    const timer=setInterval(()=>{res.write(bytes.subarray(offset,offset+8));offset+=8;if(offset>=bytes.length){clearInterval(timer);res.end();}},20);
    res.on('close',()=>clearInterval(timer));
  });
  const file=await prepareCollectorMediaFile(source,{...options,downloadTimeoutMs:75,idleTimeoutMs:75});
  assert.deepEqual(await readFile(file.path),bytes);assert.equal(requests,1);
  await file.cleanup();
});

test('a later manual retry resumes the durable prefix left after all three connection attempts fail',async t=>{
  const bytes=await picture(),requests=[];let broken=true;
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
    res.writeHead(offset?206:200,{'content-length':bytes.length-offset,etag:'"durable"',
      ...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
    if(broken)partial(res,bytes.subarray(offset,offset+7));else res.end(bytes.subarray(offset));
  });
  const cacheDirectory=join(options.temporaryRoot,'durable');
  await assert.rejects(prepareCollectorMediaFile(source,{...options,cacheDirectory}));
  assert.equal(requests.length,3);broken=false;
  const file=await prepareCollectorMediaFile(source,{...options,cacheDirectory});
  assert.equal(requests[3].range,'bytes=21-');assert.equal(requests[3]['if-range'],'"durable"');
  assert.deepEqual(await readFile(file.path),bytes);await file.cleanup();
});

test('a changed source after a manual retry replaces the saved prefix instead of corrupting the file',async t=>{
  const original=await picture(),replacement=await sharp({create:{width:25,height:33,channels:3,background:'#abcdef'}}).png().toBuffer();
  const requests=[];let changed=false;
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    if(changed){res.writeHead(200,{'content-length':replacement.length,etag:'"replacement"'});res.end(replacement);return;}
    const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
    res.writeHead(offset?206:200,{'content-length':original.length-offset,etag:'"old"',
      ...(offset?{'content-range':`bytes ${offset}-${original.length-1}/${original.length}`}:{})});partial(res,original.subarray(offset,offset+7));
  });
  const cacheDirectory=join(options.temporaryRoot,'changed');
  await assert.rejects(prepareCollectorMediaFile(source,{...options,cacheDirectory}));changed=true;
  const file=await prepareCollectorMediaFile(source,{...options,cacheDirectory});
  assert.equal(requests[3].range,'bytes=21-');assert.deepEqual(await readFile(file.path),replacement);
  await file.cleanup();
});

test('a completed cached file is reused only after the source confirms the same ETag',async t=>{
  const bytes=await picture(),requests=[];
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    if(req.headers['if-none-match']==='"cached"'){res.writeHead(304,{etag:'"cached"'});res.end();}
    else{res.writeHead(200,{'content-length':bytes.length,etag:'"cached"'});res.end(bytes);}
  });
  const cacheDirectory=join(options.temporaryRoot,'cached');
  const first=await prepareCollectorMediaFile(source,{...options,cacheDirectory});await first.cleanup();
  const second=await prepareCollectorMediaFile(source,{...options,cacheDirectory});
  assert.equal(requests[1]['if-none-match'],'"cached"');assert.deepEqual(await readFile(second.path),bytes);
  await second.cleanup();
});

test('a transient cache revalidation error preserves the complete file for the next conditional request',async t=>{
  const bytes=await picture(),requests=[];let bodies=0;
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    if(requests.length===2){res.writeHead(503);res.end();}
    else if(req.headers['if-none-match']==='"cached"'){res.writeHead(304,{etag:'"cached"'});res.end();}
    else{bodies++;res.writeHead(200,{'content-length':bytes.length,etag:'"cached"'});res.end(bytes);}
  });
  const cacheDirectory=join(options.temporaryRoot,'cached-flaky');
  const first=await prepareCollectorMediaFile(source,{...options,cacheDirectory});await first.cleanup();
  const second=await prepareCollectorMediaFile(source,{...options,cacheDirectory});
  assert.equal(requests[2]['if-none-match'],'"cached"');assert.equal(bodies,1);
  assert.deepEqual(await readFile(second.path),bytes);await second.cleanup();
});

test('a continuously slow resumable transfer reconnects without downloading its prefix twice',async t=>{
  const bytes=await sharp(randomBytes(96*96*3),{raw:{width:96,height:96,channels:3}}).png().toBuffer();
  const requests=[],progress=[];
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
    res.writeHead(offset?206:200,{'content-length':bytes.length-offset,etag:'"slow-resume"',
      ...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
    if(requests.length>1){res.end(bytes.subarray(offset));return;}
    let sent=0;
    const timer=setInterval(()=>{res.write(bytes.subarray(sent,sent+64));sent+=64;},10);
    res.on('close',()=>clearInterval(timer));
  });
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1500);
  try {
    const file=await prepareCollectorMediaFile(source,{...options,signal:controller.signal,idleTimeoutMs:500,
      lowSpeedWindowMs:80,minDownloadBytesPerSecond:32*1024,onProgress:event=>progress.push(event)});
    assert.deepEqual(await readFile(file.path),bytes);
    assert.equal(requests.length,2);assert.match(requests[1].range,/^bytes=[1-9]\d*-$/);
    assert.equal(requests[1]['if-range'],'"slow-resume"');
    assert.ok(progress.some(event=>event.phase==='retrying'&&event.reason==='COLLECTOR_MEDIA_DOWNLOAD_SLOW'));
    await file.cleanup();
  } finally {clearTimeout(timeout);}
});

test('continued low throughput reconnects at most twice, then allows a progressing transfer to finish',async t=>{
  const bytes=await sharp(randomBytes(96*96*3),{raw:{width:96,height:96,channels:3}}).png().toBuffer();
  const requests=[];
  const options=await fixture(t,(req,res)=>{
    requests.push(req.headers);
    let offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
    res.writeHead(offset?206:200,{'content-length':bytes.length-offset,etag:'"persistently-slow"',
      ...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
    const timer=setInterval(()=>{
      res.write(bytes.subarray(offset,offset+512));offset+=512;
      if(offset>=bytes.length){clearInterval(timer);res.end();}
    },10);
    res.on('close',()=>clearInterval(timer));
  });
  const file=await prepareCollectorMediaFile(source,{...options,idleTimeoutMs:500,
    lowSpeedWindowMs:30,minDownloadBytesPerSecond:128*1024});
  assert.equal(requests.length,3);
  assert.deepEqual(await readFile(file.path),bytes);
  assert.ok(Number(requests[2].range.match(/\d+/)[0])>Number(requests[1].range.match(/\d+/)[0]));
  await file.cleanup();
});

test('a slow source without a resume validator keeps its progressing connection',async t=>{
  const bytes=await sharp(randomBytes(32*32*3),{raw:{width:32,height:32,channels:3}}).png().toBuffer();
  let requests=0;
  const options=await fixture(t,(_req,res)=>{
    requests++;res.writeHead(200,{'content-length':bytes.length});let offset=0;
    const timer=setInterval(()=>{
      res.write(bytes.subarray(offset,offset+128));offset+=128;
      if(offset>=bytes.length){clearInterval(timer);res.end();}
    },10);
    res.on('close',()=>clearInterval(timer));
  });
  const file=await prepareCollectorMediaFile(source,{...options,idleTimeoutMs:500,
    lowSpeedWindowMs:30,minDownloadBytesPerSecond:32*1024});
  assert.equal(requests,1);assert.deepEqual(await readFile(file.path),bytes);await file.cleanup();
});
