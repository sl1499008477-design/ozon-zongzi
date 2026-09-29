import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fsPromises,{mkdtemp,readFile,readdir,rm,stat,mkdir,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createCollectorMediaFilePreparer} from '../dist-electron/services/collection/media-download-cache.services.js';

const source={sourceUrl:'https://v-1.ozone.ru/shared.png',purpose:'color'};
async function fixture(t,handler){
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  const root=await mkdtemp(join(tmpdir(),'collector-cache-'));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return {root,options:{cacheScope:'account-one',retryDelayMs:0,lookupHost:async()=>[{address:'8.8.8.8',family:4}],
    request:(_target,options,callback)=>http.request({host:'127.0.0.1',port:server.address().port,path:'/',method:'GET',
      headers:options.headers,signal:options.signal,agent:false},callback)}};
}
const picture=()=>sharp({create:{width:24,height:32,channels:3,background:'#123456'}}).png().toBuffer();

test('two SKUs sharing a media URL download once and each keeps its file until its own upload finishes',async t=>{
  const bytes=await picture();let downloads=0;
  const {root,options}=await fixture(t,(_req,res)=>{downloads++;res.writeHead(200,{'content-length':bytes.length,etag:'"shared"'});setTimeout(()=>res.end(bytes),30);});
  const prepare=createCollectorMediaFilePreparer({root});
  const [a,b]=await Promise.all([prepare({...source,sourceSku:'one'},options),prepare({...source,sourceSku:'two'},options)]);
  assert.equal(downloads,1);assert.deepEqual(await readFile(a.path),bytes);
  await a.cleanup();assert.deepEqual(await readFile(b.path),bytes);await b.cleanup();
});

test('cancelling one subscriber does not abort another task downloading the same media',async t=>{
  const bytes=await picture();let downloads=0;
  const controller=new AbortController();
  const {root,options}=await fixture(t,(_req,res)=>{downloads++;res.writeHead(200,{'content-length':bytes.length,etag:'"shared"'});res.write(bytes.subarray(0,7));setTimeout(()=>res.end(bytes.subarray(7)),70);});
  const prepare=createCollectorMediaFilePreparer({root});
  const a=prepare(source,{...options,signal:controller.signal}),b=prepare(source,options);
  const rejected=assert.rejects(a,{name:'AbortError'});setTimeout(()=>controller.abort(),25);await rejected;
  const file=await b;assert.equal(downloads,1);assert.deepEqual(await readFile(file.path),bytes);await file.cleanup();
});

