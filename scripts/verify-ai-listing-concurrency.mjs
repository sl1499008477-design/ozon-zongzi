// Isolated PostgreSQL tables and simulated providers: no paid requests or listing submissions.
import '../server/env.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { postgresConfig } from '../server/db/connection.mjs';
import { createAiListingRuntime } from '../server/ai-listing-runtime.mjs';
import { createAiListingRepository } from '../server/ai-listing-repository.mjs';
import { createAiUserChannels } from '../server/ai-user-channels.mjs';
const schema = `ai_concurrency_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool(postgresConfig());
let pool;
const pending=[];
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const table of ['ai_user_channels','ai_user_channel_requests','ai_image_listing_tasks'])
    await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`);
  pool = new Pool({...postgresConfig(),options:`-c search_path=${schema},public`});
  for (const [id,billing] of [['a','shared'],['b','shared'],['c','independent'],['d','third']])
    await pool.query(`INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint)
      VALUES($1,'test','test',$1,'https://example.test/v1','text','image',$2,'{}',$1)`,[id,billing]);
  const service=createAiUserChannels({pool,cipher:{decrypt:()=> 'dummy'},gatewayFactory:()=>({})});
  const run=(id,generate)=>service.run({accountId:'test',taskId:'test',requestKey:randomUUID(),...(id?{channelId:id}:{})},generate);
  const release=[];const selected=[];
  const generate=async({profile})=>{selected.push(profile.id);await new Promise(r=>release.push(r));return {bytes:Buffer.from('fake')};};
  const first=run('a',generate);pending.push(first);
  while(selected.length<1)await new Promise(r=>setTimeout(r,10));
  await assert.rejects(run('a',generate),{code:'AI_GATEWAY_NO_CAPACITY'});
  await assert.rejects(run('b',generate),{code:'AI_GATEWAY_NO_CAPACITY'});
  pending.push(run('c',generate),run('d',generate));
  while(selected.length<3)await new Promise(r=>setTimeout(r,10));
  assert.equal(new Set(selected).size,3);
  release.splice(0).forEach(r=>r());await Promise.all(pending);
  await run('b',async()=>({bytes:Buffer.from('fake')}));
  await assert.rejects(service.run({accountId:'other',taskId:'test',requestKey:'test'},generate),{code:'AI_GATEWAY_NO_CAPACITY'});
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM ai_user_channels WHERE lease_until>NOW()")).rows[0].n,0);
  const sample=(await admin.query("SELECT body FROM ai_image_listing_tasks WHERE status='COMPLETED' AND body->>'source' IS NOT NULL LIMIT 1")).rows[0]?.body;
  assert.ok(sample, 'representative existing product required');
  const repository=createAiListingRepository({pool});
  for(let i=0;i<4;i++) {
    const task=structuredClone(sample);
    Object.assign(task,{id:`parallel-${i}`,accountId:'test',dedupeKey:`parallel-${i}`,status:'QUEUED',version:1,nextRunAt:Date.now(),createdAt:Date.now()+i,updatedAt:Date.now(),submissionStarted:false,approved:false});
    task.config={...task.config,generationMode:'GRID',manualReview:true};
    task.images=task.images.map(image=>({sku:image.sku,index:image.index,sourceUrl:image.sourceUrl,requestKey:`${task.id}:${image.index}`,status:'PENDING',attempts:0}));
    await repository.create(task);
  }
  let concurrent=0,peak=0;const generated=new Set();
  const runtime=createAiListingRuntime({resolvePool:async()=>pool,repository,
    checkAccount:async()=>({id:'test',role:'admin',status:'active'}),
    generateImageGroup:async input=>service.run(input,async()=>{
      const key=`${input.taskId}:${input.sku}`;assert.ok(!generated.has(key));generated.add(key);
      concurrent++;peak=Math.max(peak,concurrent);await new Promise(r=>setTimeout(r,200));concurrent--;
      return {images:input.sources.map(image=>({...image,sku:input.sku,generatedUrl:`https://example.test/${input.taskId}/${image.index}.png`}))};
    }),
    submitListing:async()=>{throw new Error('must never submit');}
  });
  try {
    void runtime.start();
    const deadline=Date.now()+25000;
    let tasks;
    do {await new Promise(r=>setTimeout(r,100));tasks=await repository.list({accountId:'test'});} while(tasks.some(t=>t.status!=='AWAITING_REVIEW')&&Date.now()<deadline);
    assert.equal(peak,3);
    assert.equal(tasks.length,4);
    assert.ok(tasks.every(t=>t.status==='AWAITING_REVIEW'&&t.images.every(i=>i.generatedUrl)),JSON.stringify(tasks.map(t=>({id:t.id,status:t.status}))));
    console.log('PASS: four copies of an existing product reached review through real task leases, with three overlapping generated SKU groups and no duplicate groups.');
  } finally {await runtime.stop();}
  console.log('PASS: three providers overlap; exclusive channel lease; shared billing waits; released capacity reusable; account isolation; no paid requests.');
} finally {
  if(pool)await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
