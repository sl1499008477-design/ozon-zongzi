import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createMessageService} from '../message-service.mjs';
import {createMessageOzon} from '../message-ozon.mjs';
import {createMessageRuntime} from '../message-runtime.mjs';

test('消息真实数据库流程：隔离、回调、定时、拆包去重、停止及超时核对', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async()=>{
  // The caller supplies a dedicated test database. Every table lives in a
  // random private schema; no existing accounts/orders/settings are touched.
  const schema='message_test_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool,httpServer;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:8});
    await pool.query('CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,role TEXT,status TEXT,expires_at TIMESTAMPTZ); CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,client_id TEXT,seller_company_id TEXT,label TEXT,status TEXT)');
    await pool.query(await readFile(new URL('../db/migrations/125_message_management.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/127_message_confirmation.sql',import.meta.url),'utf8'));
    await pool.query("INSERT INTO accounts VALUES('a','a','user','active',NULL),('b','b','user','active',NULL); INSERT INTO stores VALUES('s','a','7','7','内部别名','active'),('other','b','8','8','B店','active')");
    let now=Date.parse('2026-09-10T12:00:00Z'),sendCount=0,startChats=0,failHistory=0,timeout=false,duringGet=null,duringSend=null,duringHistory=null;
    const remote=new Map();const history=[];
    const raw=(number,overrides={})=>({posting_number:number,order_number:number.slice(0,-2),status:'delivering',substatus:'posting_in_pickup_point',available_actions:['can_create_chat'],products:[{name:'Чашка',quantity:2}],...overrides});
    remote.set('100-2-1',raw('100-2-1'));remote.set('100-2-2',raw('100-2-2'));
    const callApi=async(_store,path,body)=>{
      if(path==='/v1/seller/info')return {subscription:{type:'PREMIUM_PLUS'}};
      if(path==='/v4/posting/fbs/list')return {postings:[...remote.values()],has_next:false};
      if(path==='/v3/posting/fbo/list')return {postings:[],has_next:false};
      if(path==='/v3/posting/fbs/get'){if(duringGet)await duringGet(body);return {result:remote.get(body.posting_number)};}
      if(path==='/v3/chat/list')return {chats:[],has_next:false};
      if(path==='/v3/chat/history'){if(duringHistory)await duringHistory();if(failHistory-->0)throw Object.assign(Error('timeout'),{code:'ZONGZI_TIMEOUT'});return {messages:history,has_next:false};}
      if(path==='/v1/chat/start'){startChats++;return {result:{chat_id:'buyer-chat'}};}
      if(path==='/v1/chat/send/message') {sendCount++;if(duringSend)await duringSend();history.unshift({message_id:String(sendCount),created_at:new Date(now).toISOString(),user:{type:'Seller'},data:[body.text],context:{order_number:'100-2'}});if(timeout)throw Object.assign(Error('timeout'),{status:504,code:'ZONGZI_TIMEOUT'});return {result:'success'};}
      throw Error('unexpected endpoint '+path);
    };
    const service=createMessageService({pool,ozon:createMessageOzon({callApi}),readCredential:async()=>({clientId:'7',apiKey:'fixture'}),clock:()=>now});
    const runtime=createMessageRuntime({resolveService:async()=>service,
      authenticate:async req=>{if(req.headers.authorization!=='Bearer fixture')throw Object.assign(Error('请登录'),{status:401});return {id:'a',role:'user'};},
      readJson:async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString());},
      sendJson:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
    httpServer=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://localhost'))) {res.writeHead(404);res.end();}});
    await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${httpServer.address().port}`;
    assert.equal((await fetch(origin+'/ozon/messages/overview?storeId=s')).status,401);
    assert.equal((await fetch(origin+'/api/ozon/messages/overview?storeId=other',{headers:{Authorization:'Bearer fixture'}})).status,403);
    assert.equal((await fetch(origin+'/api/ozon/messages/overview?storeId=s',{headers:{Authorization:'Bearer fixture'}})).status,200);
    const scope={accountId:'a',storeId:'s'};
    const overview=await service.overview(scope);
    assert.equal(overview.settings.enabled,false);assert.ok(overview.templates.every(t=>!t.enabled));
    await assert.rejects(service.overview({accountId:'b',storeId:'s'}),e=>e.status===403);
    await service.syncStore(scope);
    // Preview choices must follow the selected trigger, before the 100-row limit.
    const choices=[
      ['pickup','delivering','posting_in_pickup_point'],
      ['signed','delivered','posting_received'],['signed-plain','delivered',null],
      ['ready','awaiting_deliver','posting_transferring_to_delivery'],['ready-plain','awaiting_deliver',''],
      ['shipped','delivering','posting_on_way_to_pickup_point'],['shipped-plain','delivering',null],
      ['cancelled','cancelled','posting_in_pickup_point'],['conditional','delivered','posting_conditionally_delivered'],
      ['returned','delivering','posting_returned_to_warehouse'],
    ].map(([suffix,status,substatus])=>({postingNumber:`preview-${suffix}`,orderNumber:`preview-${suffix}`,scheme:'FBO',status,substatus,events:{}}));
    const irrelevant=Array.from({length:105},(_,i)=>({postingNumber:`preview-irrelevant-${i}`,status:'cancelled',substatus:'posting_in_pickup_point',events:{}}));
    await pool.query(`INSERT INTO ozon_message_postings(account_id,store_id,posting_number,body,updated_at)
      SELECT $1,$2,item->>'postingNumber',item,$4 FROM jsonb_array_elements($3::jsonb) item`,[scope.accountId,scope.storeId,JSON.stringify(choices),now]);
    await pool.query(`INSERT INTO ozon_message_postings(account_id,store_id,posting_number,body,updated_at)
      SELECT $1,$2,item->>'postingNumber',item,$4 FROM jsonb_array_elements($3::jsonb) item`,[scope.accountId,scope.storeId,JSON.stringify(irrelevant),now+1]);
    for(const [trigger,expected] of Object.entries({PICKUP:['pickup'],REVIEW:['signed','signed-plain'],SHIPPING_READY:['ready','ready-plain'],SHIPPED:['shipped','shipped-plain']})) {
      const response=await fetch(`${origin}/api/ozon/messages/postings?storeId=s&q=preview-&trigger=${trigger}`,{headers:{Authorization:'Bearer fixture'}});
      assert.equal(response.status,200);
      assert.deepEqual((await response.json()).map(p=>p.postingNumber).sort(),expected.map(suffix=>`preview-${suffix}`).sort(),`${trigger} 只返回当前状态匹配的预览包裹`);
    }
    assert.deepEqual(await service.postings(scope,{trigger:'PICKUP',q:'preview-signed'}),[],'搜索已签收订单不能绕过催取货筛选');
    await pool.query("DELETE FROM ozon_message_postings WHERE account_id=$1 AND store_id=$2 AND posting_number LIKE 'preview-%'",[scope.accountId,scope.storeId]);
    const previewResponse=await fetch(origin+'/api/ozon/messages/preview?storeId=s',{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({template:{...overview.templates[0],text:'Заказ {{订单编号}} / {{包裹编号}}'},postingNumber:'100-2-1',accountId:'b'})});
    const preview=await previewResponse.json();assert.equal(previewResponse.status,200);assert.equal(preview.text,'Заказ 100-2 / 100-2-1');assert.equal(sendCount,0);
    const pickup=overview.templates.find(t=>t.trigger==='PICKUP');
    await service.saveTemplate(scope,{...pickup,enabled:true,delayHours:24,text:'Заказ {{订单编号}}, посылка {{包裹编号}}: {{商品清单}}'},pickup.id);
    await service.saveSettings(scope,{enabled:true,displayName:'Мой магазин'});
    assert.equal((await service.records(scope)).length,0,'首次同步不能伪造到店时间');
    const token=(await pool.query('SELECT webhook_token FROM ozon_message_settings WHERE store_id=$1',['s'])).rows[0].webhook_token;
    await assert.rejects(service.webhook('s','wrong',{message_type:'TYPE_PING'}),e=>e.status===404);
    assert.equal((await service.webhook('s',token,{message_type:'TYPE_PING'})).name,'sonli-messages');
    await assert.rejects(service.webhook('s',token,{message_type:'TYPE_STATE_CHANGED',seller_id:'8',posting_number:'100-2-1',new_state:'posting_in_pickup_point',changed_state_date:new Date(now).toISOString()}),e=>e.status===403);
    const event={message_type:'TYPE_STATE_CHANGED',seller_id:'7',posting_number:'100-2-1',new_state:'posting_in_pickup_point',changed_state_date:new Date(now-23*3600000).toISOString()};
    const eventResponse=await fetch(`${origin}/ozon/messages/webhook/s/${token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});
    assert.equal(eventResponse.status,200);
    assert.deepEqual(await eventResponse.json(),{result:true},'业务通知遵循 Ozon 的成功应答格式，与 TYPE_PING 不同');
    await service.webhook('s',token,event);await service.enqueue(scope);
    assert.equal((await service.records(scope)).length,1);
    await service.processNext();assert.equal(sendCount,0);
    now+=3600000;await Promise.all([service.processNext(),service.processNext()]);
    assert.equal(sendCount,1);
    let record=(await service.records(scope))[0];assert.equal(record.status,'SENT');assert.match(record.text,/100-2-1/);assert.match(record.text,/Чашка/);
    await service.saveTemplate(scope,{...pickup,enabled:true,text:'changed {{订单编号}}'},pickup.id);
    assert.equal((await service.records(scope))[0].text,record.text,'已发内容不随模板编辑改变');
    // The other posting is picked up before its reminder is due.
    await service.webhook('s',token,{...event,posting_number:'100-2-2',changed_state_date:new Date(now-25*3600000).toISOString()});
    await service.enqueue(scope);remote.set('100-2-2',raw('100-2-2',{status:'delivered',substatus:'posting_received'}));
    await service.processNext();assert.equal(sendCount,1);assert.equal((await service.records(scope)).find(r=>r.postingNumber==='100-2-2').status,'CANCELLED');
    // Two signed parcels of the same order create one neutral review invite.
    remote.set('100-2-1',raw('100-2-1',{status:'delivered',substatus:'posting_received'}));
    const review=overview.templates.find(t=>t.trigger==='REVIEW');
    await service.saveTemplate(scope,{...review,enabled:true,delayHours:0},review.id);
    now+=1000;
    for(const posting_number of remote.keys())await service.webhook('s',token,{...event,posting_number,new_state:'posting_received',changed_state_date:new Date(now).toISOString()});
    await service.enqueue(scope);
    assert.equal((await service.records(scope)).filter(r=>r.trigger==='REVIEW').length,1);
    timeout=true;await service.processNext();assert.equal(sendCount,2);
    record=(await service.records(scope)).find(r=>r.trigger==='REVIEW');assert.equal(record.status,'UNCERTAIN');
    now+=600000;await service.processNext();assert.equal(sendCount,2,'超时不盲目重发');
    await service.reconcile(scope,record.id);assert.equal((await service.records(scope)).find(r=>r.id===record.id).status,'SENT');
    // An old duplicate arriving DURING GET must not mask the new signed state.
    remote.set('190-1-1',raw('190-1-1'));await service.syncStore(scope);
    const repeated={...event,posting_number:'190-1-1',changed_state_date:new Date(now-25*3600000).toISOString()};
    await service.webhook('s',token,repeated);await service.enqueue(scope);
    duringGet=async body=>{if(body.posting_number==='190-1-1'){now+=10;await service.webhook('s',token,repeated);remote.set('190-1-1',raw('190-1-1',{status:'delivered',substatus:'posting_received'}));}};
    await service.processNext();assert.equal(sendCount,2,'旧到店事件不能覆盖本次 GET 的签收结果');
    assert.equal((await service.records(scope)).find(r=>r.postingNumber==='190-1-1').status,'CANCELLED');duringGet=null;
    // Confirmed chat creation survives a temporary history read failure.
    timeout=false;remote.set('191-1-1',raw('191-1-1'));await service.syncStore(scope);
    await service.webhook('s',token,{...event,posting_number:'191-1-1',changed_state_date:new Date(now-25*3600000).toISOString()});await service.enqueue(scope);
    failHistory=1;const chatsBefore=startChats;await service.processNext();
    assert.equal((await service.records(scope)).find(r=>r.postingNumber==='191-1-1').status,'PENDING');assert.equal(sendCount,2);
    now+=61000;await service.processNext();assert.equal(sendCount,3);assert.equal(startChats,chatsBefore+1,'读取重试应复用已建会话');
    // Earlier authoritative time must bring an unsent 71-hour invite forward.
    await service.saveTemplate(scope,{...review,enabled:true,delayHours:71},review.id);
    remote.set('192-1-1',raw('192-1-1',{status:'delivered',substatus:'posting_received'}));await service.syncStore(scope);
    const signedEvent={...event,posting_number:'192-1-1',new_state:'posting_received',changed_state_date:new Date(now-69*3600000).toISOString()};
    await service.webhook('s',token,signedEvent);await service.enqueue(scope);
    assert.equal((await service.records(scope)).find(r=>r.postingNumber==='192-1-1').dueAt,now+2*3600000);
    await service.webhook('s',token,{...signedEvent,changed_state_date:new Date(now-71*3600000).toISOString()});await service.enqueue(scope);
    assert.equal((await service.records(scope)).find(r=>r.postingNumber==='192-1-1').dueAt,now,'更正时间后重新计算未发送任务');
    await service.processNext();assert.equal(sendCount,4);
    // Crash after CHAT_READY commit, before the optional posting cache write.
    remote.set('193-1-1',raw('193-1-1'));await service.syncStore(scope);
    await service.webhook('s',token,{...event,posting_number:'193-1-1',changed_state_date:new Date(now-25*3600000).toISOString()});
    const readyJob=(await service.records(scope)).find(r=>r.postingNumber==='193-1-1');
    await pool.query("UPDATE ozon_message_records SET body=body || $2::jsonb WHERE id=$1",[readyJob.id,{phase:'CHAT_READY',chatId:'confirmed-chat'}]);
    remote.set('193-1-1',raw('193-1-1',{available_actions:[]}));
    const beforeReady=startChats;await service.processNext();assert.equal(sendCount,5);assert.equal(startChats,beforeReady);
    // An old worker must neither send nor change state after its lease is reclaimed.
    for(const [index,mode] of ['resolve','reject'].entries()) {
      const number=`${194+index}-1-1`;remote.set(number,raw(number));await service.syncStore(scope);
      await service.webhook('s',token,{...event,posting_number:number,changed_state_date:new Date(now-25*3600000).toISOString()});
      const before=sendCount;let entered,release,firstHistory=true;
      const enteredPromise=new Promise(resolve=>{entered=resolve;});const blocked=new Promise(resolve=>{release=resolve;});
      duringHistory=async()=>{if(firstHistory){firstHistory=false;entered();await blocked;if(mode==='reject')throw Object.assign(Error('timeout'),{code:'ZONGZI_TIMEOUT'});}};
      const oldWorker=service.processNext();await enteredPromise;now+=6*60000;
      await service.processNext();release();await oldWorker;duringHistory=null;
      assert.equal(sendCount,before+1,`回收后旧执行者 ${mode} 不得重复发送`);
      assert.equal((await service.records(scope)).find(r=>r.postingNumber===number).status,'SENT','旧执行者不得覆盖新结果');
    }
    // Disabling master cancels queued work; no hidden worker sends afterward.
    const sendsBeforeStop=sendCount;
    remote.set('200-1-1',raw('200-1-1'));remote.set('210-1-1',raw('210-1-1'));await service.syncStore(scope);
    now+=1000;await service.webhook('s',token,{...event,posting_number:'200-1-1',changed_state_date:new Date(now-25*3600000).toISOString()});
    await service.webhook('s',token,{...event,posting_number:'210-1-1',changed_state_date:new Date(now-24*3600000).toISOString()});
    await service.enqueue(scope);timeout=false;
    let releaseSend,enteredSend,closed=false;
    const sendEntered=new Promise(resolve=>{enteredSend=resolve;});const sendBlocked=new Promise(resolve=>{releaseSend=resolve;});
    duringSend=async()=>{enteredSend();await sendBlocked;};
    const sending=service.processNext();await sendEntered;
    const closing=service.saveSettings(scope,{enabled:false}).then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,30));
    const closedWhileSending=closed;releaseSend();await Promise.all([sending,closing]);
    assert.equal(closedWhileSending,false,'关闭操作与发送阶段必须串行协调');
    await service.processNext();assert.equal(sendCount,sendsBeforeStop+1);
    assert.ok((await service.records(scope)).filter(r=>r.postingNumber==='210-1-1').every(r=>r.status==='CANCELLED'));
    await assert.rejects(service.reconcile({accountId:'b',storeId:'other'},record.id),e=>e.status===404);
    history.unshift({message_id:'ambiguous-remote-id',created_at:new Date(now).toISOString(),user:{type:'Seller'},data:['identical message']});
    for(const id of ['ambiguous-a','ambiguous-b'])await pool.query(`INSERT INTO ozon_message_records(id,account_id,store_id,dedupe_key,template_id,status,due_at,created_at,body)
      VALUES($1,'a','s',$1,$2,'UNCERTAIN',$3,$3,$4)`,[id,pickup.id,now,{template:pickup,chatId:'ambiguous-chat',phase:'SEND',sendStartedAt:now,baseline:[],text:'identical message'}]);
    for(const id of ['ambiguous-a','ambiguous-b'])assert.equal((await service.reconcile(scope,id)).status,'UNCERTAIN','一条远端消息无法唯一归属于两个任务');
  } finally {if(httpServer)await new Promise(resolve=>httpServer.close(resolve));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});