test('a new preparer after an application restart continues the previous download checkpoint',async t=>{
  const bytes=await picture(),requests=[];let broken=true;
  const {root,options}=await fixture(t,(req,res)=>{
    requests.push(req.headers);const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
    res.writeHead(offset?206:200,{'content-length':bytes.length-offset,etag:'"restart"',
      ...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
    if(broken){res.write(bytes.subarray(offset,offset+7));setTimeout(()=>res.destroy(),15);}else res.end(bytes.subarray(offset));
  });
  await assert.rejects(createCollectorMediaFilePreparer({root})(source,options));broken=false;
  const file=await createCollectorMediaFilePreparer({root})(source,options);
  assert.equal(requests[3].range,'bytes=21-');assert.deepEqual(await readFile(file.path),bytes);await file.cleanup();
});

test('two accounts never share the same pending transfer or cached file',async t=>{
  const bytes=await picture();let downloads=0;
  const {root,options}=await fixture(t,(_req,res)=>{downloads++;res.writeHead(200,{'content-length':bytes.length,etag:'"scoped"'});setTimeout(()=>res.end(bytes),25);});
  const prepare=createCollectorMediaFilePreparer({root});
  const [a,b]=await Promise.all([prepare(source,options),prepare(source,{...options,cacheScope:'account-two'})]);
  assert.equal(downloads,2);assert.notEqual(a.path,b.path);await a.cleanup();await b.cleanup();
});

test('cache budget eviction waits until every consumer finishes using a file',async t=>{
  const bytes=await picture();
  const {root,options}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-length':bytes.length,etag:'"budget"'});res.end(bytes);});
  const prepare=createCollectorMediaFilePreparer({root,maxCacheBytes:1});
  const [a,b]=await Promise.all([prepare(source,options),prepare(source,options)]);
  await a.cleanup();assert.deepEqual(await readFile(b.path),bytes);await b.cleanup();
  assert.deepEqual(await readdir(root),[]);
});

test('two retries started while the cancelled transfer closes still share one resumed download',async t=>{
  const bytes=await picture(),requests=[];let interrupted;
  const started=new Promise(resolve=>interrupted=resolve),controller=new AbortController();
  const {root,options}=await fixture(t,(req,res)=>{
    requests.push(req.headers);const offset=Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1]||0);
    res.writeHead(offset?206:200,{'content-length':bytes.length-offset,etag:'"resume"',
      ...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
    if(requests.length===1){res.write(bytes.subarray(0,7));interrupted();}else setTimeout(()=>res.end(bytes.subarray(offset)),30);
  });
  const prepare=createCollectorMediaFilePreparer({root});
  const initial=prepare(source,{...options,signal:controller.signal});const rejected=assert.rejects(initial,{name:'AbortError'});
  await started;await new Promise(resolve=>setTimeout(resolve,15));controller.abort();
  const [a,b]=await Promise.all([prepare(source,options),prepare(source,options)]);await rejected;
  assert.equal(requests.length,2);assert.equal(requests[1].range,'bytes=7-');
  assert.deepEqual(await readFile(a.path),bytes);await a.cleanup();await b.cleanup();
});

test('an unfinished item survives budget eviction and restart without asking the source for its completed bytes',async t=>{
  const bytes=await picture();let requests=0,offline=false;
  const {root,options}=await fixture(t,(_req,res)=>{requests++;if(offline){res.writeHead(503);res.end();return;}
    res.writeHead(200,{'content-length':bytes.length});res.end(bytes);});
  const cacheOwner={runId:'run-old',sourceKey:'product-one'};
  const first=createCollectorMediaFilePreparer({root,maxCacheBytes:1,retentionMs:-1});
  const file=await first(source,{...options,cacheOwner});await file.cleanup();
  assert.deepEqual(await readFile(file.path),bytes,'prepared bytes belong to an unfinished item');
  offline=true;
  const restarted=createCollectorMediaFilePreparer({root,maxCacheBytes:1,retentionMs:-1});
  const retry=await restarted(source,{...options,cacheOwner});
  assert.equal(requests,1);assert.deepEqual(await readFile(retry.path),bytes);await retry.cleanup();
  await restarted.acknowledge({cacheScope:options.cacheScope,cacheOwner});
  await assert.rejects(stat(file.path),{code:'ENOENT'});
});

test('shared files are deleted only after both durable item owners acknowledge across a restart',async t=>{
  const bytes=await picture();
  const {root,options}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-length':bytes.length,etag:'"owners"'});res.end(bytes);});
  const first={runId:'run-a',sourceKey:'one'},second={runId:'run-b',sourceKey:'two'};
  const prepare=createCollectorMediaFilePreparer({root});
  const [a,b]=await Promise.all([prepare(source,{...options,cacheOwner:first}),prepare(source,{...options,cacheOwner:second})]);
  await a.cleanup();await b.cleanup();
  const restarted=createCollectorMediaFilePreparer({root});
  await restarted.acknowledge({cacheScope:options.cacheScope,cacheOwner:first});
  assert.deepEqual(await readFile(b.path),bytes);
  await restarted.acknowledge({cacheScope:'different-account',cacheOwner:second});
  assert.deepEqual(await readFile(b.path),bytes,'another account cannot release the owner');
  await restarted.acknowledge({cacheScope:options.cacheScope,cacheOwner:second});
  await assert.rejects(stat(b.path),{code:'ENOENT'});
});

test('a successful explicit retry releases its predecessor item but preserves unrelated owners',async t=>{
  const bytes=await picture();
  const {root,options}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-length':bytes.length,etag:'"retry"'});res.end(bytes);});
  const old={runId:'old',sourceKey:'group-old'},current={runId:'retry',sourceKey:'group-new'},unrelated={runId:'other',sourceKey:'same-sku'};
  const prepare=createCollectorMediaFilePreparer({root});
  const files=await Promise.all([old,current,unrelated].map(cacheOwner=>prepare(source,{...options,cacheOwner})));
  for(const file of files)await file.cleanup();
  await prepare.acknowledge({cacheScope:options.cacheScope,cacheOwner:current,previousOwner:old});
  assert.deepEqual(await readFile(files[0].path),bytes);
  await prepare.acknowledge({cacheScope:options.cacheScope,cacheOwner:unrelated});
  await assert.rejects(stat(files[0].path),{code:'ENOENT'});
});

test('a retry chain releases its first failed owner after an intermediate run only reconciles uploaded receipts',async t=>{
  const bytes=await picture();
  const {root,options}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-length':bytes.length,etag:'"chain"'});res.end(bytes);});
  const first={runId:'first',sourceKey:'one'},second={runId:'second',sourceKey:'two'},third={runId:'third',sourceKey:'three'};
  const prepare=createCollectorMediaFilePreparer({root});
  const file=await prepare(source,{...options,cacheOwner:first});await file.cleanup();
  await prepare.retainItem({cacheScope:options.cacheScope,cacheOwner:second,previousOwner:first});
  const restarted=createCollectorMediaFilePreparer({root});
  await restarted.retainItem({cacheScope:options.cacheScope,cacheOwner:third,previousOwner:second});
  await restarted.acknowledge({cacheScope:options.cacheScope,cacheOwner:third});
  await assert.rejects(stat(file.path),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(root,'items')),[]);
});

test('cancelling the final subscriber waits for its partial-file writer to close and retains its owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'collector-cancel-owner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let began,finish,closing=false,settled=false,path;
  const started=new Promise(resolve=>began=resolve),closed=new Promise(resolve=>finish=resolve),controller=new AbortController();
  const prepare=createCollectorMediaFilePreparer({root,maxCacheBytes:1,prepareFile:async(_source,{cacheDirectory,signal})=>{
    await mkdir(cacheDirectory,{recursive:true});path=join(cacheDirectory,'source');await writeFile(path,'recoverable prefix');began();
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));closing=true;await closed;signal.throwIfAborted();
  }});
  const pending=prepare(source,{cacheScope:'account',cacheOwner:{runId:'run',sourceKey:'item'},signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'}).then(()=>{settled=true;});
  await started;controller.abort();for(let i=0;i<8;i++)await new Promise(setImmediate);
  try{assert.equal(closing,true);assert.equal(settled,false,'the cancelled transfer still owns its open writer');}
  finally{finish();await rejected;}
  assert.equal(await readFile(path,'utf8'),'recoverable prefix');
});

