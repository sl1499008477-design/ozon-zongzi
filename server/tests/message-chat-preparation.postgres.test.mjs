import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createMessageService} from '../message-service.mjs';
import {createMessageOzon} from '../message-ozon.mjs';

test('提前准备聊天：保存后到店复用、开关隔离、结果不明不重建', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async()=>{
  const schema='message_prepare_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:8});
    await pool.query('CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,role TEXT,status TEXT,expires_at TIMESTAMPTZ); CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,client_id TEXT,seller_company_id TEXT,label TEXT,status TEXT)');
    for(const file of ['125_message_management.sql','127_message_confirmation.sql'])await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
    await pool.query("INSERT INTO accounts VALUES('a','a','user','active',NULL),('b','b','user','active',NULL); INSERT INTO stores VALUES('s','a','7','7','店铺','active'),('other','b','8','8','其他店铺','active')");
    let now=Date.parse('2026-09-10T12:00:00Z'),duringGet=null,duringStart=null;
    const remote=new Map(),created=[],sent=[],history=[];
    const raw=(number,patch={})=>({posting_number:number,order_number:number.slice(0,-2),status:'awaiting_packaging',substatus:'posting_awaiting_packaging',
      tpl_integration_type:'non_integrated',available_actions:['can_create_chat'],products:[{name:'Чашка',quantity:1}],...patch});
    remote.set('fresh-1-1',raw('fresh-1-1'));
    const api=async(_credential,path,body)=>{
      if(path==='/v1/seller/info')return {subscription:{type:'PREMIUM_PRO'}};
      if(path==='/v4/posting/fbs/list')return {postings:[...remote.values()],has_next:false};
      if(path==='/v3/posting/fbo/list')return {postings:[],has_next:false};
      if(path==='/v3/chat/list')return {chats:[],has_next:false};
      if(path==='/v3/chat/history')return {messages:history,has_next:false};
      if(path==='/v3/posting/fbs/get'){if(duringGet)await duringGet();return {result:remote.get(body.posting_number)};}
      if(path==='/v1/chat/start'){
        created.push(body.posting_number);
        if(duringStart)await duringStart();
        if(['uncertain-1-1','from-send-1-1'].includes(body.posting_number))throw Object.assign(Error('timeout'),{code:'ZONGZI_TIMEOUT'});
        return {result:{chat_id:'chat-'+body.posting_number}};
      }
      if(path==='/v1/chat/send/message'){
        sent.push(body);history.unshift({message_id:'1',created_at:new Date(now).toISOString(),user:{type:'Seller'},data:[body.text],context:{order_number:'fresh-1'}});
        return {result:'success'};
      }
      throw Error('Unexpected '+path);
    };
    const service=createMessageService({pool,ozon:createMessageOzon({callApi:api}),readCredential:async()=>({clientId:'7',apiKey:'fixture'}),clock:()=>now});
    const scope={accountId:'a',storeId:'s'};
    let overview=await service.overview(scope);
    await service.syncStore(scope);
    assert.equal(await service.prepareChatNext(),false,'总开关及模板关闭时没有建聊任务');
    const pickup=overview.templates.find(t=>t.trigger==='PICKUP');
    await service.saveTemplate(scope,{...pickup,enabled:true,delayHours:1,text:'Посылка {{包裹编号}} ожидает с {{到店日期}}'},pickup.id);
    await service.saveSettings(scope,{enabled:true,displayName:'Shop'});
    await Promise.all([service.prepareChatNext(),service.prepareChatNext()]);
    let posting=(await service.postings(scope)).find(p=>p.postingNumber==='fresh-1-1');
    assert.equal(posting.chatId,'chat-fresh-1-1');
    assert.equal(posting.chatPreparation.status,'READY');
    assert.deepEqual(created,['fresh-1-1'],'并发准备只能创建一次');
    assert.equal(sent.length,0,'准备会话不会发送正文');
    assert.equal(posting.events.PICKUP,undefined,'不会为准备会话伪造到店时间');
    remote.set('fresh-1-1',raw('fresh-1-1',{status:'delivering',substatus:'posting_in_pickup_point',available_actions:[]}));
    now+=24*3600000;
    await service.syncStore(scope);
    const token=(await pool.query("SELECT webhook_token FROM ozon_message_settings WHERE account_id='a' AND store_id='s'")).rows[0].webhook_token;
    await service.webhook('s',token,{message_type:'TYPE_STATE_CHANGED',seller_id:7,posting_number:'fresh-1-1',new_state:'posting_in_pickup_point',changed_state_date:new Date(now).toISOString()});
    await service.processNext();assert.equal(sent.length,0);
    now+=3600001;await service.processNext();
    assert.equal(sent.length,1);assert.equal(sent[0].chat_id,'chat-fresh-1-1');
    assert.equal(created.length,1,'到店后复用提前建立的会话');
    assert.ok(!sent[0].text.includes('{{'));
    remote.set('uncertain-1-1',raw('uncertain-1-1'));
    remote.set('missed-1-1',raw('missed-1-1',{available_actions:[]}));
    remote.set('signed-1-1',raw('signed-1-1',{status:'delivered',substatus:'posting_received'}));
    remote.set('already-pickup-1-1',raw('already-pickup-1-1',{status:'delivering',substatus:'posting_in_pickup_point'}));
    await service.syncStore(scope);
    await service.prepareChatNext();now+=10*60000;
    await service.syncStore(scope);await service.prepareChatNext();
    posting=(await service.postings(scope)).find(p=>p.postingNumber==='uncertain-1-1');
    assert.equal(posting.chatPreparation.status,'UNCERTAIN');
    assert.equal(created.filter(n=>n==='uncertain-1-1').length,1,'写入结果不明后不重试建聊');
    assert.ok(!created.some(n=>/missed|signed|already-pickup/.test(n)));
    remote.set('uncertain-1-1',raw('uncertain-1-1',{status:'delivering',substatus:'posting_in_pickup_point'}));
    await service.syncStore(scope);
    await service.webhook('s',token,{message_type:'TYPE_STATE_CHANGED',seller_id:7,posting_number:'uncertain-1-1',new_state:'posting_in_pickup_point',changed_state_date:new Date(now-2*3600000).toISOString()});
    await service.processNext();assert.equal(sent.length,1,'建聊结果不明的包裹到店后也不能盲目重建');
    remote.set('disabled-1-1',raw('disabled-1-1'));await service.syncStore(scope);
    duringGet=async()=>{duringGet=null;await service.saveSettings(scope,{enabled:false});};
    await service.prepareChatNext();
    assert.ok(!created.includes('disabled-1-1'),'读取期间关闭开关后不得建聊');
    overview=await service.overview(scope);
    assert.equal(overview.settings.chatPreparationCounts.READY,1);
    assert.equal(overview.settings.chatPreparationCounts.UNCERTAIN,1);
    // A different template may have already attempted to open this posting's chat.
    remote.set('disabled-1-1',raw('disabled-1-1',{available_actions:[]}));
    await service.saveSettings(scope,{enabled:true});
    const shipping=overview.templates.find(t=>t.trigger==='SHIPPING_READY');
    await service.saveTemplate(scope,{...shipping,enabled:true,delayHours:0,text:'Подготовлено {{包裹编号}}'},shipping.id);
    remote.set('from-send-1-1',raw('from-send-1-1',{status:'awaiting_deliver',substatus:'posting_transferring_to_delivery'}));
    await service.syncStore(scope);
    await service.webhook('s',token,{message_type:'TYPE_STATE_CHANGED',seller_id:7,posting_number:'from-send-1-1',new_state:'posting_transferring_to_delivery',changed_state_date:new Date(now).toISOString()});
    await service.processNext();await service.prepareChatNext();
    assert.equal(created.filter(n=>n==='from-send-1-1').length,1,'其他模板已经结果不明的建聊不能被提前准备重复调用');
    const shipped=overview.templates.find(t=>t.trigger==='SHIPPED');
    await service.saveTemplate(scope,{...shipped,enabled:true,delayHours:0,text:'Отправлено {{包裹编号}}'},shipped.id);
    remote.set('from-send-1-1',raw('from-send-1-1',{status:'delivering',substatus:'posting_on_way_to_city'}));
    now+=1000;await service.syncStore(scope);
    await service.webhook('s',token,{message_type:'TYPE_STATE_CHANGED',seller_id:7,posting_number:'from-send-1-1',new_state:'posting_on_way_to_city',changed_state_date:new Date(now).toISOString()});
    await service.processNext();
    assert.equal(created.filter(n=>n==='from-send-1-1').length,1,'后续另一种提醒也不能重复调用结果不明的建聊');
    // Queued shipping notifications must wait for an in-flight preparation.
    remote.set('race-1-1',raw('race-1-1',{status:'awaiting_deliver',substatus:'posting_transferring_to_delivery'}));
    await service.syncStore(scope);
    await service.webhook('s',token,{message_type:'TYPE_STATE_CHANGED',seller_id:7,posting_number:'race-1-1',new_state:'posting_transferring_to_delivery',changed_state_date:new Date(now).toISOString()});
    let release,entered;
    const started=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{release=resolve;});
    duringStart=async()=>{entered();await held;};
    const preparation=service.prepareChatNext();await started;
    await service.processNext();release();await preparation;duringStart=null;
    assert.equal((await service.records(scope)).find(r=>r.postingNumber==='race-1-1').status,'PENDING','正在准备会话时暂缓，不能永久跳过');
    now+=16000;await service.processNext();
    assert.equal((await service.records(scope)).find(r=>r.postingNumber==='race-1-1').status,'SENT');
    assert.equal(created.filter(n=>n==='race-1-1').length,1);
    // A real Premium Pro response omits can_create_chat even when chat/start succeeds.
    remote.set('no-action-1-1',raw('no-action-1-1',{available_actions:[],in_process_at:new Date(now-8*60000).toISOString()}));
    remote.set('old-no-action-1-1',raw('old-no-action-1-1',{available_actions:[],in_process_at:new Date(now-73*3600000).toISOString()}));
    await service.syncStore(scope);await service.prepareChatNext();await service.prepareChatNext();
    assert.equal(created.filter(n=>n==='no-action-1-1').length,1,'新订单缺少动作标记仍须通过真实建聊接口确认');
    assert.ok(!created.includes('old-no-action-1-1'),'旧订单无可用窗口时不批量尝试建聊');
    assert.equal((await service.postings(scope)).find(p=>p.postingNumber==='no-action-1-1').chatPreparation.status,'READY');
  } finally {
    await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
