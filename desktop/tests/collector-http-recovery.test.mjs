import '../../server/env.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {getPostgresPool,closePostgresPool} from '../../server/db/connection.mjs';
import {createCollectorAuthRuntime} from '../../server/collector-auth-runtime.mjs';
import {createCollectorHttpHandler} from '../../server/collector-routes.mjs';
const enabled=process.env.SONLI_DESKTOP_HTTP_POSTGRES_TESTS==='1';
test('real HTTP Collector exchange preserves account boundaries and two desktop processes restore one queued rerun',{skip:!enabled,timeout:60000},async()=>{
 assert.equal(process.env.SONLI_ENV_FILE,'/private/tmp/sonli-audit-test.env');
 const pool=await getPostgresPool(),suffix=randomUUID(),a='desktop-a-'+suffix,b='desktop-b-'+suffix,profile=await mkdtemp(join(tmpdir(),'sonli-desktop-http-'));
 const accounts=[a,b].map(id=>({id,username:id,displayName:id,status:'active',role:'admin'}));
 const state={accounts,sessions:Object.fromEntries([['desktop-web-a',a],['desktop-web-b',b]].map(([token,accountId])=>[token,{token,accountId,expiresAt:new Date(Date.now()+3600000).toISOString()}])),collectorAuthTickets:[],collectorSessions:[]};
 const sendJson=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 const readJson=async req=>{let text='';for await(const chunk of req)text+=chunk;return text?JSON.parse(text):{};};
 const auth=createCollectorAuthRuntime({loadState:()=>state,saveState:()=>{},persistenceMode:()=> 'json',stateTransaction:{run:fn=>fn()},readJson,sendJson});
 const collector=createCollectorHttpHandler({authenticate:auth.authenticateRequest});
 let expireNextMutation=true;
 const calls=[];const server=http.createServer(async(req,res)=>{
  calls.push({method:req.method,path:req.url,scheme:String(req.headers.authorization||'').split(' ')[0]});
  try{if(await auth.handleHttpRoute(req,res,new URL(req.url,'http://localhost')))return;
   if(expireNextMutation&&req.method==='POST'&&req.url.endsWith('/runs')) {
    expireNextMutation=false;const previous=state.sessions['desktop-web-a'].expiresAt;state.sessions['desktop-web-a'].expiresAt='2000-01-01T00:00:00Z';
    try { await collector(req,res); } finally { state.sessions['desktop-web-a'].expiresAt=previous; }return;
   }
   if(await collector(req,res))return;sendJson(res,404,{});}catch(error){sendJson(res,error.status||500,{message:error.message,code:error.code});}
 });
 const child=(mode,id)=>new Promise((resolve,reject)=>{
  const proc=spawn(process.execPath,['--loader',fileURLToPath(new URL('./fixtures/desktop-http-loader.mjs',import.meta.url)),fileURLToPath(new URL('./fixtures/desktop-http-probe.mjs',import.meta.url)),mode,id],{env:{...process.env,SONLI_API_BASE:`http://127.0.0.1:${server.address().port}`,DESKTOP_TEST_USER_DATA:profile,DESKTOP_TEST_ACCOUNT:a},stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',s=>out+=s);proc.stderr.on('data',s=>err+=s);proc.on('exit',code=>code?reject(Error(err||out)):resolve(JSON.parse(out.trim().split('\n').at(-1))));
 });
 let taskId;
 try{
  for(const id of [a,b])await pool.query("INSERT INTO accounts(id,username,display_name,role,status) VALUES($1,$1,$1,'admin','active')",[id]);
  // An already completed owned task is the representative rerun fixture.
  taskId='desktop-task-'+suffix;
  await pool.query("INSERT INTO collector_tasks(id,account_id,name,task_type,source,status,configuration,created_by) VALUES($1,$2,'queue recovery fixture','CATEGORY','ozon','COMPLETED',$3::jsonb,$2)",[taskId,a,JSON.stringify({categoryIds:[],sourceContext:{accountId:a,source:'ozon_seller_analytics',sourceIdentity:'seller-page:2681910'}})]);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const authorization=await child('authorization',taskId);assert.equal(authorization.crossAccountDenied,true);
  const queued=await child('queue',taskId);
  const persisted=(await pool.query('SELECT id,status FROM collector_task_runs WHERE task_id=$1 AND account_id=$2',[taskId,a])).rows;assert.equal(persisted.length,1);assert.equal(persisted[0].status,'QUEUED');assert.equal(persisted[0].id,queued.runId);
  const restored=await child('restore',taskId);assert.equal(restored.runId,queued.runId);
  assert.equal((await pool.query('SELECT id FROM collector_task_runs WHERE task_id=$1',[taskId])).rowCount,1);
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path===`/collector/tasks/${taskId}/runs`).length,3,'one rejected expired-session call, one foreign-account call and one successful run creation, no replay');
  assert.ok(calls.filter(c=>c.path.startsWith('/collector/')).every(c=>c.scheme==='Collector'));
  assert.ok(calls.filter(c=>c.path.endsWith('/ticket')).every(c=>c.scheme==='Bearer'));
  assert.ok(calls.filter(c=>c.path.endsWith('/exchange')).every(c=>!c.scheme));
  console.log(JSON.stringify({authorization,queued,restored,httpRequestCount:calls.length,collectorRequestsUsedCollector:true,seller:'fixture only; no external collection'}));
 }finally{
  await new Promise(r=>server.close(r));
  if(taskId)await pool.query('DELETE FROM collector_tasks WHERE id=$1 AND account_id=$2',[taskId,a]);
  await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[a,b]]);
  await closePostgresPool();await rm(profile,{recursive:true,force:true});
 }
});
