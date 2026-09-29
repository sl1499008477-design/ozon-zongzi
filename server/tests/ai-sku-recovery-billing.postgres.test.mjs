import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createSkuBilling} from '../ai-sku-billing.mjs';

test('real PostgreSQL reserves only eligible SKUs and charges recovered siblings once', {
  skip:process.env.SONLI_POSTGRES_TESTS!=='1', timeout:30000,
},async()=>{
  const schema='sku_recovery_billing_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query("CREATE TABLE accounts(id TEXT PRIMARY KEY,role TEXT);INSERT INTO accounts VALUES('user-a','user');CREATE TABLE ai_user_channel_requests(id TEXT PRIMARY KEY)");
    for(const migration of ['106_ai_image_listing.sql','115_ai_sku_billing.sql'])await pool.query(await readFile(new URL('../db/migrations/'+migration,import.meta.url),'utf8'));
    const body={name:'mixed eligible, skipped and unknown SKUs',
      config:{salePricing:{useBlackPriceWhenGreenMissing:false}},
      source:{skuPricing:[{sku:'a',status:'SKIPPED',code:'SALE_PRICING_SKU_SKIPPED'},{sku:'b',status:'READY'}]},
      images:[
        {sku:'a',index:0,status:'SKIPPED',generatedUrl:null},
        {sku:'b',index:0,status:'PENDING',generatedUrl:null},
        {sku:'b',index:1,status:'PENDING',generatedUrl:null},
        {sku:'c',index:0,status:'GENERATION_FAILED',generatedUrl:null,lastError:{code:'RETRYABLE_GATEWAY',diagnostic:{deliveryState:'POSSIBLY_SENT'}}},
      ]};
    await pool.query("INSERT INTO ai_image_listing_tasks(id,account_id,dedupe_key,status,body,next_run_at,created_at) VALUES('task','user-a','task','GENERATING',$1::jsonb,0,0)",[JSON.stringify(body)]);
    await pool.query("INSERT INTO ai_user_wallets(account_id,balance_cents,sku_price_cents) VALUES('user-a',20,20)");
    const billing=createSkuBilling({pool});
    const scope={accountId:'user-a',taskId:'task'};
    const wallet=async()=>(await pool.query("SELECT balance_cents::int AS balance,reserved_cents::int AS reserved FROM ai_user_wallets WHERE account_id='user-a'")).rows[0];
    const charges=async()=>(await pool.query("SELECT sku,amount_cents::int AS amount FROM ai_wallet_entries WHERE task_id='task' AND kind='SKU_CHARGE' ORDER BY sku")).rows;
    const save=()=>pool.query("UPDATE ai_image_listing_tasks SET body=$1::jsonb,status='GENERATING' WHERE id='task' AND account_id='user-a'",[JSON.stringify(body)]);
    assert.equal((await billing.reconcile({...scope,reserve:true})).funded,true,'balance covers B even though A is skipped and C has an unknown paid result');
    assert.deepEqual(await wallet(),{balance:20,reserved:20});assert.deepEqual(await charges(),[]);
    await billing.reconcile({...scope,reserve:true});assert.deepEqual(await wallet(),{balance:20,reserved:20});
    body.images[1].generatedUrl='https://fixture.invalid/b-1';await save();await billing.reconcile(scope);
    assert.deepEqual(await charges(),[],'an incomplete B gallery is not charged');
    body.images[2].generatedUrl='https://fixture.invalid/b-2';body.submissionResults=[{sku:'b',stockStatus:'COMPLETED'}];
    await save();await billing.reconcile(scope);await billing.reconcile(scope);
    assert.deepEqual(await wallet(),{balance:0,reserved:0});assert.deepEqual(await charges(),[{sku:'b',amount:-20}]);
    body.config.salePricing.useBlackPriceWhenGreenMissing=true;
    body.source.skuPricing[0]={sku:'a',status:'READY',usedBlackPriceFallback:true};body.images[0].status='PENDING';
    await save();
    assert.equal((await billing.reconcile({...scope,reserve:true})).funded,false,'restored A needs its own reservation');
    assert.deepEqual(await charges(),[{sku:'b',amount:-20}]);
    await pool.query("UPDATE ai_user_wallets SET balance_cents=balance_cents+20 WHERE account_id='user-a'");
    assert.equal((await billing.reconcile({...scope,reserve:true})).funded,true);
    assert.deepEqual(await wallet(),{balance:20,reserved:20});
    body.images[0].generatedUrl='https://fixture.invalid/a';await save();await billing.reconcile(scope);await billing.reconcile({...scope,reserve:true});
    assert.deepEqual(await wallet(),{balance:0,reserved:0});
    assert.deepEqual(await charges(),[{sku:'a',amount:-20},{sku:'b',amount:-20}]);
    assert.equal((await pool.query("SELECT reserved_cents::int AS reserved FROM ai_task_billing WHERE task_id='task'")).rows[0].reserved,0);
  }finally{
    await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
