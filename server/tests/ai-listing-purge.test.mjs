import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {purgeMediaKeys,mediaUrls,unresolvedLegacyMediaImages} from '../ai-listing-purge.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generated=`listing-media/v1/ai-image-listing/${'a'.repeat(64)}.jpg`;
const prepared=`listing-media/v1/prepared/${'b'.repeat(64)}.mp4`;
test('media inventory proves generated, historical-host and verified collector keys plus interrupted preparation derivatives',()=>{
 const task={id:'t',accountId:'a',images:[{objectKey:generated,generatedUrl:'https://old.example/'+generated}],source:{items:[{listingItem:{richContent:JSON.stringify({html:'<video src="https://external.invalid/movie.mp4?x=1&amp;y=2" />'})}}]}};
 const prefix=sha('a').slice(0,24),staging=`staging/collector/${prefix}/12345678-1234-1234-1234-123456789abc`;
 const upload={id:'u',account_id:'a',object_key:staging,confirmed_object:{contentType:'video/mp4',versionId:'v',etag:'e'}};
 const keys=purgeMediaKeys({task,uploads:[upload,{...upload,account_id:'other'}],submissions:[{body:{items:[{video:'https://cdn.example/'+prepared}]}}],publication:{baseUrl:'https://old.example/'},downloadBaseUrl:'https://cdn.example/'});
 assert.ok(keys.includes(generated));assert.ok(keys.includes(prepared));assert.ok(keys.includes(staging));
 assert.ok(keys.includes(`listing-media/v1/prepared/${sha(['a','t','u','v','e'])}.mp4`));
 assert.ok(keys.includes(`listing-media/v1/prepared/${sha(['a','t','video','rich-video','https://external.invalid/movie.mp4?x=1&y=2','ozon-video-v1'])}.mp4`));
 assert.equal(keys.some(key=>key.includes('external.invalid')),false);
 assert.equal(keys.length,new Set(keys).size);
});
test('client paths, foreign origins and arbitrary bucket namespaces are never deletion capabilities',()=>{
 const keys=purgeMediaKeys({task:{id:'t',accountId:'a',images:[],source:{objectKey:generated,image:'https://foreign.invalid/'+generated,backup:'private/backup.tar'}},publication:{baseUrl:'https://our.invalid/'}});
 assert.equal(keys.includes(generated),false);assert.equal(keys.some(key=>!key.startsWith('listing-media/v1/prepared/')),false);
 assert.deepEqual([...mediaUrls({content:JSON.stringify({src:'https://example.invalid/a.jpg'})})],['https://example.invalid/a.jpg']);
});

test('a partial real GRID upload journals each formal/preview key before writing even when later slices fail',async t=>{
 const sharp=(await import('sharp')).default;
 const {createAiListingGridPort,recoverAiListingPurgeMediaKeys}=await import('../ai-listing-runtime.mjs');
 const {createAiListingResultStore}=await import('../ai-listing-image-cache.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=await mkdtemp(join(tmpdir(),'purge-spool-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const resultStore=createAiListingResultStore({directory,minFreeBytes:0});
 const bytes=await sharp({create:{width:30,height:40,channels:3,background:'#357'}}).png().toBuffer();
 const journal=[],written=[];let formal=0;
 const port=createAiListingGridPort({resultStore,publication:{baseUrl:baseForTest(),prefix:'listing-media/v1'},
  downloadImage:async()=>({buffer:bytes}),recognizeText:async()=>['product','product'],
  runChannel:async(input,generate)=>generate({profile:{id:'p',imageModel:'gpt-image-2'},gateway:{generateImage:async request=>({bytes:request.sourceImages[0].bytes,contentType:'image/png'})}}),
  recordMediaKey:async({key})=>journal.push(key),putObject:async({key,contentType})=>{
   assert.ok(journal.includes(key),'ownership must be durable before the storage write');
   if(contentType!=='image/webp' && ++formal===2)throw new Error('second tile upload failed');written.push(key);
  }});
 await assert.rejects(port({accountId:'a',taskId:'t',sku:'sku',sources:[{index:0,sourceUrl:'https://source.test/1'},{index:1,sourceUrl:'https://source.test/2'}],prompt:'design',image:{language:'ru',quality:'high'},requestKey:'r'}),{code:'AI_LISTING_STORAGE_FAILED'});
 assert.equal(written.length,2);assert.equal(journal.length,3);
 const inventory=purgeMediaKeys({task:{id:'t',accountId:'a',mediaKeys:journal,images:[]},publication:{baseUrl:baseForTest()}});
 for(const key of written)assert.ok(inventory.includes(key));
 const images=[{sku:'sku',index:0,sourceUrl:'https://source.test/1',status:'GENERATING',attempts:1,requestKey:'r'},{sku:'sku',index:1,sourceUrl:'https://source.test/2'}];
 const task={id:'t',accountId:'a',config:{generationMode:'GRID',prompt:'design',image:{language:'ru',quality:'high'}},images};
 const recovered=await recoverAiListingPurgeMediaKeys({task,images:[images[0]],resultStore,publication:{baseUrl:baseForTest(),prefix:'listing-media/v1'}});
 for(const key of written)assert.ok(recovered.includes(key),'paid spool recovers exact already uploaded formal/preview keys without AI');
 await assert.rejects(recoverAiListingPurgeMediaKeys({task,images:[images[0]],requests:[{request_key:'r:older',status:'SUCCEEDED'}],resultStore,publication:{baseUrl:baseForTest(),prefix:'listing-media/v1'}}),/unavailable/);
 await assert.rejects(recoverAiListingPurgeMediaKeys({task:{...task,id:'missing'},images:[images[0]],resultStore,publication:{baseUrl:baseForTest(),prefix:'listing-media/v1'}}),/unavailable/);
});
function baseForTest(){return 'https://media.example/';}

test('read-only historical inventory audit uses durable attempts despite retry status reset',()=>{
 const image={requestKey:'r',status:'PENDING',attempts:0};
 assert.equal(unresolvedLegacyMediaImages({images:[image]},[{request_key:'r:old',status:'SUCCEEDED'}]).length,1);
 assert.equal(unresolvedLegacyMediaImages({images:[{...image,status:'GENERATING',attempts:1,activeAttemptId:'old'}]},[{request_key:'r:old',status:'FAILED'}]).length,0);
 assert.equal(unresolvedLegacyMediaImages({mediaJournalVersion:1,images:[image]},[{request_key:'r:old',status:'SUCCEEDED'}]).length,0);
});
