import '../server/env.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {getPostgresPool} from '../server/db/connection.mjs';
import {createAiUserChannels} from '../server/ai-user-channels.mjs';
const pool=await getPostgresPool();const db=await pool.connect();await db.query('BEGIN');
try {
 if(!(await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='ai_user_channels' AND column_name='failure_count'")).rows.length)await db.query(await readFile(new URL('../server/db/migrations/111_ai_channel_health.sql',import.meta.url),'utf8'));
 const owner=randomUUID();const admin={id:owner,role:'admin'};
 await db.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')",[owner]);
 const svc=createAiUserChannels({pool:db,cipher:{fingerprint:k=>k,encrypt:()=>({}),decrypt:()=> 'fake'},gatewayFactory:()=>({listModels:async()=>({models:[{id:'text'},{id:'image'}]})})});
 const ids=[randomUUID(),randomUUID()].sort();
 for(const id of ids)await svc.create(admin,{id,accountId:owner,name:id,baseUrl:'https://example.test/v1',textModel:'text',imageModel:'image',billingAccount:'test',apiKey:id});
 let release;let started;const ready=new Promise(r=>started=r);
 const a=svc.run({accountId:owner,taskId:'product-A',requestKey:randomUUID()},async({profile})=>{assert.equal(profile.id,ids[0]);started();return new Promise(r=>release=()=>r({generatedUrl:'https://example.test/A.png'}));});
 await ready;
 const b=await svc.run({accountId:owner,taskId:'product-B',requestKey:randomUUID()},async({profile})=>{assert.equal(profile.id,ids[1]);return{generatedUrl:'https://example.test/B.png'};});
 assert.equal(b.generatedUrl,'https://example.test/B.png');release();assert.equal((await a).generatedUrl,'https://example.test/A.png');
 for(let i=1;i<=3;i++){
  await db.query('UPDATE ai_user_channels SET cooldown_until=NULL WHERE id=$1',[ids[0]]);
  await assert.rejects(svc.run({accountId:owner,channelId:ids[0],taskId:'fail',requestKey:randomUUID()},async()=>{throw Object.assign(new Error('eof'),{code:'AI_GATEWAY_UNEXPECTED_EOF'});}));
  const row=(await db.query('SELECT failure_count,needs_attention,EXTRACT(EPOCH FROM cooldown_until-NOW()) seconds FROM ai_user_channels WHERE id=$1',[ids[0]])).rows[0];
  assert.equal(row.failure_count,i);assert.equal(row.needs_attention,i===3);assert.equal(Number(row.seconds),[60,300,900][i-1]);
 }
 await db.query('UPDATE ai_user_channels SET cooldown_until=NULL WHERE id=$1',[ids[0]]);
 await assert.rejects(svc.run({accountId:owner,channelId:ids[0],taskId:'after-third',requestKey:randomUUID()},async()=>{throw new Error('must not send');}),{code:'AI_GATEWAY_NO_CAPACITY'});
 await svc.run({accountId:owner,channelId:ids[0],healthProbe:true,taskId:'restore',requestKey:randomUUID()},async()=>({ok:true}));
 await db.query('UPDATE ai_user_channels SET failure_count=1 WHERE id=$1',[ids[0]]);
 const healthy=await svc.run({accountId:owner,taskId:'healthy-first',requestKey:randomUUID()},async({profile})=>({selected:profile.id}));assert.equal(healthy.selected,ids[1]);
 await assert.rejects(svc.run({accountId:owner,channelId:ids[0],taskId:'auth',requestKey:randomUUID()},async()=>{throw Object.assign(new Error('auth'),{code:'NON_RETRYABLE_AUTH'});}));
 assert.equal((await db.query('SELECT needs_attention FROM ai_user_channels WHERE id=$1',[ids[0]])).rows[0].needs_attention,true);
 await assert.rejects(svc.run({accountId:owner,channelId:ids[0],taskId:'blocked',requestKey:randomUUID()},async()=>{throw new Error('must not send');}),{code:'AI_GATEWAY_NO_CAPACITY'});
 await svc.run({accountId:owner,channelId:ids[0],healthProbe:true,taskId:'manual-recovery',requestKey:randomUUID()},async()=>({ok:true}));
 assert.equal((await db.query('SELECT failure_count FROM ai_user_channels WHERE id=$1',[ids[0]])).rows[0].failure_count,0);
 console.log('PASS: concurrent product ownership, health preference, 1/5/15 minute cooldown and third-failure isolation, auth isolation, manual recovery; mock AI only');
}finally{await db.query('ROLLBACK');db.release();await pool.end();}
