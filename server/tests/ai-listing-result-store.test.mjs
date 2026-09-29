import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAiListingResultStore,createAiListingSourceCache,retryListingUpload} from '../ai-listing-image-cache.mjs';
const input={accountId:'a',taskId:'t',sku:'s',index:0,sourceUrl:'https://source.test/image?token=one',prompt:'keep',image:{ratio:'3:4'},requestKey:'attempt-1'};
const sample={bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),contentType:'image/png',requestId:'upstream-id',generationConfig:{imageModel:'fixture'}};

test('gateway Uint8Array results persist their raw bytes and recover after restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'result-typed-array-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createAiListingResultStore({directory,minFreeBytes:0});
 const padded=new Uint8Array(sample.bytes.length+4);padded.set(sample.bytes,2);
 await store.reserve(input,'SINGLE');await store.save(input,'SINGLE',{...sample,bytes:padded.subarray(2,-2)});
 const filename=(await readdir(directory)).find(name=>name.endsWith('.json'));
 const metadata=JSON.parse(await readFile(join(directory,filename),'utf8'));
 assert.equal(metadata.sha256,createHash('sha256').update(sample.bytes).digest('hex'));
 assert.deepEqual(await readFile(join(directory,filename.replace('.json','.bin'))),sample.bytes);
 const recovered=await createAiListingResultStore({directory,minFreeBytes:0}).load({...input,requestKey:'retry'},'SINGLE');
 assert.deepEqual(recovered.bytes,sample.bytes);assert.equal(recovered.originRequestKey,input.requestKey);
});

test('legacy Uint8Array JSON checksums recover only the exact original paid bytes',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'result-legacy-hash-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createAiListingResultStore({directory,minFreeBytes:0});
 // Cross the compatibility hasher's chunk boundary with varied byte values.
 const bytes=Buffer.from(Array.from({length:10001},(_,index)=>index%256));
 await store.reserve(input,'GRID');await store.save(input,'GRID',{...sample,bytes});
 const filename=(await readdir(directory)).find(name=>name.endsWith('.json')),path=join(directory,filename);
 const metadata=JSON.parse(await readFile(path,'utf8'));
 metadata.sha256=createHash('sha256').update(JSON.stringify(new Uint8Array(bytes))).digest('hex');
 await writeFile(path,JSON.stringify(metadata));
 const before=await readFile(path),restarted=createAiListingResultStore({directory,minFreeBytes:0});
 const recovered=await restarted.load({...input,requestKey:'retry'},'GRID');
 assert.deepEqual(recovered.bytes,bytes);assert.equal(recovered.originRequestKey,input.requestKey);
 assert.deepEqual(await readFile(path),before,'read recovery must not silently replace historical evidence');
 assert.equal(await restarted.load({...input,accountId:'other'},'GRID'),null);
 await assert.rejects(restarted.load({...input,prompt:'changed'},'GRID'),{code:'AI_LISTING_RESULT_INPUT_CHANGED'});
});

for(const legacy of [false,true])test(`corrupt or missing paid bytes are rejected with ${legacy?'legacy JSON':'raw'} checksums`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'result-corrupt-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createAiListingResultStore({directory,minFreeBytes:0});
 await store.reserve(input,'SINGLE');await store.save(input,'SINGLE',sample);
 const filename=(await readdir(directory)).find(name=>name.endsWith('.json')),path=join(directory,filename);
 if(legacy){const metadata=JSON.parse(await readFile(path,'utf8'));
  metadata.sha256=createHash('sha256').update(JSON.stringify(new Uint8Array(sample.bytes))).digest('hex');
  await writeFile(path,JSON.stringify(metadata));}
 const binary=join(directory,filename.replace('.json','.bin')),changed=Buffer.from(sample.bytes);changed[changed.length-1]^=1;
 await writeFile(binary,changed);
 await assert.rejects(store.load(input,'SINGLE'),{code:'AI_LISTING_RESULT_CHECKPOINT_INVALID'});
 await writeFile(binary,sample.bytes.subarray(0,-1));
 await assert.rejects(store.load(input,'SINGLE'),{code:'AI_LISTING_RESULT_CHECKPOINT_INVALID'});
 await rm(binary);
 await assert.rejects(store.load(input,'SINGLE'),{code:'AI_LISTING_RESULT_CHECKPOINT_INVALID'});
 assert.ok((await readdir(directory)).includes(filename),'failed verification must retain metadata');
});

