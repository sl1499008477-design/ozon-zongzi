import test from 'node:test';
import assert from 'node:assert/strict';
import {createOzonListingMedia} from '../ozon-listing-media.mjs';

test('confirmed own-SKU color/video/Rich media publish by exact-version copy, preserving slots and hosted URLs',async()=>{
  const refs=[['color','image/png','https://source.test/color.png'],['video','video/mp4','https://source.test/v.mp4'],
    ['rich-image','image/png','https://source.test/rich.png'],['rich-video','video/mp4','https://source.test/rich.mp4']].map(([purpose,contentType,sourceUrl],index)=>({uploadId:'u'+index,sourceSku:'11',purpose,index:0,sourceUrl,key:'staging/collector/a/u'+index,versionId:'v1',etag:'e'+index,crc64:String(index+1),size:100,contentType}));
  const source={collectItemId:'collect',items:[{sku:'11',listingItem:{offer_id:'offer-11'}}],sourceSnapshot:{mediaObjects:refs}};
  const rich={content:[{img:{src:refs[2].sourceUrl}},{video:{src:refs[3].sourceUrl}}]};
  const items=[{offer_id:'offer-11',images:[],color_image:refs[0].sourceUrl,attributes:[{id:21841,values:[{value:refs[1].sourceUrl},{value:'https://youtu.be/hosted'},{value:refs[1].sourceUrl}]},{id:11254,values:[{value:JSON.stringify(rich)}]}]}];
  const objects=new Map();let copies=0,downloads=0,reads=0;
  const prepare=createOzonListingMedia({publication:{baseUrl:'https://assets.test/',prefix:'listing-media/v1'},downloadBaseUrl:'https://assets.test/',
    statObject:async key=>{if(!objects.has(key))throw Object.assign(Error('missing'),{code:'NoSuchKey'});return objects.get(key);},
    loadVerifiedMedia:async input=>{reads++;assert.equal(input.accountId,'owner');assert.equal(input.collectItemId,'collect');return refs;},
    copyVerifiedObject:async({source,key})=>{copies++;assert.equal(source.versionId,'v1');const saved={...source,key};objects.set(key,saved);return saved;},
    downloadImage:async()=>{downloads++;throw Error('must not download');},downloadVideo:async()=>{downloads++;throw Error('must not download');}});
  const prepared=await prepare({accountId:'owner',taskId:'task',source,items});
  assert.equal(copies,4);assert.equal(downloads,0);assert.equal(reads,1);
  assert.match(prepared[0].color_image,/^https:\/\/assets.test\/listing-media\/v1\/prepared\//);
  assert.equal(prepared[0].attributes[0].values.length,3);assert.equal(prepared[0].attributes[0].values[1].value,'https://youtu.be/hosted');
  assert.equal(prepared[0].attributes[0].values[0].value,prepared[0].attributes[0].values[2].value);
  assert.deepEqual(await prepare({accountId:'owner',taskId:'task',source,items}),prepared);assert.equal(copies,4);
  assert.equal(items[0].color_image,refs[0].sourceUrl);
});
