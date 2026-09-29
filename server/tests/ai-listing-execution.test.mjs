import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createAiListingGridPort,createAiListingImagePort,createAiListingRuntime} from '../ai-listing-runtime.mjs';

const publication={baseUrl:'https://media.example/',prefix:'images'};
const input={accountId:'a',taskId:'t',requestKey:'r',sku:'s',sourceUrl:'https://original.test/a.png',prompt:'Keep product',image:{ratio:'3:4',resolution:'1K',quality:'high',language:'ru'}};

test('grid networking releases the local CPU gate used by OCR and slicing',async()=>{
  let inLocal=false,entries=0;
  const original=await sharp({create:{width:30,height:40,channels:3,background:'#aaaaaa'}}).png().toBuffer();
  const generate=createAiListingGridPort({publication,
    runLocalWork:async fn=>{assert.equal(inLocal,false);inLocal=true;entries++;try{return await fn();}finally{inLocal=false;}},
    downloadImage:async()=>{assert.equal(inLocal,false);return {buffer:original};},
    recognizeText:async()=>{assert.equal(inLocal,true);return [];},
    runChannel:async(_input,call)=>call({profile:{imageModel:'model'},gateway:{generateImage:async request=>{assert.equal(inLocal,false);assert.equal(request.timeoutMs,600_000);assert.equal(request.idleTimeoutMs,300_000);return {bytes:request.sourceImages[0].bytes,contentType:'image/png'};}}}),
    putObject:async()=>{assert.equal(inLocal,false);},
  });
  const result=await generate({...input,sources:[{index:0,sourceUrl:input.sourceUrl}]});
  assert.equal(result.images.length,1);assert.equal(entries,3);
});

test('single image networking runs outside the CPU gate',async()=>{
  let inLocal=false,entries=0;
  const original=await sharp({create:{width:12,height:16,channels:3,background:'#aaaaaa'}}).png().toBuffer();
  const generate=createAiListingImagePort({publication,
    runLocalWork:async fn=>{inLocal=true;entries++;try{return await fn();}finally{inLocal=false;}},
    loadProfile:async()=>({imageModel:'model'}),
    downloadImage:async()=>{assert.equal(inLocal,false);return {buffer:original,contentType:'image/png'};},
    gateway:{generateImage:async request=>{assert.equal(inLocal,false);assert.equal(request.timeoutMs,600_000);assert.equal(request.idleTimeoutMs,300_000);return {bytes:original,contentType:'image/png'};}},
    putObject:async()=>{assert.equal(inLocal,false);},
  });
  await generate(input);assert.equal(entries,2);
});

for(const [mode,expected] of [['prepare',['prepare']],['worker',['generate','generate','generate','media','media','finalize','finalize']]]){
  test(`${mode} runtime claims only its owned phases`,async()=>{
    const phases=[];
    const pool={query:async sql=>{
      if(sql==='SELECT * FROM ai_runtime_settings WHERE id=TRUE')return {rows:[{settings:null,revision:0}]};
      if(sql.includes('AS products'))return {rows:[{products:0,requests:0}]};
      return {rows:[]};
    }};
    const runtime=createAiListingRuntime({env:{AI_LISTING_ADAPTIVE_CONCURRENCY:'0'},resolvePool:async()=>pool,
      repository:{claimNext:async input=>{phases.push(input.phase);return null;}}});
    await runtime.start({mode});await runtime.stop();
    assert.deepEqual(phases,expected);
  });
}

for(const requestConcurrency of [1,2,5])test(`capability workers allow independent tests up to the smaller of three and request limit ${requestConcurrency}`,async()=>{
  const expected=Math.min(3,requestConcurrency),releases=[];
  let selections=0,markReady,readinessTimer;
  const ready=new Promise(resolve=>{markReady=resolve;});
  const pool={query:async sql=>{
    if(sql==='SELECT * FROM ai_runtime_settings WHERE id=TRUE')return {rows:[{settings:{productConcurrency:5,requestConcurrency,localConcurrency:1,billingConcurrency:1,adaptiveEnabled:false},revision:1}]};
    if(sql.includes('AS products'))return {rows:[{products:0,requests:0}]};
    if(sql.trimStart().startsWith('SELECT')&&sql.includes("capability_check->>'status'='QUEUED'")) {
      selections++;if(selections===expected)markReady();
      await new Promise(resolve=>releases.push(resolve));
    }
    return {rows:[]};
  }};
  const runtime=createAiListingRuntime({resolvePool:async()=>pool,repository:{claimNext:async()=>null},
    readResources:async()=>({memoryRatio:0.2,headroomBytes:1073741824,cpuRatio:0.1,eventLoopDelayMs:0})});
  const started=runtime.start({mode:'worker'});
  try {
    await Promise.race([ready,new Promise((_,reject)=>{readinessTimer=setTimeout(()=>reject(new Error('Capability lanes did not become ready')),5000);})]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(selections,expected);
  } finally {clearTimeout(readinessTimer);const stopped=runtime.stop();releases.forEach(resolve=>resolve());await stopped;await started;}
});

test('admin channel wait reason uses saved limits even before a worker refresh',async()=>{
  const startedAt=new Date().toISOString(),lease_until=new Date(Date.now()+60_000).toISOString();
  const pool={query:async sql=>{
    if(sql==='SELECT * FROM ai_runtime_settings WHERE id=TRUE')return {rows:[{settings:{productConcurrency:3,requestConcurrency:1,localConcurrency:1,billingConcurrency:1,adaptiveEnabled:false},revision:2}]};
    if(sql.startsWith('SELECT id,account_id,name'))return {rows:[{id:'queued',account_id:'a',base_url:'https://example.test/v1',billing_account:'independent',capability_check:{type:'GRID_SAMPLE_V1',status:'QUEUED',stage:'queued',id:'intent',startedAt}}]};
    if(sql.startsWith('SELECT id,base_url,billing_account'))return {rows:[{id:'busy',base_url:'https://example.test/v1',billing_account:'other',lease_until}]};
    return {rows:[]};
  }};
  let response;
  const runtime=createAiListingRuntime({resolvePool:()=>pool,authenticate:async()=>({role:'admin',id:'admin'}),sendJson:(_res,http,body)=>response={http,body}});
  await runtime.handleRoute({method:'GET'},{},new URL('http://localhost/api/admin/ai-user-channels'));
  assert.equal(response.http,200);
  assert.equal(response.body.channels[0].active_test.waitReason,'request_capacity');
});
