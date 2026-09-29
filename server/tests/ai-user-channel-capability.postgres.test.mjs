import './support/dedicated-postgres-test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {createAiUserChannels} from '../ai-user-channels.mjs';
import {createAiListingGridPort} from '../ai-listing-runtime.mjs';

test('固定样本能力测试复用正式拼图、只检查几何并保存人工结论', {skip:process.env.SONLI_POSTGRES_TESTS!=='1'}, async t=>{
  const schema='channel_sample_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
    await pool.query(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO accounts(id,username,status) VALUES('admin','admin','active'),('a','user-a','active'),('b','user-b','active');
      CREATE TABLE ai_gateway_profiles(id TEXT PRIMARY KEY,account_id TEXT,display_name TEXT,base_url TEXT,api_key_env_name TEXT,text_protocol TEXT,image_protocol TEXT,text_model TEXT,image_model TEXT,config_version INTEGER,enabled BOOLEAN,created_by TEXT)`);
    for(const name of ['108_ai_user_channels.sql','109_unified_user_ai_channels.sql','110_user_channel_capability_checks.sql','111_ai_channel_health.sql','113_ai_channel_delete.sql','114_ai_channel_price_checks.sql']) {
      await pool.query(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    }
    await pool.query('ALTER TABLE ai_user_channel_requests ADD COLUMN estimated_cost_cny NUMERIC(18,6)');
    await pool.query(await readFile(new URL('../db/migrations/130_ai_channel_pricing.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/134_ai_product_channels.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/151_ai_channel_request_holds.sql',import.meta.url),'utf8'));
    await pool.query(`INSERT INTO ai_gateway_profiles(id) VALUES('profile-a'),('profile-b');
      INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,profile_id,image_protocol)
      VALUES('channel-a','a','admin','A','https://gateway.example/v1','','image-a','billing-a','{}','key-a','profile-a','SUB2API_OPENAI_IMAGES'),
      ('channel-b','b','admin','B','https://gateway.example/v1','text-b','image-b','billing-b','{}','key-b','profile-b','SUB2API_RESPONSES_IMAGE_TOOL')`);
    const sources=await Promise.all(['#fa1111','#11fa11','#1111fa','#fafa11','#11fafa','#fafafa'].map(background=>sharp({create:{width:30,height:40,channels:3,background}}).png().toBuffer()));
    const descriptor={available:true,sample:{version:'fixture-six-v1',name:'固定六图',referenceNotes:['保留商品文字'],images:sources.map((_,index)=>({index,label:'图'+(index+1),url:'/fixture/'+index,width:30,height:40}))},prompt:{version:'formal-fixture-v1',text:'preserve product'},image:{ratio:'3:4',language:'ru',quality:'high'},expected:{count:6,width:768,height:1024}};
    let generated=0,invalidGeometry=false,wrongCount=false,wrongDimensions=false,paused=null,entered=null;
    const stored=new Map(),requests=[],actor={id:'admin',role:'admin'};
    let service;
    service=createAiUserChannels({pool,cipher:{decrypt:()=> 'fixture-only-key'},getTestSample:async()=>descriptor,
      gatewayFactory:()=>({generateImage:async request=>{
        generated++;requests.push(request);
        if(entered)entered();if(paused)await paused;
        return {bytes:invalidGeometry?sources[0]:request.sourceImages[0].bytes,contentType:'image/png',requestId:'gateway-'+generated};
      },createTextResponse:()=>{throw new Error('固定拼图测试不应增加独立文字请求');}}),
      generateTestGrid:async(input,onProgress)=>{
        const result=await createAiListingGridPort({downloadImage:async url=>({buffer:sources[Number(url.split('/').at(-1))]}),recognizeText:async buffers=>buffers.map(()=> 'SOURCE FACT'),
          runChannel:(input,generate)=>service.run(input,generate),onProgress,
          putObject:async object=>stored.set(object.key,object.buffer),publication:{prefix:'media',baseUrl:'https://media.example/'}})(input);
        if(wrongCount)result.images.pop();
        if(wrongDimensions)result.images[0].width=700;
        return result;
      }});

    await t.test('后台测试先持久化排队，同意图重放和并发领取只生图一次',async()=>{
      await assert.rejects(service.queueCapability({id:'a',role:'user'},'channel-a',{confirmed:true,id:'queue-denied'}),{statusCode:403});
      await assert.rejects(service.queueCapability(actor,'channel-a',{id:'queue-unconfirmed'}),{statusCode:400});
      const owner=await service.reserveProduct({accountId:'a',taskId:'active-product'});
      const queued=await service.queueCapability(actor,'channel-a',{confirmed:true,id:'queued-once'});
      assert.equal(queued.status,'QUEUED');assert.equal(generated,0);
      assert.equal((await service.queueCapability(actor,'channel-a',{confirmed:true,id:'queued-once'})).status,'QUEUED');
      await assert.rejects(service.queueCapability(actor,'channel-a',{confirmed:true,id:'queue-conflict'}),{statusCode:409});
      await service.processNextCapability();assert.equal(generated,0);
      await owner.release();
      await assert.rejects(service.reserveProduct({accountId:'a',taskId:'cannot-overtake-test'}),{code:'AI_GATEWAY_NO_CAPACITY'});
      await Promise.all([service.processNextCapability(),service.processNextCapability()]);
      assert.equal(generated,1);
      assert.equal((await service.queueCapability(actor,'channel-a',{confirmed:true,id:'queued-once'})).status,'PENDING_REVIEW');
      await service.processNextCapability();assert.equal(generated,1);
      await pool.query('DELETE FROM ai_user_channel_requests');
      await pool.query('UPDATE ai_user_channels SET capability_check=NULL');
      generated=0;requests.length=0;
    });
    await t.test('排队后停用通道会结束测试，不发送付费请求',async()=>{
      await service.queueCapability(actor,'channel-a',{confirmed:true,id:'queue-disabled'});
      await service.setEnabled(actor,'channel-a',false);
      await service.processNextCapability();
      assert.equal((await pool.query("SELECT capability_check FROM ai_user_channels WHERE id='channel-a'")).rows[0].capability_check.status,'FAILED');
      assert.equal(generated,0);await service.setEnabled(actor,'channel-a',true);
    });
    await t.test('worker pre-send sample failure ends queued intent and releases the channel',async()=>{
      await service.queueCapability(actor,'channel-a',{confirmed:true,id:'sample-missing'});
      const unavailable=createAiUserChannels({pool,getTestSample:async()=>({available:false,reason:'fixture OCR unavailable'}),generateTestGrid:()=>assert.fail('must not send')});
      await unavailable.processNextCapability();
      const check=(await pool.query("SELECT capability_check FROM ai_user_channels WHERE id='channel-a'")).rows[0].capability_check;
      assert.equal(check.status,'FAILED');assert.equal(check.deliveryState,'NOT_SENT');assert.equal(generated,0);
      const next=await service.reserveProduct({accountId:'a',taskId:'after-sample-failure'});await next.release();
    });
    let first;
    await t.test('普通用户及未确认费用均不能生成；自动通过保留为待人工确认',async()=>{
      await assert.rejects(service.testCapability({id:'a',role:'user'},'channel-a',{confirmed:true,id:'denied'}),{statusCode:403});
      await assert.rejects(service.testCapability(actor,'channel-a',{id:'unconfirmed'}),{statusCode:400});
      assert.equal(generated,0);
      first=await service.testCapability(actor,'channel-a',{confirmed:true,id:'first'});
      assert.equal(first.status,'PENDING_REVIEW');
      assert.equal(first.automatic.actualCount,6);assert.equal(first.images.length,6);
      assert.equal(first.review,undefined);assert.equal(generated,1);
      assert.equal(requests[0].sourceImages.length,1);assert.equal(requests[0].size,'2432x2144');assert.equal(requests[0].quality,'high');
      assert.match(requests[0].prompt,/SOURCE FACT/);assert.match(requests[0].prompt,/preserve product/);
      for(const image of first.images){const meta=await sharp(stored.get(image.objectKey)).metadata();assert.equal(image.width,768);assert.equal(image.height,1024);assert.equal(meta.width,768);assert.equal(meta.height,1024);}
      const persisted=(await pool.query("SELECT capability_check FROM ai_user_channels WHERE id='channel-a'")).rows[0].capability_check;
      assert.equal(persisted.status,'PENDING_REVIEW');assert.equal(persisted.sample.version,'fixture-six-v1');
      assert.equal((await pool.query("SELECT count(*)::int n FROM ai_user_channel_requests WHERE account_id='b'")).rows[0].n,0);
    });
    await t.test('重复测试意图不重复收费，人工两项明确通过才算通过',async()=>{
      await service.testCapability(actor,'channel-a',{confirmed:true,id:'first'});assert.equal(generated,1);
      await assert.rejects(service.reviewCapability({id:'a',role:'user'},'channel-a',{id:'first',productCorrect:true,textCorrect:true}),{statusCode:403});
      await assert.rejects(service.reviewCapability(actor,'channel-a',{id:'first',productCorrect:true}),{statusCode:400});
      await assert.rejects(service.reviewCapability(actor,'channel-b',{id:'first',productCorrect:true,textCorrect:true}),{statusCode:409});
      const rejected=await service.reviewCapability(actor,'channel-a',{id:'first',productCorrect:false,textCorrect:true,notes:'结构有变形'});
      assert.equal(rejected.status,'REVIEW_FAILED');assert.equal(rejected.review.productCorrect,false);
      const approved=await service.reviewCapability(actor,'channel-a',{id:'first',productCorrect:true,textCorrect:true,notes:'逐图确认'});
      assert.equal(approved.status,'PASSED');assert.equal(approved.review.reviewedBy,'admin');assert.equal(generated,1);
    });
    await t.test('文字模型工具通道使用同一六图与正式流程，不额外执行文字探针',async()=>{
      const second=await service.testCapability(actor,'channel-b',{confirmed:true,id:'second'});
      assert.equal(second.status,'PENDING_REVIEW');assert.equal(generated,2);
      assert.equal(requests[1].profile.imageProtocol,'SUB2API_RESPONSES_IMAGE_TOOL');assert.equal(requests[1].profile.textModel,'text-b');
      assert.equal(requests[1].prompt,requests[0].prompt);assert.ok(requests[1].sourceImages[0].bytes.equals(requests[0].sourceImages[0].bytes));
    });
    await t.test('分隔带损坏不会展示正确切片或允许人工通过，且不会惩罚通道',async()=>{
      invalidGeometry=true;
      const result=await service.testCapability(actor,'channel-a',{confirmed:true,id:'bad-grid'});
      assert.equal(result.status,'FAILED');assert.equal(result.errorCode,'AI_LISTING_GRID_GEOMETRY_INVALID');
      assert.equal(result.images.length,0);assert.equal(result.automatic.status,'FAILED');
      assert.equal((await pool.query("SELECT failure_count FROM ai_user_channels WHERE id='channel-a'")).rows[0].failure_count,0);
      await assert.rejects(service.reviewCapability(actor,'channel-a',{id:'bad-grid',productCorrect:true,textCorrect:true}),{statusCode:409});
      invalidGeometry=false;
    });
    await t.test('切片数量及尺寸分别验证，不能只用解码成功当作通过',async()=>{
      wrongCount=true;let result=await service.testCapability(actor,'channel-a',{confirmed:true,id:'bad-count'});
      assert.equal(result.status,'FAILED');assert.equal(result.automatic.actualCount,5);
      wrongCount=false;wrongDimensions=true;result=await service.testCapability(actor,'channel-a',{confirmed:true,id:'bad-size'});
      assert.equal(result.status,'FAILED');assert.equal(result.errorCode,'CHANNEL_TEST_SLICE_INVALID');wrongDimensions=false;
    });
    await t.test('刷新可以恢复阶段，并发测试及旧人工确认不能覆盖新测试',async()=>{
      let release;paused=new Promise(resolve=>{release=resolve;});const reached=new Promise(resolve=>{entered=resolve;});
      const running=service.testCapability(actor,'channel-a',{confirmed:true,id:'parallel'});await reached;
      try{
        const overview=await service.overview(actor);const channel=overview.channels.find(c=>c.id==='channel-a');
        assert.equal(channel.capability_check.status,'RUNNING');assert.equal(channel.active_test.stage,'image');
        assert.equal(overview.testSample.sample.version,'fixture-six-v1');
        await assert.rejects(service.testCapability(actor,'channel-a',{confirmed:true,id:'other-intent'}),{statusCode:409});
        await assert.rejects(service.reviewCapability(actor,'channel-a',{id:'first',productCorrect:true,textCorrect:true}),{statusCode:409});
      }finally{release();paused=null;entered=null;await running;}
      assert.equal((await running).status,'PENDING_REVIEW');
    });
  } finally {await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