test('a full cache preserves unfinished files and rejects a new source before downloading it',async t=>{
  const bytes=await picture();let requests=0;
  const {root,options}=await fixture(t,(_req,res)=>{requests++;res.writeHead(200,{'content-length':bytes.length,etag:'"full"'});res.end(bytes);});
  const cacheOwner={runId:'run',sourceKey:'first'},prepare=createCollectorMediaFilePreparer({root,maxCacheBytes:1});
  const first=await prepare(source,{...options,cacheOwner});await first.cleanup();
  await assert.rejects(prepare({...source,sourceUrl:'https://v-1.ozone.ru/new.png'},
    {...options,cacheOwner:{runId:'run',sourceKey:'second'}}),{code:'COLLECTOR_MEDIA_CACHE_FULL'});
  assert.equal(requests,1);assert.deepEqual(await readFile(first.path),bytes);
  const retry=await prepare(source,{...options,cacheOwner});assert.equal(requests,1);await retry.cleanup();
  await prepare.acknowledge({cacheScope:options.cacheScope,cacheOwner});
  const second=await prepare({...source,sourceUrl:'https://v-1.ozone.ru/new.png'},{...options,cacheOwner:{runId:'run',sourceKey:'second'}});
  assert.equal(requests,2);await second.cleanup();
});

for(const failureAt of [1,2,3])test(`retry-chain cleanup survives owner deletion ${failureAt} failing and a process restart`,async t=>{
  const bytes=await picture();
  const {root,options}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-length':bytes.length,etag:'"interrupted-ack"'});res.end(bytes);});
  const first={runId:'first',sourceKey:'one'},second={runId:'second',sourceKey:'two'},third={runId:'third',sourceKey:'three'};
  const prepare=createCollectorMediaFilePreparer({root});
  const file=await prepare(source,{...options,cacheOwner:first});await file.cleanup();
  await prepare.retainItem({cacheScope:options.cacheScope,cacheOwner:second,previousOwner:first});
  await prepare.retainItem({cacheScope:options.cacheScope,cacheOwner:third,previousOwner:second});
  const realRm=fsPromises.rm;let deletions=0;
  const remove=t.mock.method(fsPromises,'rm',async(path,options)=>{
    if(String(path).startsWith(join(root,'items')+'/')&&String(path).endsWith('.json')&&++deletions===failureAt)
      throw Object.assign(Error('owner deletion interrupted'),{code:'EIO'});
    return realRm(path,options);
  });
  syncBuiltinESMExports();
  try{await assert.rejects(prepare.acknowledge({cacheScope:options.cacheScope,cacheOwner:third}),{code:'EIO'});}
  finally{remove.mock.restore();syncBuiltinESMExports();}
  assert.equal(deletions,failureAt);
  const restarted=createCollectorMediaFilePreparer({root});
  await restarted.acknowledge({cacheScope:options.cacheScope,cacheOwner:third});
  assert.deepEqual(await readdir(join(root,'items')),[],'the exact acknowledged current item must still reach its complete predecessor chain');
  await assert.rejects(stat(file.path),{code:'ENOENT'},'the earlier owners’ staged assets must remain reachable until cleanup finishes');
});
