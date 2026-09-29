import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {validateCollectorMedia} from '../collector-media-validation.mjs';

test('image trust boundary decodes the real bytes and rejects MIME or checksum lies',async()=>{
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#ff0000'}}).png().toBuffer();
  const object={key:'staging/collector/a/image',size:bytes.length,contentType:'image/png',versionId:'a',etag:createHash('md5').update(bytes).digest('hex'),crc64:'123'};
  const readRange=async({start,end})=>bytes.subarray(start,end+1);
    const result=await validateCollectorMedia(object,{readRange,purpose:'video'});
  assert.equal(result.contentType,'image/png');assert.equal(result.validationBytes,bytes.length);assert.equal(result.width,8);
  await assert.rejects(validateCollectorMedia({...object,contentType:'image/jpeg'},{readRange}),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
  await assert.rejects(validateCollectorMedia({...object,etag:'f'.repeat(32)},{readRange}),{code:'COLLECTOR_MEDIA_CHECKSUM_MISMATCH'});
  const broken=bytes.subarray(0,40), brokenObject={...object,size:40,etag:createHash('md5').update(broken).digest('hex')};
  await assert.rejects(validateCollectorMedia(brokenObject,{readRange:async()=>broken}),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
});

test('video confirmation requires an actual executable and cancellation is immediate',async()=>{
  const object={size:100,contentType:'video/mp4',versionId:'v',etag:'abc',crc64:'1'};
  await assert.rejects(validateCollectorMedia(object,{ffprobePath:'',readRange:async()=>{throw Error('must not read');}}),{code:'COLLECTOR_MEDIA_PROBE_UNAVAILABLE'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(validateCollectorMedia(object,{signal:controller.signal}),{name:'AbortError'});
});

test('real ffprobe validates MP4 semantics through capped ranges and rejects invalid bytes, exhausted budget and cancellation',{
  skip:!process.env.COLLECTOR_MEDIA_FFPROBE_PATH||!process.env.COLLECTOR_MEDIA_TEST_VIDEO,timeout:15000},async()=>{
  const bytes=await readFile(process.env.COLLECTOR_MEDIA_TEST_VIDEO),object={size:bytes.length,contentType:'video/mp4',versionId:'pinned',etag:'etag',crc64:'123'};
  let fetched=0;
  const readRange=async({start,end,versionId})=>{assert.equal(versionId,'pinned');const chunk=bytes.subarray(start,end+1);fetched+=chunk.length;return chunk;};
  const result=await validateCollectorMedia(object,{readRange});
  assert.equal(result.validation,'ffprobe-bounded-mov-v1');assert.equal(result.duration,8);assert.ok(result.width>0&&result.height>0);assert.equal(result.validationBytes,fetched);assert.ok(fetched<=16*1024**2);
  await assert.rejects(validateCollectorMedia({...object,contentType:'video/quicktime'},{readRange,purpose:'video'}),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
  await assert.rejects(validateCollectorMedia(object,{readRange,purpose:'video-cover'}),{code:'ZONGZI_VIDEO_COVER_ASPECT_INVALID'});
  let limitedBytes=0;
  await assert.rejects(validateCollectorMedia(object,{maxProbeBytes:32,readRange:async input=>{limitedBytes+=input.end-input.start+1;return readRange(input);}}),{code:'COLLECTOR_MEDIA_PROBE_LIMIT'});
  assert.equal(limitedBytes,0);
  const html=Buffer.from('<html>not a video</html>');
  await assert.rejects(validateCollectorMedia({...object,size:html.length},{readRange:async()=>html}),{code:'COLLECTOR_MEDIA_FORMAT_INVALID'});
  const controller=new AbortController();
  await assert.rejects(validateCollectorMedia(object,{signal:controller.signal,readRange:async()=>{controller.abort();throw controller.signal.reason;}}),{name:'AbortError'});
});
