import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {collectorMediaFixture} from '../../server/tests/support/collector-media-fixture.mjs';
import {prepareCollectorMediaFile} from '../dist-electron/services/collection/media-preparer.services.js';

test('native image download hashes real bytes, validates format, removes failed temp files and refuses private source addresses',async t=>{
  const bytes=await sharp({create:{width:4,height:6,channels:3,background:'#fff'}}).png().toBuffer();
  const sources=new Map([['source/image',bytes],['source/html',Buffer.from('<html>fake image</html>')],['source/large',Buffer.alloc(10*1024**2+1)]]);
  const f=await collectorMediaFixture(t,{sources}),temporaryRoot=await mkdtemp(join(tmpdir(),'desktop-media-file-'));t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  const options={temporaryRoot,request:f.request,lookupHost:async()=>[{address:'8.8.8.8',family:4}]};
  const source=name=>({sourceUrl:'https://source.test/source/'+name,purpose:'color'});
  const file=await prepareCollectorMediaFile(source('image'),options);assert.deepEqual(await readFile(file.path),bytes);assert.equal(file.contentType,'image/png');assert.equal(file.size,bytes.length);await file.cleanup();
  await assert.rejects(prepareCollectorMediaFile(source('html'),options),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
  await assert.rejects(prepareCollectorMediaFile(source('large'),options),{code:'COLLECTOR_MEDIA_TOO_LARGE'});
  await assert.rejects(prepareCollectorMediaFile(source('image'),{...options,lookupHost:async()=>[{address:'127.0.0.1',family:4}]}),{code:'COLLECTOR_MEDIA_URL_BLOCKED'});
  const controller=new AbortController();
  await assert.rejects(prepareCollectorMediaFile(source('image'),{...options,signal:controller.signal,lookupHost:async()=>{controller.abort();return [{address:'8.8.8.8',family:4}];}}),{name:'AbortError'});
  assert.deepEqual(await readdir(temporaryRoot),[]);
});

test('desktop downloads allow only exact Ozon CDN hosts mapped to benchmark proxy addresses',async t=>{
  const bytes=await sharp({create:{width:4,height:6,channels:3,background:'#fff'}}).png().toBuffer();
  const f=await collectorMediaFixture(t,{sources:new Map([['source/image',bytes]])});
  const temporaryRoot=await mkdtemp(join(tmpdir(),'desktop-media-proxy-'));t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  const benchmark=async()=>[{address:'198.18.0.9',family:4}],options={temporaryRoot,request:f.request,lookupHost:benchmark};
  for(const hostname of ['ir.ozone.ru','ir-20.ozone.ru','cdn7.ozone.ru','ir.ozonstatic.cn','ir-20.ozonstatic.cn','v-1.ozone.ru','cdnvideo.v.ozone.ru']){
    const file=await prepareCollectorMediaFile({sourceUrl:`https://${hostname}/source/image`,purpose:'color'},options);await file.cleanup();
  }
  for(const url of ['https://v-1.ozone.ru.evil.test/source/image','https://unknown.test/source/image','https://www.ozon.ru/source/image','https://v-1.ozone.ru:444/source/image']){
    await assert.rejects(prepareCollectorMediaFile({sourceUrl:url,purpose:'color'},options),{code:'COLLECTOR_MEDIA_URL_BLOCKED'});
  }
  await assert.rejects(prepareCollectorMediaFile({sourceUrl:'https://v-1.ozone.ru/source/image',purpose:'color'},
    {...options,lookupHost:async()=>[{address:'10.0.0.8',family:4}]}),{code:'COLLECTOR_MEDIA_URL_BLOCKED'});
});

test('desktop revalidates redirects and blocks HTTPS downgrade even for trusted Ozon CDN hosts',async t=>{
  const bytes=await sharp({create:{width:4,height:6,channels:3,background:'#fff'}}).png().toBuffer();
  const f=await collectorMediaFixture(t,{sources:new Map([['source/image',bytes]])});
  const temporaryRoot=await mkdtemp(join(tmpdir(),'desktop-media-redirect-'));t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  let calls=0;
  const request=(target,options,callback)=>{calls++;return f.request(target,options,response=>{
    if(calls===1){response.statusCode=302;response.headers.location='http://v-1.ozone.ru/source/image';}callback(response);
  });};
  await assert.rejects(prepareCollectorMediaFile({sourceUrl:'https://v-1.ozone.ru/source/image',purpose:'color'},
    {temporaryRoot,request,lookupHost:async()=>[{address:'198.18.0.9',family:4}]}),{code:'COLLECTOR_MEDIA_URL_BLOCKED'});
  assert.equal(calls,1);
  calls=0;
  const redirectToUnknown=(target,options,callback)=>{calls++;return f.request(target,options,response=>{
    if(calls===1){response.statusCode=302;response.headers.location='https://unknown.test/source/image';}callback(response);
  });};
  await assert.rejects(prepareCollectorMediaFile({sourceUrl:'https://v-1.ozone.ru/source/image',purpose:'color'},
    {temporaryRoot,request:redirectToUnknown,lookupHost:async()=>[{address:'198.18.0.9',family:4}]}),{code:'COLLECTOR_MEDIA_URL_BLOCKED'});
  assert.equal(calls,1);
});

test('native video preparation reuses compliant real bytes and removes its complete temporary directory',{
  skip:!process.env.OZON_VIDEO_TEST_INPUT||!process.env.OZON_VIDEO_FFMPEG_PATH||!process.env.OZON_VIDEO_FFPROBE_PATH},async t=>{
  const bytes=await readFile(process.env.OZON_VIDEO_TEST_INPUT),f=await collectorMediaFixture(t,{sources:new Map([['source/video',bytes]])});
  const temporaryRoot=await mkdtemp(join(tmpdir(),'desktop-video-file-'));t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  const file=await prepareCollectorMediaFile({sourceUrl:'https://source.test/source/video',purpose:'video'},
    {temporaryRoot,request:f.request,lookupHost:async()=>[{address:'8.8.8.8',family:4}],ffmpegPath:process.env.OZON_VIDEO_FFMPEG_PATH,ffprobePath:process.env.OZON_VIDEO_FFPROBE_PATH});
  assert.deepEqual(await readFile(file.path),bytes);assert.equal(file.contentType,'video/mp4');assert.equal(file.size,bytes.length);
  await file.cleanup();assert.deepEqual(await readdir(temporaryRoot),[]);
});
