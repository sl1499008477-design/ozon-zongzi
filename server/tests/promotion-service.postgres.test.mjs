import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createPromotionService} from '../promotion-service.mjs';
import {createPromotionRuntime} from '../promotion-runtime.mjs';

test('活动管理数据库端到端：预览、报名、AUTO退出、移除底价、定时、隔离及未知写入恢复',{skip:process.env.SONLI_POSTGRES_TESTS!=='1'},async()=>{
  const schema='promotion_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool,http;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
    await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT,expires_at TIMESTAMPTZ); CREATE TABLE stores(id TEXT PRIMARY KEY,owner_account_id TEXT,status TEXT);
      INSERT INTO accounts VALUES('a','active',NULL),('b','active',NULL); INSERT INTO stores VALUES('s','a','active'),('other','b','active');
      CREATE TABLE products(store_id TEXT,product_id TEXT,image_url TEXT);
      INSERT INTO products VALUES('s','p','https://cdn.example/own-product.jpg'),('other','p','https://cdn.example/other-store.jpg')`);
    await pool.query(await readFile(new URL('../db/migrations/129_promotion_management.sql',import.meta.url),'utf8'));
    let now=Date.parse('2026-09-10T12:00:00Z'),writes=[],failRead=false,timeout=false,writeHook=null;
    const remote={actions:[{id:'act',title:'真实结构活动',type:'STOCK_DISCOUNT',startAt:'2026-09-01T00:00:00Z',endAt:'2026-10-01T00:00:00Z',freezeAt:'',autoAddDates:['2026-09-15T21:00:00Z'],candidates:[{productId:'p',maxPrice:'112.00',minQuantity:1},{productId:'q',maxPrice:'109.00',minQuantity:1}]}],products:['p','q','manual'].map(id=>({productId:id,name:id,offerId:'offer-'+id,currency:'CNY',basePrice:'200.00',currentPrice:'120.00',availableStock:10,archived:false,minPrice:null,minPriceEnabled:false})),memberships:[{actionId:'act',productId:'manual',batchAt:'',mode:'MANUAL',price:'80.00',quantity:0,currency:'CNY'}]};
    const ozon={
      snapshot:async()=>{if(failRead)throw Object.assign(Error('fixture read outage'),{code:'ZONGZI_TIMEOUT'});return structuredClone({...remote,fetchedAt:new Date(now).toISOString()});},
      refreshTargets:async()=>ozon.snapshot(),
      activate:async(c,{actionId,products})=>{writes.push({operation:'JOIN',products});if(writeHook)await writeHook();for(const p of products)remote.memberships.push({actionId,productId:p.productId,batchAt:'',mode:'MANUAL',price:p.price,quantity:p.quantity,currency:'CNY'});if(timeout)throw Object.assign(Error('fixture timeout'),{code:'ZONGZI_TIMEOUT',status:504});return {acceptedIds:products.map(p=>p.productId),rejected:[]};},
      deactivate:async(c,{actionId,productIds})=>{writes.push({operation:'EXIT',productIds});remote.memberships=remote.memberships.filter(m=>!(m.actionId===actionId&&!m.batchAt&&productIds.includes(m.productId)));return {acceptedIds:productIds,rejected:[]};},
      cancelFuture:async(c,{actionId,batchAt,productIds})=>{writes.push({operation:'CANCEL_FUTURE',productIds});remote.memberships=remote.memberships.filter(m=>!(m.actionId===actionId&&m.batchAt===batchAt&&productIds.includes(m.productId)));return {acceptedIds:productIds,rejected:[]};},
      protectPrices:async(c,{products})=>{writes.push({operation:'SET_FLOOR',products});for(const p of products)Object.assign(remote.products.find(x=>x.productId===p.productId),{minPrice:p.minPrice,minPriceEnabled:true,minPriceExpiresAt:new Date(now+30*86400000).toISOString()});return {acceptedIds:products.map(p=>p.productId),rejected:[]};},
      renewPrices:async(c,{productIds})=>{writes.push({operation:'RENEW_FLOOR',productIds});for(const id of productIds)remote.products.find(x=>x.productId===id).minPriceExpiresAt=new Date(now+30*86400000).toISOString();return {acceptedIds:productIds,rejected:[]};},
    };
    const service=createPromotionService({pool,ozon,readCredential:async()=>({clientId:'fixture',apiKey:'fixture'}),clock:()=>now}),scope={accountId:'a',storeId:'s'};
    const runtime=createPromotionRuntime({resolveService:async()=>service,authenticate:async req=>{if(req.headers.authorization!=='Bearer fixture')throw Object.assign(Error('请登录'),{status:401});return {id:'a',role:'user'};},readJson:async req=>{const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString());},sendJson:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}});
    http=createServer(async(req,res)=>{if(!await runtime.handleRoute(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${http.address().port}`;
    assert.equal((await fetch(base+'/ozon/promotions/overview?storeId=s')).status,401);
    assert.equal((await fetch(base+'/api/ozon/promotions/overview?storeId=other',{headers:{Authorization:'Bearer fixture'}})).status,403);
    assert.equal((await service.overview(scope)).settings.enabled,false);
    await assert.rejects(service.overview({accountId:'b',storeId:'s'}),e=>e.status===403);
    await service.syncStore(scope);assert.equal(writes.length,0);
    assert.equal((await service.overview(scope)).products.find(p=>p.productId==='p').imageUrl,'https://cdn.example/own-product.jpg','旧快照按本店商品补齐主图，不能串店');
    await pool.query("UPDATE ozon_promotion_stores SET config=config || $1::jsonb WHERE account_id='a' AND store_id='s'",[{floors:{p:{price:'9999',currency:'RUB'}},protectPrices:true}]);
    const ruleInput={name:'每日报名',enabled:true,actionIds:['act'],productIds:[],categoryIds:[],minStock:1,maxDiscountPercent:45,quantity:1,schedule:{mode:'DAILY',time:'21:00',timeZone:'Asia/Shanghai'}};
    await service.saveRule(scope,ruleInput);let rule=(await service.overview(scope)).rules[0];
    let preview=await service.preview(scope,{source:'RULE',ruleId:rule.id});
    assert.equal(preview.items.length,1);assert.equal(preview.items[0].productId,'p');assert.equal(preview.skipped.length,1);assert.equal(writes.length,0);
    assert.equal(preview.items[0].basePrice,'200.00');assert.equal(preview.items[0].discountPercent,'44.00');
    await assert.rejects(service.execute({accountId:'b',storeId:'other'},preview.id),e=>e.status===404);
    await service.execute(scope,preview.id);await service.execute(scope,preview.id);
    const initialRefreshTargets=ozon.refreshTargets;
    ozon.refreshTargets=async()=>{const fresh=await ozon.snapshot();fresh.products.find(p=>p.productId==='p').basePrice='180.00';return fresh;};
    await Promise.all([service.processNext(),service.processNext()]);
    ozon.refreshTargets=initialRefreshTargets;
    assert.equal(writes.length,1);let record=(await service.overview(scope)).records.find(x=>x.id===preview.id);assert.equal(record.status,'COMPLETED');
    assert.equal(record.items[0].status,'SUCCEEDED');
    assert.equal(record.items[0].price,'112.00');assert.equal(record.items[0].basePrice,'180.00');
    assert.equal(record.items[0].discountPercent,'37.78');assert.equal(record.items[0].maxDiscountPercent,45);
    // Current and future AUTO are independent; existing MANUAL must remain.
    remote.memberships.push({actionId:'act',productId:'q',batchAt:'',mode:'AUTO',price:'100.00',quantity:0,currency:'CNY'},{actionId:'act',productId:'p',batchAt:'2026-09-15T21:00:00Z',mode:'AUTO',price:'99.00',quantity:0,currency:'CNY'});
    preview=await service.preview(scope,{source:'EXIT'});assert.deepEqual(preview.items.map(x=>x.operation),['EXIT','CANCEL_FUTURE']);
    await service.execute(scope,preview.id);await service.processNext();
    assert.ok(remote.memberships.some(x=>x.productId==='manual'));assert.ok(remote.memberships.every(x=>x.mode==='MANUAL'));
    // Manual preview cannot override changed protection settings.
    remote.memberships.push({actionId:'act',productId:'q',batchAt:'',mode:'AUTO',price:'100.00',quantity:0,currency:'CNY'});
    preview=await service.preview(scope,{source:'EXIT'});await service.saveSettings(scope,{protectedProductIds:['q']});await service.execute(scope,preview.id);const before=writes.length;await service.processNext();assert.equal(writes.length,before);
    // Retired endpoints/previews cannot change platform prices; queued legacy plans are cancelled.
    assert.equal((await fetch(base+'/ozon/promotions/floors?storeId=s',{method:'PUT',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({items:[]})})).status,404);
    await assert.rejects(service.preview(scope,{source:'FLOORS'}),/已移除/);
    const legacyFloorId=randomUUID(),legacyFloor={items:[{operation:'SET_FLOOR',productId:'p',actionId:'',batchAt:'',price:'100.00',currency:'CNY',status:'PLANNED'}],skipped:[]};
    await pool.query("INSERT INTO ozon_promotion_runs(id,account_id,store_id,source,status,body,created_at,updated_at) VALUES($1,'a','s','FLOORS','PREVIEW',$2,$3,$3)",[legacyFloorId,legacyFloor,now]);
    await assert.rejects(service.execute(scope,legacyFloorId),/已移除/);
    await pool.query("UPDATE ozon_promotion_runs SET status='QUEUED' WHERE id=$1",[legacyFloorId]);
    const beforeLegacyFloor=writes.length;await service.processNext();assert.equal(writes.length,beforeLegacyFloor);
    assert.equal((await service.overview(scope)).records.find(x=>x.id===legacyFloorId).items[0].status,'CANCELLED');
    await pool.query("UPDATE ozon_promotion_stores SET config=config || $1::jsonb WHERE account_id='a' AND store_id='s'",[{enabled:true,exitEnabled:true,exitMode:'BELOW_FLOOR',protectPrices:true,floors:{q:{price:'9999',currency:'CNY'}}}]);
    const legacyView=await service.overview(scope);assert.equal(legacyView.settings.exitEnabled,false);assert.equal('floors' in legacyView.settings,false);
    assert.equal((await service.preview(scope,{source:'EXIT'})).items.length,0);
    const beforeLegacyPoll=(await service.overview(scope)).records.length;await service.requestSync(scope);await service.pollNext();
    assert.equal((await service.overview(scope)).records.length,beforeLegacyPoll,'历史底价开关不再自动排队');
    await service.saveSettings(scope,{enabled:false});
    assert.equal(writes.some(x=>['SET_FLOOR','RENEW_FLOOR'].includes(x.operation)),false);

    // A lost acknowledgement followed by a lost read remains unknown; it must not resend.
    remote.memberships=remote.memberships.filter(m=>m.productId!=='p');
    preview=await service.preview(scope,{source:'RULE',ruleId:rule.id});await service.execute(scope,preview.id);timeout=true;writeHook=async()=>{failRead=true;};
    await service.processNext();record=(await service.overview(scope)).records.find(x=>x.id===preview.id);assert.equal(record.status,'UNCERTAIN');
    const afterUnknown=writes.length;await service.processNext();assert.equal(writes.length,afterUnknown);
    failRead=false;timeout=false;writeHook=null;
    record=await service.reconcile(scope,preview.id);assert.equal(record.status,'COMPLETED');assert.equal(writes.length,afterUnknown);
    // Future jobs stay off until the master switch is enabled. A due slot is queued once.
    remote.memberships=remote.memberships.filter(m=>m.productId!=='p');now=Date.parse('2026-09-10T13:00:01Z');await service.pollNext();assert.equal(writes.length,afterUnknown);
    await service.saveSettings(scope,{enabled:true});await service.pollNext();await service.pollNext();await service.processNext();assert.equal(writes.length,afterUnknown+1);
    await service.pollNext();await service.processNext();assert.equal(writes.length,afterUnknown+1);
    rule=(await service.overview(scope)).rules[0];assert.match(rule.nextRunAt,/2026-09-11T13:00/);
    // An automatic queued exit is cancelled if the master is stopped before execution.
    await service.saveSettings(scope,{exitEnabled:true,protectedProductIds:[]});await service.requestSync(scope);await service.pollNext();await service.saveSettings(scope,{enabled:false});await service.processNext();assert.ok(remote.memberships.some(m=>m.productId==='q'&&m.mode==='AUTO'));
    // Simulate process death after an external write: reconcile the submitted row, never repeat it.
    preview=await service.preview(scope,{source:'EXIT'});await service.execute(scope,preview.id);
    const data=(await pool.query('SELECT body FROM ozon_promotion_runs WHERE id=$1',[preview.id])).rows[0].body;data.items=data.items.map(x=>({...x,status:'SUBMITTED'}));
    await pool.query("UPDATE ozon_promotion_runs SET status='RUNNING',body=$2 WHERE id=$1",[preview.id,data]);remote.memberships=remote.memberships.filter(m=>m.mode!=='AUTO');
    const beforeRecovery=writes.length;await service.processNext();assert.equal(writes.length,beforeRecovery);assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'COMPLETED');
    // Single scheduled execution must run, not be cancelled by consuming its schedule.
    failRead=false;remote.memberships=remote.memberships.filter(m=>m.productId!=='p');
    await service.saveRule(scope,{...ruleInput,name:'单次执行',schedule:{mode:'ONCE',at:new Date(now+60000).toISOString(),timeZone:'Asia/Shanghai'}});
    await service.saveSettings(scope,{enabled:true,exitEnabled:false});now+=61000;await service.pollNext();
    const beforeOnce=writes.length;await service.processNext();assert.equal(writes.length,beforeOnce+1,'单次规则到期后必须真正执行');
    // A partial platform rejection is reported per product, not as total success.
    await service.saveSettings(scope,{enabled:false});remote.memberships=remote.memberships.filter(m=>!['p','q'].includes(m.productId));
    await service.saveRule(scope,{...ruleInput,maxDiscountPercent:null},rule.id);
    const originalActivate=ozon.activate;ozon.activate=async(c,args)=>{const result=await originalActivate(c,{...args,products:args.products.filter(x=>x.productId==='p')});return {...result,rejected:[{productId:'q',reason:'平台限制该商品'}]};};
    preview=await service.preview(scope,{source:'RULE',ruleId:rule.id});await service.execute(scope,preview.id);await service.processNext();
    record=(await service.overview(scope)).records.find(x=>x.id===preview.id);assert.equal(record.status,'PARTIAL');assert.equal(record.items.find(x=>x.productId==='q').error,'平台限制该商品');
    ozon.activate=originalActivate;
    // Provenance is re-read for every external batch, including subsequent activities.
    remote.actions.push({...remote.actions[0],id:'second',candidates:[]},{...remote.actions[0],id:'third',candidates:[]});
    remote.memberships.push(...['second','third'].map(actionId=>({actionId,productId:'q',batchAt:'',mode:'AUTO',price:'90.00',quantity:0,currency:'CNY'})));
    const originalDeactivate=ozon.deactivate;
    ozon.deactivate=async(c,args)=>{const result=await originalDeactivate(c,args);if(args.actionId==='second')remote.memberships.find(m=>m.actionId==='third').mode='MANUAL';return result;};
    preview=await service.preview(scope,{source:'EXIT'});await service.execute(scope,preview.id);await service.processNext();
    assert.ok(remote.memberships.some(m=>m.actionId==='third'&&m.mode==='MANUAL'),'后续批次被人工接管后必须保留');
    ozon.deactivate=originalDeactivate;
    // A read failure after consuming ONCE retains the same run for retry, not a lost schedule.
    remote.memberships=remote.memberships.filter(m=>m.productId!=='p');
    await service.saveRule(scope,{...ruleInput,name:'读取恢复',productIds:['p'],schedule:{mode:'ONCE',at:new Date(now+60000).toISOString(),timeZone:'Asia/Shanghai'}});
    await service.saveSettings(scope,{enabled:true,exitEnabled:false});now+=61000;await service.pollNext();failRead=true;
    const beforeReadRetry=writes.length;await service.processNext();assert.equal(writes.length,beforeReadRetry);
    failRead=false;assert.equal(await service.processNext(),false,'退避到期前不得循环读取');
    now+=61000;await service.processNext();assert.equal(writes.length,beforeReadRetry+1,'读取恢复后单次日程须继续执行');
    // An ONCE slot with no eligible products is complete and must no longer appear enabled.
    await service.saveRule(scope,{...ruleInput,name:'空结果单次日程',maxDiscountPercent:0,schedule:{mode:'ONCE',at:new Date(now+60000).toISOString(),timeZone:'Asia/Shanghai'}});
    now+=61000;await service.pollNext();
    assert.equal((await service.overview(scope)).rules.find(x=>x.name==='空结果单次日程').enabled,false);
    await service.saveSettings(scope,{enabled:false});
    // NONE is persisted and rechecked across other campaigns immediately before writing.
    const remoteBeforeScope=structuredClone(remote),originalRefreshTargets=ozon.refreshTargets;
    remote.actions=[{...remote.actions[0],candidates:[{productId:'p',maxPrice:'112.00',minQuantity:1}]},{...remote.actions[0],id:'new-activity',candidates:[]}];remote.memberships=[];
    await service.saveRule(scope,{...ruleInput,name:'无任何报名商品',enabled:false,participationScope:'NONE',actionIds:[],productIds:['p'],minPrice:'100.00'});
    const noneRule=(await service.overview(scope)).rules.find(x=>x.name==='无任何报名商品');
    assert.equal(noneRule.participationScope,'NONE');
    preview=await service.preview(scope,{source:'RULE',ruleId:noneRule.id});assert.equal(preview.items.length,1);
    const targetChecks=[];
    ozon.refreshTargets=async(c,args)=>{
      targetChecks.push(args);
      remote.memberships=[{actionId:'new-activity',productId:'p',batchAt:'2026-09-15T21:00:00Z',mode:'AUTO',price:'100.00',currency:'CNY'}];
      const fresh=await originalRefreshTargets(c,args);
      if(!args.includeAllMemberships)fresh.memberships=fresh.memberships.filter(x=>x.actionId===args.actionId);
      return fresh;
    };
    const beforeScope=writes.length;await service.execute(scope,preview.id);await service.processNext();
    assert.equal(writes.length,beforeScope,'预览后新增其他活动未来报名，执行前必须停止');
    assert.equal(targetChecks[0].includeAllMemberships,true);
    record=(await service.overview(scope)).records.find(x=>x.id===preview.id);assert.equal(record.items[0].status,'CANCELLED');
    ozon.refreshTargets=originalRefreshTargets;
    // An explicit rejection in A is not an uncertain enrollment and must not block B.
    remote.memberships=[];
    ozon.activate=async(c,args)=>{writes.push({operation:'JOIN',actionId:args.actionId,products:args.products});return {acceptedIds:[],rejected:args.products.map(x=>({productId:x.productId,reason:'该活动不允许此商品'}))};};
    preview=await service.preview(scope,{source:'RULE',ruleId:noneRule.id});await service.execute(scope,preview.id);await service.processNext();
    assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'FAILED');
    remote.actions[1].candidates=structuredClone(remote.actions[0].candidates);ozon.activate=originalActivate;
    await service.saveRule(scope,{...ruleInput,name:'其他活动失败后仍可报名',participationScope:'NONE',actionIds:['new-activity'],productIds:['p'],minPrice:'100.00',schedule:{mode:'ONCE',at:new Date(now+60000).toISOString(),timeZone:'Asia/Shanghai'}});
    await service.saveSettings(scope,{enabled:true});now+=61000;await service.pollNext();
    const beforeOtherAction=writes.length;await service.processNext();
    assert.equal(writes.length,beforeOtherAction+1,'活动A明确拒绝不能消耗活动B的NONE单次日程');
    assert.ok(remote.memberships.some(x=>x.actionId==='new-activity'&&x.productId==='p'));
    await service.saveSettings(scope,{enabled:false});
    // Eventual consistency or a lost reply cannot enroll the same product in a second campaign.
    remote.memberships=[];remote.actions[1].candidates=structuredClone(remote.actions[0].candidates);
    ozon.activate=async(c,args)=>{writes.push({operation:'JOIN',actionId:args.actionId,products:args.products});throw Object.assign(Error('fixture unknown join'),{status:504});};
    preview=await service.preview(scope,{source:'RULE',ruleId:noneRule.id});assert.equal(preview.items.length,2);
    const beforeUnknownJoin=writes.length;
    await service.execute(scope,preview.id);await service.processNext();
    assert.equal(writes.length,beforeUnknownJoin+1,'首次报名未能确认时不能继续报名其他活动');
    record=(await service.overview(scope)).records.find(x=>x.id===preview.id);
    assert.deepEqual(record.items.map(x=>x.status),['UNCERTAIN','CANCELLED']);
    await service.saveRule(scope,{...noneRule,actionIds:['new-activity']},noneRule.id);
    const laterPreview=await service.preview(scope,{source:'RULE',ruleId:noneRule.id});
    assert.equal(laterPreview.items.length,0,'其他运行也必须等待此前未知报名的核对结果');
    assert.match(laterPreview.skipped[0].reason,/报名.*核对|报名.*处理/);
    const submitted=record.items[0];remote.memberships=[{...submitted,mode:'MANUAL'}];
    await service.reconcile(scope,preview.id);
    ozon.activate=originalActivate;Object.assign(remote,remoteBeforeScope);
    // Non-stock campaigns persist no quantity, invalidate old quantity-bearing previews, and reconcile without it.
    const remoteBeforeQuantity=structuredClone(remote);
    remote.actions=[{...remote.actions[0],id:'elastic-quantity',type:'ELASTIC_BOOSTING',candidates:[{productId:'p',maxPrice:'112.00',minQuantity:999}]}];remote.memberships=[];
    await service.saveRule(scope,{...ruleInput,name:'弹性活动不填件数',enabled:false,actionIds:['elastic-quantity'],productIds:['p'],quantity:null});
    const noQuantityRule=(await service.overview(scope)).rules.find(x=>x.name==='弹性活动不填件数');assert.equal(noQuantityRule.quantity,null);
    preview=await service.preview(scope,{source:'RULE',ruleId:noQuantityRule.id});assert.equal(preview.items.length,1);assert.equal(preview.items[0].quantity,null);
    const oldQuantityBody=(await pool.query('SELECT body FROM ozon_promotion_runs WHERE id=$1',[preview.id])).rows[0].body;oldQuantityBody.items[0].quantity=1;
    await pool.query('UPDATE ozon_promotion_runs SET body=$2 WHERE id=$1',[preview.id,oldQuantityBody]);
    const beforeQuantityWrites=writes.length;await service.execute(scope,preview.id);await service.processNext();assert.equal(writes.length,beforeQuantityWrites,'旧数量预览须停止并重新生成');
    ozon.activate=async(c,args)=>{const result=await originalActivate(c,args);remote.memberships.forEach(m=>m.quantity=99);return result;};
    preview=await service.preview(scope,{source:'RULE',ruleId:noQuantityRule.id});await service.execute(scope,preview.id);await service.processNext();
    assert.equal(writes.at(-1).products[0].quantity,null);assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'COMPLETED');
    // Legacy zero is readable but skips only the stock-discount part of a mixed rule.
    remote.memberships=[];remote.actions.push({...remote.actions[0],id:'stock-quantity',type:'STOCK_DISCOUNT',candidates:[{productId:'p',maxPrice:'112.00',minQuantity:1}]});
    await pool.query("UPDATE ozon_promotion_rules SET body=jsonb_set(jsonb_set(body,'{quantity}','0'),'{actionIds}','[]') WHERE id=$1",[noQuantityRule.id]);
    const legacyQuantityRule=(await service.overview(scope)).rules.find(x=>x.id===noQuantityRule.id);assert.equal(legacyQuantityRule.quantity,0);
    preview=await service.preview(scope,{source:'RULE',ruleId:noQuantityRule.id});
    assert.deepEqual(preview.items.map(x=>[x.actionId,x.quantity]),[['elastic-quantity',null]]);assert.match(preview.skipped[0].reason,/库存折扣.*参活件数/);
    await assert.rejects(service.saveRule(scope,legacyQuantityRule,legacyQuantityRule.id),/参活件数/);
    await service.saveRule(scope,{...legacyQuantityRule,quantity:3},legacyQuantityRule.id);
    preview=await service.preview(scope,{source:'RULE',ruleId:noQuantityRule.id});assert.deepEqual(preview.items.map(x=>[x.actionId,x.quantity]),[['elastic-quantity',null],['stock-quantity',3]]);
    ozon.activate=originalActivate;Object.assign(remote,remoteBeforeQuantity);
    // A configured decrease prices from the non-activity base and cannot silently
    // become a deeper discount when the platform or base changes before dispatch.
    const remoteBeforeRatio=structuredClone(remote),refreshBeforeRatio=ozon.refreshTargets;
    remote.actions=[{...remote.actions[0],id:'ratio-action',type:'ELASTIC_BOOSTING',candidates:[{productId:'ratio-product',maxPrice:'112.00'}]}];
    remote.products=[{...remote.products[0],productId:'ratio-product',basePrice:'200.00',currentPrice:'130.00'}];remote.memberships=[];
    await service.saveRule(scope,{...ruleInput,name:'指定报名降价比例',enabled:false,actionIds:['ratio-action'],productIds:['ratio-product'],quantity:null,targetDiscountPercent:50,maxDiscountPercent:50});
    const ratioRule=(await service.overview(scope)).rules.find(x=>x.name==='指定报名降价比例');assert.equal(ratioRule.targetDiscountPercent,50);
    const ratioWrites=writes.length;
    for(const change of ['base','platform']){
      preview=await service.preview(scope,{source:'RULE',ruleId:ratioRule.id});assert.equal(preview.items[0].price,'100.00');
      await service.execute(scope,preview.id);
      ozon.refreshTargets=async()=>{const fresh=await ozon.snapshot();if(change==='base')fresh.products[0].basePrice='210.00';else fresh.actions[0].candidates[0].maxPrice='99.00';return fresh;};
      await service.processNext();record=(await service.overview(scope)).records.find(x=>x.id===preview.id);
      assert.equal(writes.length,ratioWrites,'提交前目标价格或平台上限变化须停止旧预览');assert.equal(record.status,'CANCELLED');
      if(change==='platform')assert.match(record.items[0].error,/100\.00.*99\.00/);
      ozon.refreshTargets=refreshBeforeRatio;
    }
    preview=await service.preview(scope,{source:'RULE',ruleId:ratioRule.id});await service.execute(scope,preview.id);await service.execute(scope,preview.id);
    await service.processNext();await service.processNext();
    assert.equal(writes.length,ratioWrites+1);assert.equal(writes.at(-1).products[0].price,'100.00');
    record=(await service.overview(scope)).records.find(x=>x.id===preview.id);assert.equal(record.status,'COMPLETED');
    assert.deepEqual([record.items[0].basePrice,record.items[0].targetDiscountPercent,record.items[0].discountPercent,record.items[0].maxDiscountPercent],['200.00',50,'50.00',50]);
    remote.memberships=[];await service.saveRule(scope,{targetDiscountPercent:30},ratioRule.id);
    preview=await service.preview(scope,{source:'RULE',ruleId:ratioRule.id});assert.equal(preview.items.length,0);assert.equal(preview.skipped[0].price,'140.00');
    assert.match(preview.skipped[0].reason,/140\.00.*112\.00/);await assert.rejects(service.execute(scope,preview.id),/没有可执行商品/);
    assert.equal(writes.length,ratioWrites+1,'不满足设定比例时不得回退平台价格报名');
    await service.saveRule(scope,{targetDiscountPercent:null},ratioRule.id);
    assert.equal((await service.overview(scope)).rules.find(x=>x.id===ratioRule.id).targetDiscountPercent,null);
    preview=await service.preview(scope,{source:'RULE',ruleId:ratioRule.id});assert.equal(preview.items[0].price,'112.00');
    Object.assign(remote,remoteBeforeRatio);ozon.refreshTargets=refreshBeforeRatio;
    // The API cutover invalidates fixed-price previews even when the numeric
    // amount is unchanged. New writes preserve Money currency and warnings.
    const beforeV2=structuredClone(remote);
    remote.priceSemantics='FIXED';
    remote.actions=[{id:'v2-action',type:'ELASTIC_BOOSTING',isVoucher:false,endAt:'2027-01-01T00:00:00Z',candidates:[{productId:'v2-product',maxPrice:'70.00',currency:'CNY'}]}];
    remote.products=[{productId:'v2-product',currency:'CNY',basePrice:'100.00',availableStock:5}];remote.memberships=[];
    await service.saveRule(scope,{...ruleInput,name:'新版限价',enabled:false,actionIds:['v2-action'],productIds:['v2-product'],quantity:null,maxDiscountPercent:null});
    const v2Rule=(await service.overview(scope)).rules.find(x=>x.name==='新版限价');
    preview=await service.preview(scope,{source:'RULE',ruleId:v2Rule.id});
    remote.priceSemantics='CEILING';
    const beforeCutover=writes.length;await service.execute(scope,preview.id);await service.processNext();
    assert.equal(writes.length,beforeCutover,'固定活动价旧预览不能跨新机制直接提交');
    assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'CANCELLED');
    const beforeBoundary=now;remote.priceSemantics='FIXED';
    now=Date.parse('2026-10-12T23:59:59Z');
    preview=await service.preview(scope,{source:'RULE',ruleId:v2Rule.id});await service.execute(scope,preview.id);
    now+=2000;await service.processNext();
    assert.equal(writes.length,beforeCutover,'即使刷新跨截止时刻还标记旧语义，写前仍须停止固定价计划');
    assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'CANCELLED');
    now=Date.parse('2026-10-12T23:59:59Z');
    preview=await service.preview(scope,{source:'RULE',ruleId:v2Rule.id});await service.execute(scope,preview.id);
    const originalQuery=pool.query.bind(pool);let crossedDuringSave=false;
    pool.query=async(...args)=>{
      const result=await originalQuery(...args);
      if(String(args[0]).startsWith('UPDATE ozon_promotion_runs SET status=')&&args[1]?.[4]?.items?.some(x=>x.status==='SUBMITTED')){now+=2000;crossedDuringSave=true;}
      return result;
    };
    try{await service.processNext();}finally{pool.query=originalQuery;}
    assert.equal(crossedDuringSave,true);assert.equal(writes.length,beforeCutover,'保存SUBMITTED跨截止时间也不能发送旧机制写入');
    assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'CANCELLED');
    now=beforeBoundary;remote.priceSemantics='CEILING';
    ozon.activate=async(c,args)=>{
      assert.equal(args.products[0].currency,'CNY','写入边界必须收到明确币种');
      return {...await originalActivate(c,args),deactivatedIds:[],warnings:[{productId:'v2-product',reason:'平台价格提醒'}]};
    };
    preview=await service.preview(scope,{source:'RULE',ruleId:v2Rule.id});await service.execute(scope,preview.id);await service.processNext();
    record=(await service.overview(scope)).records.find(x=>x.id===preview.id);
    assert.equal(record.status,'COMPLETED');assert.deepEqual(record.items[0].warnings,['平台价格提醒']);
    remote.memberships=[];
    ozon.activate=async()=>({acceptedIds:[],deactivatedIds:['v2-product'],rejected:[],warnings:[{productId:'v2-product',reason:'价格不符合活动要求'}]});
    preview=await service.preview(scope,{source:'RULE',ruleId:v2Rule.id});await service.execute(scope,preview.id);await service.processNext();
    record=(await service.overview(scope)).records.find(x=>x.id===preview.id);
    assert.equal(record.status,'FAILED','明确移除是报名失败，不能误报成功或未知');
    assert.match(record.items[0].error,/移除/);assert.deepEqual(record.items[0].warnings,['价格不符合活动要求']);
    remote.memberships=[{actionId:'v2-action',productId:'v2-product',mode:'AUTO',batchAt:'',price:'70.00',currency:'CNY',maxPrice:'75.00',maxPriceCurrency:'CNY',priceSemantics:'CEILING'}];
    let restored=0;
    ozon.updateForExit=async(c,args)=>{
      assert.deepEqual(args,{actionId:'v2-action',products:[{productId:'v2-product',price:'100.00',currency:'CNY'}]});
      restored++;remote.memberships=[];
      return {acceptedIds:['v2-product'],deactivatedIds:['v2-product'],rejected:[],warnings:[]};
    };
    preview=await service.preview(scope,{source:'EXIT'});assert.equal(preview.items[0].previousPrice,'70.00');
    assert.equal(preview.items[0].price,'100.00');assert.equal(preview.items[0].exitByPrice,true);
    await service.execute(scope,preview.id);await service.processNext();await service.processNext();
    assert.equal(restored,1);assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'COMPLETED');
    remote.memberships=[{actionId:'v2-action',productId:'v2-product',mode:'AUTO',batchAt:'',price:'70.00',currency:'CNY',maxPrice:'75.00',maxPriceCurrency:'CNY',priceSemantics:'CEILING'}];
    preview=await service.preview(scope,{source:'EXIT'});await service.execute(scope,preview.id);
    ozon.refreshTargets=async()=>{const fresh=await ozon.snapshot();fresh.products[0].basePrice='105.00';return fresh;};
    await service.processNext();assert.equal(restored,1,'恢复限价变化必须先重新预览，不能静默改价');
    assert.equal((await service.overview(scope)).records.find(x=>x.id===preview.id).status,'CANCELLED');
    ozon.refreshTargets=refreshBeforeRatio;
    ozon.activate=originalActivate;Object.assign(remote,beforeV2);delete remote.priceSemantics;
    // More than 100 newer records must never hide unresolved work.
    remote.memberships.push({actionId:'second',productId:'q',batchAt:'',mode:'AUTO',price:'90.00',quantity:0,currency:'CNY'});
    const unresolved=await service.preview(scope,{source:'EXIT'});
    const unresolvedBody=(await pool.query('SELECT body FROM ozon_promotion_runs WHERE id=$1',[unresolved.id])).rows[0].body;
    unresolvedBody.items.forEach(x=>x.status='UNCERTAIN');await pool.query("UPDATE ozon_promotion_runs SET status='UNCERTAIN',body=$2 WHERE id=$1",[unresolved.id,unresolvedBody]);
    for(let i=1;i<=101;i++)await pool.query("INSERT INTO ozon_promotion_runs(id,account_id,store_id,source,status,body,created_at,updated_at) VALUES($1,'a','s','EXIT','COMPLETED',$2,$3,$3)",[randomUUID(),{items:[],skipped:[]},now+i]);
    assert.ok((await service.overview(scope)).records.some(x=>x.id===unresolved.id),'未决记录必须始终可见以便核对');
    // Read failure preserves the last successful snapshot instead of appearing empty.
    failRead=true;const old=(await service.overview(scope)).products.length;await assert.rejects(service.syncStore(scope));assert.equal((await service.overview(scope)).products.length,old);
    for(const existing of (await service.overview(scope)).rules)await service.deleteRule(scope,existing.id);assert.equal((await service.overview(scope)).rules.length,0);assert.ok((await service.overview(scope)).records.length>0);
  }finally{if(http)await new Promise(resolve=>http.close(resolve));if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
