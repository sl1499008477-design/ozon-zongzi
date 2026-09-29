import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createListingMediaStorage} from '../listing-media-storage.mjs';
import {collectorMediaFixture} from './support/collector-media-fixture.mjs';

const env={LISTING_MEDIA_STORAGE:'cos',LISTING_COS_BUCKET:'fixture-1250000000',LISTING_COS_REGION:'ap-beijing',LISTING_COS_SECRET_ID:'fixture',LISTING_COS_SECRET_KEY:'fixture'};
test('collector authorization binds the staging key, method and integrity headers; exact-version copy is immutable',async()=>{
  const calls=[], bytes=Buffer.from('a fixture'), md5=createHash('md5').update(bytes).digest('base64');
  const cosClient={
    getObjectUrl(input,callback){calls.push(input);callback(null,{Url:'https://fixture.invalid/signed'});},
    async headObject(input){calls.push(input);return {ETag:'"'+Buffer.from(md5,'base64').toString('hex')+'"',headers:{'content-type':'video/mp4','content-length':String(bytes.length),'x-cos-version-id':input.VersionId||'formal-version','x-cos-hash-crc64ecma':'123'}};},
    async putObjectCopy(input){calls.push(input);return {statusCode:200,ETag:'"etag"'};},
  };
  const storage=createListingMediaStorage({env,cosClient,fetchObject:async()=>new Response(bytes.subarray(0,4),{status:206,headers:{'content-range':`bytes 0-3/${bytes.length}`,'x-cos-version-id':'version-a'}})});
  assert.equal(typeof storage.signCollectorPut,'function','COS must expose the restricted collector contract');
  const signed=await storage.signCollectorPut({key:'staging/collector/a/random',contentType:'video/mp4',md5,expires:600});
  assert.equal(signed.url,'https://fixture.invalid/signed');assert.deepEqual(signed.headers,{'Content-Type':'video/mp4','Content-MD5':md5});
  assert.equal(calls[0].Method,'PUT');assert.equal(calls[0].Key,'staging/collector/a/random');assert.equal(calls[0].Expires,600);
  await assert.rejects(storage.signCollectorPut({key:'listing-media/v1/formal.mp4',contentType:'video/mp4',md5}),/staging/);
  const source=await storage.headCollectorObject({key:'staging/collector/a/random',versionId:'version-a'});
  assert.equal(source.versionId,'version-a');assert.equal(source.crc64,'123');
  await storage.readCollectorRange({...source,start:0,end:3});
  const read=calls.find(c=>c.Method==='GET');assert.equal(read.Query.versionId,'version-a');assert.equal(read.Headers.Range,'bytes=0-3');assert.ok(read.Headers['If-Match']);
  await storage.copyVerifiedObject({source,key:'listing-media/v1/prepared/immutable.mp4'});
  const copy=calls.find(c=>c.CopySource);assert.match(copy.CopySource,/\?versionId=version-a$/);assert.ok(copy.CopySourceIfMatch);assert.equal(copy.MetadataDirective,'Replaced');
  assert.equal(calls.filter(c=>c.Body).length,0,'publication does not GET+PUT a video body');
});

test('legacy MinIO has no collector direct-upload capability',()=>{
  const storage=createListingMediaStorage({env:{LISTING_MEDIA_STORAGE:'minio'}});
  assert.equal(storage.signCollectorPut,undefined);
});

test('real SDK signed HTTP fixture rejects altered key, MIME, MD5 and method and copies the pinned version after replay',async t=>{
  const f=await collectorMediaFixture(t),bytes=Buffer.from('immutable upload'),md5=createHash('md5').update(bytes).digest('base64'),key='staging/collector/account/random';
  const signed=await f.storage.signCollectorPut({key,contentType:'video/mp4',md5});
  assert.equal((await fetch(signed.url,{method:'PUT',headers:signed.headers,body:bytes})).status,200);
  const first=await f.storage.headCollectorObject({key});
  assert.deepEqual(await f.storage.readCollectorRange({...first,start:0,end:bytes.length-1}),bytes);
  for(const [url,options] of [[signed.url,{method:'GET',headers:signed.headers}],
    [signed.url.replace('/random?','/forged?'),{method:'PUT',headers:signed.headers,body:bytes}],
    [signed.url,{method:'PUT',headers:{...signed.headers,'Content-Type':'text/html'},body:bytes}],
    [signed.url,{method:'PUT',headers:signed.headers,body:Buffer.from('tampered bytes')}]]){
    const response=await fetch(url,options);assert.ok([400,403].includes(response.status));await response.arrayBuffer();
  }
  assert.equal((await fetch(signed.url,{method:'PUT',headers:signed.headers,body:bytes})).status,200);
  const later=await f.storage.headCollectorObject({key});assert.notEqual(later.versionId,first.versionId);
  f.save(key,Buffer.from('another privileged upload'),'video/mp4');
  const saved=await f.storage.copyVerifiedObject({source:first,key:'listing-media/v1/prepared/immutable.mp4'});
  assert.equal(saved.etag,first.etag);assert.deepEqual(f.find(saved.key).bytes,bytes);
  assert.equal(f.calls.filter(call=>call.copy).length,1);
});