test('message pagination reads only the requested store/page and lightweight overview omits lists',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async t=>{
 const schema='message_pages_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 await pool.query("CREATE TABLE accounts(id text PRIMARY KEY,username text,role text,status text,expires_at timestamptz);CREATE TABLE stores(id text PRIMARY KEY,owner_account_id text,client_id text,seller_company_id text,label text,status text);");
 for(const name of ['125_message_management.sql','127_message_confirmation.sql'])await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
 await pool.query("INSERT INTO accounts VALUES('a','a','user','active',NULL),('b','b','user','active',NULL);INSERT INTO stores VALUES('s','a','1','1','store','active'),('other','b','2','2','other','active')");
 const service=createMessageService({pool}),scope={accountId:'a',storeId:'s'};await service.overview(scope,{summaryOnly:true});
 await pool.query(`INSERT INTO ozon_message_postings(account_id,store_id,posting_number,updated_at,body) SELECT 'a','s','posting-'||g,1000+g,jsonb_build_object('postingNumber','posting-'||g,'orderNumber','order-'||g,'status','delivered') FROM generate_series(1,63) g`);
 for(const pageSize of [5,10,20,50]){
  const first=await service.postings(scope,{page:1,pageSize}),second=await service.postings(scope,{page:2,pageSize});
  assert.equal(first.total,63);assert.equal(first.items.length,pageSize);assert.equal(second.items.length,Math.min(pageSize,63-pageSize));
  assert.equal(new Set([...first.items,...second.items].map(row=>row.postingNumber)).size,first.items.length+second.items.length);
 }
 assert.deepEqual((await service.overview(scope,{summaryOnly:true})).postings,[]);
 await assert.rejects(service.postings({accountId:'b',storeId:'s'},{page:1,pageSize:5}),{status:403});
});
