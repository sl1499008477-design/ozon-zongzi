import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createAiUserChannels} from '../ai-user-channels.mjs';

test('通道报价持久化、历史费用迁移、请求快照与全量币种汇总', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async t=>{
  const schema='channel_cost_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
    await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO accounts(id,username,status) VALUES('admin','admin','active'),('a','A','active'),('b','B','active');
      CREATE TABLE ai_gateway_profiles(id TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,base_url TEXT,api_key_env_name TEXT,text_protocol TEXT,image_protocol TEXT,text_model TEXT,image_model TEXT,config_version INTEGER,enabled BOOLEAN,created_by TEXT)`);
    for(const name of ['108_ai_user_channels.sql','109_unified_user_ai_channels.sql','110_user_channel_capability_checks.sql','111_ai_channel_health.sql','113_ai_channel_delete.sql','114_ai_channel_price_checks.sql']) await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    await pool.query(`ALTER TABLE ai_user_channel_requests ADD COLUMN estimated_cost_cny NUMERIC(18,6);
      INSERT INTO ai_gateway_profiles(id) VALUES('old-profile');
      INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,profile_id,image_protocol)
      VALUES('old','a','admin','Old','https://gateway.example/v1','','image','bill','{}','old-key','old-profile','SUB2API_OPENAI_IMAGES');
      INSERT INTO ai_user_channel_requests(id,account_id,channel_id,task_id,request_key,status,estimated_cost_cny)
      SELECT 'history-'||i,'a','old','history','history-'||i,'SUCCEEDED',0.1 FROM generate_series(1,120) i;
      INSERT INTO ai_user_channel_requests(id,account_id,channel_id,task_id,request_key,status,estimated_cost_cny) VALUES('failed','a','old','history','fail','FAILED',0.1);`);
    await pool.query(await readFile(new URL('../db/migrations/130_ai_channel_pricing.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/134_ai_product_channels.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/151_ai_channel_request_holds.sql',import.meta.url),'utf8'));
    const actor={id:'admin',role:'admin'};
    const service=createAiUserChannels({pool,cipher:{fingerprint:k=>k,encrypt:()=>({fixture:true}),decrypt:()=> 'test-only-key'},getTestSample:async()=>({available:false}),gatewayFactory:()=>({listModels:async()=>({models:[{id:'image'}]})})});
    const config={id:'new',accountId:'a',name:'New',baseUrl:'https://gateway.example/v1',apiKey:'fixture-only-new',imageProtocol:'SUB2API_OPENAI_IMAGES',imageModel:'image',billingAccount:'bill-new',pricing:{mode:'REQUEST',currency:'CNY',requestPrice:'0.2'}};
    const run=(key,usage)=>service.run({accountId:'a',channelId:'new',taskId:'channel-test:'+key,requestKey:key},async()=>({gatewayRequestId:'gw-'+key,usage}));
    const edit=pricing=>service.updateModels(actor,'new',{imageModel:'image',billingAccount:'bill-new',pricing});
    await t.test('迁移保留120条历史估算且不把失败当已知收费',async()=>{
      const data=await service.overview(actor),old=data.channels.find(c=>c.id==='old');
      assert.equal(data.requests.length,100);assert.equal(old.spending.requestCount,121);
      assert.equal(old.spending.totals[0].amount,'12.000000000000');assert.equal(old.spending.unpricedCount,1);
      assert.equal(JSON.stringify(data).includes('old-key'),false);
      await assert.rejects(service.overview({role:'user',id:'a'}),{statusCode:403});
    });
    await t.test('新建及同一意图重试保存价格，修改报价不清除能力结论',async()=>{
      await service.create(actor,config);await service.create(actor,{...config,pricing:{requestPrice:'0.20',currency:'CNY',mode:'REQUEST'}});
      await pool.query(`UPDATE ai_user_channels SET capability_check='{"type":"GRID_SAMPLE_V1","status":"PASSED"}' WHERE id='new'`);
      await run('one');await edit({mode:'REQUEST',currency:'USD',requestPrice:'0.5'});await run('two');
      const row=(await pool.query("SELECT capability_check FROM ai_user_channels WHERE id='new'")).rows[0];assert.equal(row.capability_check.status,'PASSED');
      const snapshots=(await pool.query("SELECT pricing_snapshot FROM ai_user_channel_requests WHERE channel_id='new' ORDER BY created_at")).rows;
      assert.equal(snapshots[0].pricing_snapshot.currency,'CNY');assert.equal(snapshots[1].pricing_snapshot.currency,'USD');
    });
    await t.test('按量计费使用实际返回的输入及补全用量；失败和缺失用量保持待核实',async()=>{
      await edit({mode:'TOKEN',currency:'USD',inputPrice:'1.25',outputPrice:'10'});
      await run('three',{inputTokens:1000000,outputTokens:100000});await run('missing-usage');
      await assert.rejects(service.run({accountId:'a',channelId:'new',taskId:'test',requestKey:'failure'},async()=>{throw Object.assign(new Error('mock'),{code:'AI_GATEWAY_UNEXPECTED_EOF'});}));
      const data=await service.overview(actor),cost=data.channels.find(c=>c.id==='new').spending;
      assert.deepEqual(cost.totals.sort((a,b)=>a.currency.localeCompare(b.currency)),[{currency:'CNY',amount:'0.200000000000',requests:1},{currency:'USD',amount:'2.750000000000',requests:2}]);
      assert.equal(cost.requestCount,5);assert.equal(cost.unpricedCount,2);assert.equal(cost.failedCount,1);
      await assert.rejects(service.run({accountId:'b',channelId:'new',taskId:'test',requestKey:'cross-account'},async()=>{throw new Error('should not call');}),{code:'AI_GATEWAY_NO_CAPACITY'});
      await assert.rejects(service.updateModels({id:'a',role:'user'},'new',{...config}),{statusCode:403});
    });
  } finally {if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
