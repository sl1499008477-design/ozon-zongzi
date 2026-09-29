import test from 'node:test';
import assert from 'node:assert/strict';
import {listCollectorMedia,validateUploadExpectation,collectorMediaCapabilities,createCollectorMediaUploads} from '../collector-media-upload.mjs';

test('source selectors preserve own SKU, original field order and hosted-video URLs',()=>{
  const payload={sku:'11',videos:[{url:'https://source.test/a.mp4',coverUrl:'https://source.test/poster.png'},{url:'https://youtu.be/hosted'}],
    color_image:'https://source.test/color.png',richContent:JSON.stringify({content:[{img:{src:'https://source.test/rich.png'}},{video:{src:'https://source.test/rich.mp4',poster:'https://source.test/cover.png'}}]}),
    variants:[{sku:'22',videos:[{url:'https://source.test/b.mp4'}]}]};
  const before=structuredClone(payload),sources=listCollectorMedia(payload);
  assert.deepEqual(payload,before);assert.equal(sources.length,7);
  assert.deepEqual(sources.filter(s=>s.purpose==='video').map(s=>[s.sourceSku,s.index,s.sourceUrl]),[['11',0,'https://source.test/a.mp4'],['22',0,'https://source.test/b.mp4']]);
  assert.equal(sources.find(s=>s.purpose==='rich-video').sourceUrl,'https://source.test/rich.mp4');
  assert.equal(sources.filter(s=>s.purpose==='rich-image').length,2);
});

test('direct capability requires explicit COS configuration, valid publication locations and an installed probe',async()=>{
  const env={COLLECTOR_MEDIA_DIRECT_UPLOAD:'1',LISTING_MEDIA_STORAGE:'cos',LISTING_COS_BUCKET:'fixture-1250000000',LISTING_COS_REGION:'ap-beijing',
    LISTING_COS_SECRET_ID:'fixture-id',LISTING_COS_SECRET_KEY:'fixture-key',LISTING_ASSET_PUBLIC_BASE_URL:'https://assets.test/',
    LISTING_ASSET_DOWNLOAD_BASE_URL:'https://assets.test/',COLLECTOR_MEDIA_FFPROBE_PATH:process.env.COLLECTOR_MEDIA_FFPROBE_PATH};
  for(const invalid of [{COLLECTOR_MEDIA_DIRECT_UPLOAD:''},{LISTING_MEDIA_STORAGE:'minio'},{LISTING_COS_SECRET_KEY:''},{COLLECTOR_MEDIA_FFPROBE_PATH:''},
    {LISTING_ASSET_DOWNLOAD_BASE_URL:'http://assets.test/'},{LISTING_ASSET_PUBLIC_PREFIX:'elsewhere'}])
    assert.deepEqual(await collectorMediaCapabilities({...env,...invalid}),{});
  if(process.env.COLLECTOR_MEDIA_FFPROBE_PATH)assert.deepEqual(await collectorMediaCapabilities(env),{mediaDirectUploadV1:true,mediaSharedReferencesV1:true});
});

test('upload ingress accepts only bounded, exact supported contents and server keys',()=>{
  const valid={sourceSku:'11',purpose:'video',index:0,sourceUrl:'https://source.test/a.mp4',size:123,contentType:'video/mp4',md5:Buffer.alloc(16).toString('base64')};
  assert.deepEqual(validateUploadExpectation(valid),valid);
  for(const changed of [{size:2*1024**3+1},{size:0},{md5:'client-sha-metadata'},{key:'staging/forged'},{purpose:'arbitrary'},{index:-1},{sourceUrl:'file:///tmp/private'},{contentType:'text/html'}])
    assert.throws(()=>validateUploadExpectation({...valid,...changed}),{code:'COLLECTOR_MEDIA_INPUT_INVALID'});
  assert.throws(()=>validateUploadExpectation({...valid,purpose:'color',contentType:'image/png',size:10*1024**2+1}),{code:'COLLECTOR_MEDIA_INPUT_INVALID'});
});

test('confirmation validates bytes against the trusted database purpose',async()=>{
  const row={id:'upload',account_id:'account',run_id:'run',device_id:'device',lease_hash:'lease',source_sku:'11',purpose:'video-cover',media_index:0,
    source_url:'https://source.test/cover.mp4',object_key:'staging/collector/object',expected_size:12,expected_type:'video/mp4',expected_md5:Buffer.alloc(16).toString('base64'),
    expires_at:new Date(Date.now()+60_000).toISOString(),confirmed_object:null};
  const client={async query(sql){if(sql.startsWith('SELECT'))return {rows:[row]};if(sql.startsWith('UPDATE'))return {rows:[]};throw Error(sql);}};
  const withLease=(_input,work)=>work(client,{accountId:'account',runId:'run',deviceId:'device',leaseHash:'lease'});
  let purpose;
  const service=createCollectorMediaUploads({withLease,storage:{
    async headCollectorObject(){return {key:row.object_key,versionId:'v1',crc64:'1',size:12,contentType:'video/mp4',etag:'0'.repeat(32)};},
    async readCollectorRange(){throw Error('not used');},
  },validate:async(_head,options)=>{purpose=options.purpose;return {contentType:'video/mp4',validation:'fixture'};}});
  await service.confirm({uploadId:'upload'});
  assert.equal(purpose,'video-cover');
});
