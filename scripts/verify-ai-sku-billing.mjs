import {createAiListingService} from '../server/ai-listing-service.mjs';
import {createAiListingRepository} from '../server/ai-listing-repository.mjs';
import '../server/env.mjs';import {Pool} from 'pg';import {postgresConfig} from '../server/db/connection.mjs';import {createSkuBilling} from '../server/ai-sku-billing.mjs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const schema='billing_test_'+randomUUID().replaceAll('-','');const root=new Pool(postgresConfig());let pool;
try{
 await root.query(`CREATE SCHEMA ${schema}`);for(const t of ['accounts','ai_image_listing_tasks','ai_user_wallets','ai_task_billing','ai_wallet_entries','ai_user_channel_requests','ai_billing_changes'])await root.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING INDEXES)`);
 pool=new Pool({...postgresConfig(),options:`-c search_path=${schema},public`});
 await pool.query("INSERT INTO accounts(id,username,role,status) VALUES('u','test-wallet','user','active'),('v','test-other','user','active')");
 const billing=createSkuBilling({pool}),admin={id:'admin',role:'admin'};
 await billing.configure(admin,{accountId:'u',action:'price',amount:'2.00'});
 await billing.configure(admin,{accountId:'u',action:'topup',amount:'6',idempotencyKey:'one'});await billing.configure(admin,{accountId:'u',action:'topup',amount:'6',idempotencyKey:'one'});
 const images=[{sku:'a',generatedUrl:null},{sku:'a',generatedUrl:null},{sku:'b',generatedUrl:null}];
 for(const id of ['one','two'])await pool.query("INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at) VALUES($1,'u',$1,'GENERATING',$2,0,0)",[id,{images}]);
 const outcomes=await Promise.all(['one','two'].map(taskId=>billing.reconcile({accountId:'u',taskId,reserve:true})));
 assert.equal(outcomes.filter(x=>x.funded).length,1,'only one task may reserve four of six yuan');
 const funded=outcomes[0].funded?'one':'two';const waiting=funded==='one'?'two':'one';
 await pool.query("UPDATE ai_image_listing_tasks SET body=$2 WHERE id=$1",[funded,{images:[{sku:'a',generatedUrl:'https://x/1'},{sku:'a',generatedUrl:null},{sku:'b',generatedUrl:null}]}]);await billing.reconcile({accountId:'u',taskId:funded});assert.equal((await pool.query("SELECT COUNT(*)::int n FROM ai_wallet_entries WHERE kind='SKU_CHARGE'")).rows[0].n,0);
 await pool.query("UPDATE ai_image_listing_tasks SET body=$2,status='GENERATION_FAILED' WHERE id=$1",[funded,{images:[{sku:'a',generatedUrl:'https://x/1'},{sku:'a',generatedUrl:'https://x/2'},{sku:'b',generatedUrl:null}]}]);
 await billing.reconcile({accountId:'u',taskId:funded});await billing.reconcile({accountId:'u',taskId:funded});
 let wallet=(await pool.query("SELECT * FROM ai_user_wallets WHERE account_id='u'")).rows[0];assert.equal(Number(wallet.balance_cents),400);assert.equal(Number(wallet.reserved_cents),0);
 await billing.configure(admin,{accountId:'u',action:'price',amount:'3'});
 await pool.query("UPDATE ai_image_listing_tasks SET status='GENERATING' WHERE id=$1",[funded]);await billing.reconcile({accountId:'u',taskId:funded,reserve:true});
 await pool.query("UPDATE ai_image_listing_tasks SET body=$2 WHERE id=$1",[funded,{images:[{sku:'a',generatedUrl:'https://x/1'},{sku:'a',generatedUrl:'https://x/2'},{sku:'b',generatedUrl:'https://x/3'}]}]);await billing.recover();
 wallet=(await pool.query("SELECT * FROM ai_user_wallets WHERE account_id='u'")).rows[0];assert.equal(Number(wallet.balance_cents),200);assert.equal(Number(wallet.reserved_cents),0);
 assert.equal((await pool.query("SELECT COUNT(*)::int n FROM ai_wallet_entries WHERE kind='SKU_CHARGE'")).rows[0].n,2);
 await assert.rejects(billing.configure({id:'u',role:'user'},{accountId:'u',action:'topup',amount:'100',idempotencyKey:'hack'}),{statusCode:403});
 const own=await billing.snapshot({id:'u',role:'user'});assert.equal(own.wallets.length,1);assert.ok(!('costs' in own));assert.ok(!('costTotal' in own));assert.ok(own.entries.every(e=>e.account_id==='u'));
 const other=await billing.snapshot({id:'v',role:'user'});assert.equal(other.entries.length,0);
 await pool.query("UPDATE ai_image_listing_tasks SET status='CANCELLED'");await billing.recover();
 await billing.configure(admin,{accountId:'u',action:'topup',amount:'10',idempotencyKey:'journey'});
 const service=createAiListingService({repository:createAiListingRepository({pool}),billing,
  loadSources:async()=>[{collectItemId:'col',name:'Test product',items:[{sku:'x',images:['https://example.test/1','https://example.test/2']},{sku:'y',images:['https://example.test/3']}]}],
  generateImageGroup:async input=>({images:input.sources.map(x=>({sku:input.sku,index:x.index,generatedUrl:`https://example.test/result/${input.sku}/${x.index}`}))})});
 const [task]=await service.createFromCollect({accountId:'u',idempotencyKey:'journey',collectItemIds:['col'],config:{targetStoreId:'store',targetWarehouseId:'warehouse',generationMode:'GRID',manualReview:true}});
 await service.processNext();const done=await service.getTask({accountId:'u',taskId:task.id});assert.equal(done.status,'AWAITING_REVIEW');
 assert.equal((await pool.query("SELECT SUM(-amount_cents)::int n FROM ai_wallet_entries WHERE task_id=$1",[task.id])).rows[0].n,600);
 await billing.recover();assert.equal((await pool.query("SELECT balance_cents::int n FROM ai_user_wallets WHERE account_id='u'")).rows[0].n,600);
 console.log('PASS: exact topup/idempotency, concurrent reservation, partial SKU not charged, failed SKU released, successful SKU charged once, frozen rate after retry, recovery, admin-only configuration/costs, account isolation. No real money changed.');
}finally{if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end()}