test('grid diagnostics survive worker restart without deleting paid bytes or keeping arbitrary upstream data',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'result-test-'));
 try{
  const store=createAiListingResultStore({directory,minFreeBytes:0});
  await store.reserve(input,'GRID');await store.save(input,'GRID',sample);
  const diagnostic={stage:'slicing',reason:'separator_count',actual:{width:200,height:200},
   expected:{columns:3,rows:2,count:5,width:2432,height:2144},detected:{verticalBands:0,horizontalBands:0}};
  await store.recordFailure(input,'GRID',{...diagnostic,secret:'private',actual:{...diagnostic.actual,token:'private'}});
  const restarted=createAiListingResultStore({directory,minFreeBytes:0});
  const result=await restarted.load(input,'GRID');
  assert.deepEqual(result.bytes,sample.bytes);assert.deepEqual(result.diagnostic,diagnostic);
  await assert.rejects(store.recordFailure({...input,prompt:'changed'},'GRID',diagnostic),{code:'AI_LISTING_RESULT_INPUT_CHANGED'});
  assert.deepEqual((await restarted.load(input,'GRID')).bytes,sample.bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a restarted result store recovers the original paid result across attempt IDs and isolates accounts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'result-test-'));try{
  const store=createAiListingResultStore({directory,maxBytes:512,maxResultBytes:256,minFreeBytes:0});
  await store.reserve(input,'SINGLE');await store.save(input,'SINGLE',sample);
  const restarted=createAiListingResultStore({directory,maxBytes:512,maxResultBytes:256,minFreeBytes:0});
  const recovered=await restarted.load({...input,requestKey:'attempt-2'},'SINGLE');
  assert.deepEqual(recovered.bytes,sample.bytes);assert.equal(recovered.originRequestKey,'attempt-1');
  assert.equal(await restarted.load({...input,accountId:'other'},'SINGLE'),null);
  await assert.rejects(restarted.load({...input,sourceUrl:'https://source.test/image?token=two'},'SINGLE'),{code:'AI_LISTING_RESULT_INPUT_CHANGED'});
  await restarted.acknowledge({...input,generationMode:'SINGLE'});assert.deepEqual(await readdir(directory),[]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('unacknowledged results cannot be evicted to admit another paid generation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'result-test-'));try{
  const store=createAiListingResultStore({directory,maxBytes:256,maxResultBytes:256,minFreeBytes:0});
  await store.reserve(input,'SINGLE');await store.save(input,'SINGLE',sample);
  await assert.rejects(store.reserve({...input,taskId:'new'},'SINGLE'),{code:'AI_LISTING_RESULT_SPOOL_FULL'});
  assert.deepEqual((await store.load(input,'SINGLE')).bytes,sample.bytes);
  await store.acknowledge({...input,generationMode:'SINGLE'});
  await store.reserve({...input,taskId:'new'},'SINGLE');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('source and OCR cache keeps exact URL/account/task identity and evicts within its byte bound',async()=>{
 const cache=createAiListingSourceCache({maxBytes:8,maxEntries:2});let reads=0,ocrs=0;
 const read=async()=>({buffer:Buffer.alloc(4,++reads),contentType:'image/png'});
 const recognize=async buffers=>{ocrs++;return buffers.map(()=> 'fact');};
 const load=url=>cache.source(input,url,read);
 const a=await load(input.sourceUrl);await cache.facts(input,[input.sourceUrl],[a.buffer],recognize);
 assert.equal((await load(input.sourceUrl)).buffer[0],1);await cache.facts(input,[input.sourceUrl],[a.buffer],recognize);assert.equal(ocrs,1);
 await cache.source({...input,accountId:'other'},input.sourceUrl,read);
 await load('https://source.test/image?token=two');
 assert.equal((await load(input.sourceUrl)).buffer[0],4);assert.equal(cache.snapshot().bytes<=8,true);assert.equal(cache.snapshot().entries<=2,true);
});

test('upload retries only transient failures with the same closure and a finite budget',async()=>{
 let attempts=0;await retryListingUpload(async()=>{if(++attempts<3)throw Object.assign(new Error('reset'),{code:'ECONNRESET'});},{sleep:async()=>{}});assert.equal(attempts,3);
 attempts=0;await assert.rejects(retryListingUpload(async()=>{attempts++;throw Object.assign(new Error('denied'),{code:'AccessDenied'});},{sleep:async()=>{}}));assert.equal(attempts,1);
 attempts=0;await assert.rejects(retryListingUpload(async()=>{attempts++;throw Object.assign(new Error('reset'),{code:'ECONNRESET'});},{sleep:async()=>{}}));assert.equal(attempts,3);
});

test('tile upload failure and worker restart publish the stored grid without another model request',async()=>{
 const {createAiListingGridPort}=await import('../ai-listing-runtime.mjs');const {default:sharp}=await import('sharp');
 const directory=await mkdtemp(join(tmpdir(),'result-test-'));try{
  const source=await sharp({create:{width:30,height:40,channels:3,background:'#aaaaaa'}}).png().toBuffer();
  const group={...input,sources:[{index:0,sourceUrl:input.sourceUrl},{index:1,sourceUrl:'https://source.test/two'}],image:{language:'ru',quality:'high'}};
  const writes=[];let models=0,downloads=0,fail=true,formalWrites=0;
  const dependencies={publication:{baseUrl:'https://media.test/',prefix:'images'},downloadImage:async()=>{downloads++;return {buffer:source};},recognizeText:async buffers=>buffers.map(()=> 'facts'),
   runChannel:async(_input,generate)=>generate({profile:{imageModel:'fixture'},gateway:{generateImage:async request=>{models++;return {bytes:new Uint8Array(request.sourceImages[0].bytes),contentType:'image/png'};}}}),
   putObject:async object=>{writes.push(object);if(object.contentType!=='image/webp'&&++formalWrites===2&&fail)throw Object.assign(new Error('denied'),{code:'AccessDenied'});},
  };
  await assert.rejects(createAiListingGridPort({...dependencies,resultStore:createAiListingResultStore({directory,minFreeBytes:0})})(group),{code:'AI_LISTING_STORAGE_FAILED'});
  fail=false;const output=await createAiListingGridPort({...dependencies,resultStore:createAiListingResultStore({directory,minFreeBytes:0})})({...group,requestKey:'attempt-2',mustReusePaidResult:true});
  assert.equal(models,1);assert.equal(downloads,2);assert.equal(output.images.length,2);
  const formal=writes.filter(item=>item.contentType!=='image/webp');
  assert.equal(formal[0].key,formal[2].key);assert.equal(formal[1].key,formal[3].key);assert.deepEqual(formal[1].buffer,formal[3].buffer);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('image upload reset retries the same result bytes and stable key without invoking the model again',async()=>{
 const {createAiListingImagePort}=await import('../ai-listing-runtime.mjs');let models=0;const writes=[];
 const port=createAiListingImagePort({publication:{baseUrl:'https://media.test/',prefix:'images'},downloadImage:async()=>({buffer:Buffer.from('source'),contentType:'image/png'}),
 loadProfile:async()=>({imageModel:'fixture'}),gateway:{generateImage:async()=>{models++;return sample;}},
 putObject:async object=>{writes.push(object);if(writes.length===1)throw Object.assign(new Error('reset'),{code:'ECONNRESET'});}});
 const output=await port(input);assert.equal(models,1);assert.equal(writes.length,3);assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].buffer,writes[1].buffer);assert.equal(output.objectKey,writes[1].key);assert.equal(writes[2].contentType,'image/webp');
});

test('a channel bookkeeping failure after model success cannot discard its recoverable bytes',async()=>{
 const {createAiListingImagePort}=await import('../ai-listing-runtime.mjs');const directory=await mkdtemp(join(tmpdir(),'result-test-'));let models=0;
 try{
  const store=createAiListingResultStore({directory,minFreeBytes:0}),deps={publication:{baseUrl:'https://media.test/',prefix:'images'},resultStore:store,
   downloadImage:async()=>({buffer:Buffer.from('source'),contentType:'image/png'}),putObject:async()=>{},
   runChannel:async(_input,generate)=>{await generate({profile:{imageModel:'fixture'},gateway:{generateImage:async()=>{models++;return sample;}}});throw Object.assign(new Error('lost lease after response'),{code:'AI_LISTING_CHANNEL_LEASE_LOST',deliveryState:'POSSIBLY_SENT'});}};
  await assert.rejects(createAiListingImagePort(deps)(input),{code:'AI_LISTING_CHANNEL_LEASE_LOST'});
  const output=await createAiListingImagePort(deps)({...input,requestKey:'retry'});assert(output.generatedUrl);assert.equal(models,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('expired empty reservations are cleaned without deleting old unacknowledged successful results',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'result-test-'));let now=1000;
 try{
  const store=createAiListingResultStore({directory,maxBytes:512,maxResultBytes:256,minFreeBytes:0,clock:()=>now});
  await store.reserve(input,'SINGLE');await store.save(input,'SINGLE',sample);
  await store.reserve({...input,taskId:'abandoned'},'SINGLE');now+=25*3600_000;
  await store.reserve({...input,taskId:'new'},'SINGLE');
  assert.deepEqual((await store.load(input,'SINGLE')).bytes,sample.bytes);
  assert.equal((await readdir(directory)).filter(name=>name.endsWith('.json')).length,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('failed source reads are not cached and expired OCR facts are reread within the same task',async()=>{
 let now=1,reads=0,ocrs=0;const cache=createAiListingSourceCache({ttlMs:10,clock:()=>now});
 await assert.rejects(cache.source(input,input.sourceUrl,async()=>{throw Error('offline');}));
 const read=()=>cache.source(input,input.sourceUrl,async()=>{reads++;return {buffer:Buffer.from('source')};});
 const recognize=async()=>{ocrs++;return ['fact'];};
 await cache.facts(input,[input.sourceUrl],[(await read()).buffer],recognize);now=20;
 await cache.facts(input,[input.sourceUrl],[(await read()).buffer],recognize);assert.equal(reads,2);assert.equal(ocrs,2);
});
