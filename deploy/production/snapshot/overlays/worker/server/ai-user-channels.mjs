import {defaultAiRuntimeSettings} from './ai-runtime-settings.mjs';
import {isDeepStrictEqual} from "node:util";
import { randomUUID } from "node:crypto";
import { loadAutoListingCredentialKey } from "./auto-listing-ai-credential-config.mjs";
import { createAutoListingCredentialCipher } from "./auto-listing-ai-credential-crypto.mjs";
import { createSub2ApiAdapter } from "./sub2api-ai-adapter.mjs";
import {normalizeChannelPricing, estimateChannelCost, sampleChannelPricing} from './ai-channel-pricing.mjs';
import {readAiChannelTestSample} from './ai-channel-test-sample.mjs';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: "AI_LISTING_CHANNEL_UNAVAILABLE" });
const safeColumns = "id,account_id,name,base_url,text_model,image_model,billing_account,enabled,last_used_at,created_at,image_protocol,connection_check,capability_check,failure_count,needs_attention,last_error_code,cooldown_until,pricing";
const direct = row => row.image_protocol === "SUB2API_OPENAI_IMAGES";
function text(value, limit = 200) { if (typeof value !== "string" || !value.trim() || value.length > limit) throw fail("请完整填写通道配置"); return value.trim(); }
const queuedTest = check => check?.type==='GRID_SAMPLE_V1'&&check.status==='QUEUED';
const runningTest = check => check?.type==='GRID_SAMPLE_V1'&&check.status==='RUNNING'&&Date.parse(check.updatedAt||check.startedAt)>Date.now()-20*60_000;
function visibleTest(check) {
  return check?.type==='GRID_SAMPLE_V1'&&check.status==='RUNNING'&&!runningTest(check)
    ? {...check,status:'FAILED',errorCode:'CHANNEL_TEST_INTERRUPTED',message:'上次测试未完成，结果待确认；重新测试可能再次产生费用。'} : check;
}
export function createAiUserChannels({ pool, env = process.env, cipher: injectedCipher, gatewayFactory = createSub2ApiAdapter,
  getTestSample = readAiChannelTestSample, generateTestGrid, productLeaseMs = 15*60_000,
  productHeartbeatMs = 60_000, requestRetryMs = 1000, requestWaitMs = Infinity, getRuntimeSettings = () => defaultAiRuntimeSettings(env) }) {
  let cipherPromise;
  const cipher = () => injectedCipher || (cipherPromise ||= loadAutoListingCredentialKey({ env }).then(key => createAutoListingCredentialCipher({ key, keyVersion: env.AUTO_LISTING_CREDENTIAL_KEY_VERSION })));
  const scope = row => ({ accountId: row.account_id, connectionId: row.id, connectionVersion: 1 });
  function gateway(row, key) {
    const profile = { id: row.id, accountId: row.account_id, configVersion: 1, baseUrl: row.base_url,
      apiKeyEnvName: "USER_AI_CHANNEL_KEY", enabled: true, textProtocol: "SUB2API_RESPONSES",
      imageProtocol: row.image_protocol || "SUB2API_RESPONSES_IMAGE_TOOL", textModel: row.text_model, imageModel: row.image_model };
    return { profile, gateway: gatewayFactory({ readSecret: () => key,
      resolveSecret: async request => {
        if (request.accountId !== row.account_id || request.connectionId !== row.id || request.connectionVersion !== 1) throw fail("通道凭据范围不匹配",403);
        return key;
      },
      allowedSecretEnvNames: ["USER_AI_CHANNEL_KEY"], allowedGatewayBaseUrls: [row.base_url],
      allowLocalGateway: ["1","true"].includes(String(env.AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY).toLowerCase()) && env.NODE_ENV !== "production" }) };
  }
  const noCapacity = () => Object.assign(fail("没有符合本任务要求的可用用户通道，请检查分配、模型和通道状态",409),{code:"AI_GATEWAY_NO_CAPACITY"});
  const productLost = () => Object.assign(fail("商品通道占用已失效，请重新领取任务后重试",409),{code:"AI_LISTING_PRODUCT_LEASE_LOST"});
  const assertProduct = async (db,input) => {
    if (!input.channelId || !input.taskId) throw productLost();
    const row=(await db.query(`SELECT * FROM ai_user_channels WHERE id=$1 AND account_id=$2
      AND product_task_id=$3 AND product_token=$4 AND product_lease_until>NOW()`,
      [input.channelId,input.accountId,input.taskId,input.productToken])).rows[0];
    if (!row) throw productLost();
    return row;
  };
  return {
    async reserveProduct({accountId,taskId,capacity,excludeChannelIds=[]}) {
      const productToken=randomUUID();let row;
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-user-channel-allocation'))");
        await client.query(`UPDATE ai_user_channels SET product_task_id=NULL,product_token=NULL,product_lease_until=NULL
          WHERE product_lease_until<=NOW()`);
        if((await client.query('SELECT 1 FROM ai_user_channels WHERE account_id=$1 AND product_task_id=$2',[accountId,taskId])).rows.length)
          throw Object.assign(fail('该商品已由其他执行器占用，请等待当前处理完成',409),{code:'AI_LISTING_PRODUCT_ALREADY_RESERVED'});
        const maximum=getRuntimeSettings().productConcurrency;
        const limit=Number.isInteger(capacity)&&capacity>=0?Math.min(capacity,maximum):maximum;
        row=(await client.query(`WITH chosen AS (
          SELECT id FROM ai_user_channels WHERE account_id=$1 AND enabled=TRUE AND deleted_at IS NULL
            AND COALESCE(connection_check->>'status','AVAILABLE') NOT IN ('MODEL_MISSING','UNAVAILABLE')
            AND needs_attention=FALSE AND (cooldown_until IS NULL OR cooldown_until<NOW())
            AND COALESCE(capability_check->>'status','')<>'QUEUED'
            AND (capability_check->>'status' IS DISTINCT FROM 'RUNNING' OR COALESCE(capability_check->>'updatedAt',capability_check->>'startedAt')::timestamptz<NOW()-INTERVAL '20 minutes')
            AND product_token IS NULL AND (lease_until IS NULL OR lease_until<NOW()) AND NOT(id=ANY($5::text[]))
            AND (SELECT count(*) FROM ai_user_channels WHERE product_lease_until>NOW())<$4
          ORDER BY failure_count ASC,last_used_at ASC NULLS FIRST,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE ai_user_channels c SET product_task_id=$2,product_token=$3,
          product_lease_until=NOW()+$6*INTERVAL '1 millisecond',last_used_at=NOW()
          FROM chosen WHERE c.id=chosen.id RETURNING c.id`,[accountId,taskId,productToken,limit,excludeChannelIds,productLeaseMs])).rows[0];
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
      if(!row)throw noCapacity();
      let released=false;
      const heartbeat=setInterval(()=>{void pool.query(`UPDATE ai_user_channels SET product_lease_until=NOW()+$4*INTERVAL '1 millisecond'
        WHERE id=$1 AND account_id=$2 AND product_token=$3 AND product_lease_until>NOW()`,[row.id,accountId,productToken,productLeaseMs]).catch(()=>{});},productHeartbeatMs);
      heartbeat.unref?.();
      return {channelId:row.id,productToken,release:async()=>{
        if(released)return;
        clearInterval(heartbeat);
        await pool.query('UPDATE ai_user_channels SET product_task_id=NULL,product_token=NULL,product_lease_until=NULL WHERE id=$1 AND account_id=$2 AND product_token=$3',[row.id,accountId,productToken]);
        released=true;
      }};
    },
    async workingStatus(accountId) {
      const result = await pool.query(`SELECT c.id,c.name,c.enabled,c.lease_until,c.product_lease_until,c.cooldown_until,c.connection_check,c.capability_check,c.failure_count,c.needs_attention,c.last_error_code,
        r.status AS request_status,r.error_code
        FROM ai_user_channels c LEFT JOIN LATERAL (
          SELECT status,error_code FROM ai_user_channel_requests WHERE account_id=$1 AND channel_id=c.id ORDER BY created_at DESC LIMIT 1
        ) r ON TRUE WHERE c.account_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`,[accountId]);
      const now=Date.now();
      const channels=result.rows.map(row=>{
        const state=!row.enabled?"disabled":(Date.parse(row.lease_until)>now||Date.parse(row.product_lease_until)>now||queuedTest(row.capability_check)||runningTest(row.capability_check))?"working":Date.parse(row.cooldown_until)>now?"cooling":row.needs_attention?"attention":
          ["MODEL_MISSING","UNAVAILABLE"].includes(row.connection_check?.status)||row.request_status==="FAILED"||(!row.request_status&&row.capability_check?.status==="FAILED")?"abnormal":"idle";
        return {id:row.id,name:row.name,state,failureCount:row.failure_count||0,cooldownUntil:state==="cooling"?row.cooldown_until:null,
          errorCode:["cooling","abnormal","attention"].includes(state)?row.last_error_code||row.error_code||row.connection_check?.code||row.capability_check?.errorCode||null:null};
      });
      const counts={total:channels.length,working:0,cooling:0,abnormal:0,idle:0,disabled:0,attention:0};
      for(const channel of channels)counts[channel.state]++;
      return {counts,channels};
    },
    async overview(actor) {
      if (actor?.role !== "admin") throw fail("仅管理员可管理用户通道", 403);
      const [users, channels, requests, activeTests, priceChecks, testSample, prices, costs] = await Promise.all([
        pool.query("SELECT id,username,status FROM accounts ORDER BY created_at DESC"),
        pool.query(`SELECT ${safeColumns} FROM ai_user_channels WHERE deleted_at IS NULL ORDER BY created_at DESC`),
        pool.query("SELECT r.id,r.account_id,r.channel_id,c.name AS channel_name,r.task_id,r.status,r.error_code,r.gateway_request_id,r.created_at FROM ai_user_channel_requests r JOIN ai_user_channels c ON c.id=r.channel_id ORDER BY r.created_at DESC LIMIT 100"),
        pool.query("SELECT DISTINCT ON (r.channel_id) r.channel_id,CASE WHEN r.request_key LIKE '%:image' THEN 'image' ELSE 'text' END AS stage,r.created_at FROM ai_user_channel_requests r JOIN ai_user_channels c ON c.id=r.channel_id AND c.account_id=r.account_id WHERE r.status='STARTED' AND r.task_id LIKE 'channel-test:%' AND c.lease_until>NOW() ORDER BY r.channel_id,r.created_at DESC"),
        pool.query("SELECT p.day,p.report,p.channel_id,c.name AS channel_name,c.account_id FROM ai_channel_price_checks p JOIN ai_user_channels c ON c.id=p.channel_id AND c.account_id=p.account_id WHERE c.deleted_at IS NULL ORDER BY p.day DESC,p.updated_at DESC LIMIT 90"),
        getTestSample().catch(()=>({available:false,reason:'内置测试样本暂不可用，请检查服务资源。'})),
        pool.query(`SELECT DISTINCT ON (p.channel_id) p.channel_id,p.report FROM ai_channel_price_checks p
          JOIN ai_user_channels c ON c.id=p.channel_id AND c.account_id=p.account_id
          WHERE c.deleted_at IS NULL AND p.report->>'model'=c.image_model AND p.report->>'status'='VERIFIED'
          ORDER BY p.channel_id,p.day DESC`),
        pool.query(`SELECT r.channel_id,r.cost_currency AS currency,SUM(r.estimated_cost)::text AS amount,
          COUNT(*)::int AS requests,COUNT(r.estimated_cost)::int AS priced,
          COUNT(*) FILTER (WHERE r.status='STARTED')::int AS pending,
          COUNT(*) FILTER (WHERE r.status='FAILED')::int AS failed
          FROM ai_user_channel_requests r JOIN ai_user_channels c ON c.id=r.channel_id AND c.account_id=r.account_id
          WHERE c.deleted_at IS NULL GROUP BY r.channel_id,r.cost_currency`),
      ]);
      const progress=new Map(activeTests.rows.map(r=>[r.channel_id,{stage:r.stage,startedAt:r.created_at}]));
      const samples=new Map(prices.rows.map(r=>[r.channel_id,sampleChannelPricing(r.report)]));
      const spending=new Map();
      for(const row of costs.rows) {
        const cost=spending.get(row.channel_id)||{totals:[],requestCount:0,unpricedCount:0,pendingCount:0,failedCount:0};
        cost.requestCount+=row.requests;cost.unpricedCount+=row.requests-row.priced-row.pending;
        cost.pendingCount+=row.pending;cost.failedCount+=row.failed;
        if(row.priced)cost.totals.push({currency:row.currency,amount:row.amount,requests:row.priced});
        spending.set(row.channel_id,cost);
      }
      return { users: users.rows, channels: channels.rows.map(c=>({...c,
        effective_pricing:c.pricing?{...c.pricing,source:'CONFIGURED'}:samples.get(c.id)||null,
        spending:spending.get(c.id)||{totals:[],requestCount:0,unpricedCount:0,pendingCount:0,failedCount:0},capability_check:visibleTest(c.capability_check),
        active_test:(queuedTest(c.capability_check)||runningTest(c.capability_check))?{stage:c.capability_check.stage,startedAt:c.capability_check.startedAt}:progress.get(c.id)||null})),
        requests: requests.rows, priceChecks: priceChecks.rows, testSample };
    },
    async create(actor, input) {
      if (actor?.role !== "admin") throw fail("仅管理员可管理用户通道", 403);
      const imageProtocol = input.imageProtocol || "SUB2API_RESPONSES_IMAGE_TOOL";
      if (!["SUB2API_RESPONSES_IMAGE_TOOL","SUB2API_OPENAI_IMAGES"].includes(imageProtocol)) throw fail("无效的图片调用方式");
      const row = { image_protocol: imageProtocol, id: text(input.id), account_id: text(input.accountId), name: text(input.name),
        base_url: text(input.baseUrl, 1000).replace(/\/$/, ""), text_model: imageProtocol === "SUB2API_OPENAI_IMAGES" ? "" : text(input.textModel),
        image_model: text(input.imageModel), billing_account: text(input.billingAccount) };
      const pricing=normalizeChannelPricing(input.pricing);
      const key = text(input.apiKey, 4096);
      const owner = await pool.query("SELECT id FROM accounts WHERE id=$1", [row.account_id]);
      if (!owner.rows.length) throw fail("用户不存在", 404);
      const c = await cipher(); const fingerprint = c.fingerprint(key);
      const existing = await pool.query("SELECT id,account_id,key_fingerprint,image_protocol,name,base_url,text_model,image_model,billing_account,pricing FROM ai_user_channels WHERE id=$1", [row.id]);
      if (existing.rows.length) {
        if (existing.rows[0].key_fingerprint !== fingerprint || Object.keys(row).some(field => existing.rows[0][field] !== row[field]) || !isDeepStrictEqual(existing.rows[0].pricing,pricing)) throw fail("保存标识冲突，请刷新后重试", 409);
        return { id: row.id };
      }
      const port = gateway(row, key);
      const catalog = await port.gateway.listModels({ connection: { id: row.id, accountId: row.account_id, version: 1, baseUrl: row.base_url, status: "ACTIVE" }, correlationId: row.id, requestKey: row.id });
      const models = new Set(catalog.models.map(model => model.id));
      if ((!direct(row) && !models.has(row.text_model)) || !models.has(row.image_model)) throw fail("通道不支持所选模型，请检查网关模型配置");
      try {
        await pool.query(`WITH channel AS (INSERT INTO ai_user_channels(id,account_id,created_by,name,base_url,text_model,image_model,billing_account,credential,key_fingerprint,profile_id,image_protocol,pricing)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'user-channel-'||$1,$11,$12::jsonb) RETURNING *)
          INSERT INTO ai_gateway_profiles(id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version,enabled,created_by)
          SELECT 'user-channel-'||id,account_id,name,base_url,'USER_AI_CHANNEL_KEY','SUB2API_RESPONSES',image_protocol,text_model,image_model,1,FALSE,created_by FROM channel`, [row.id,row.account_id,actor.id,row.name,row.base_url,row.text_model,row.image_model,row.billing_account,JSON.stringify(c.encrypt(scope(row),key)),fingerprint,row.image_protocol,JSON.stringify(pricing)]);
      } catch (error) { if (error.code === "23505") throw fail("此 Key 已分配给通道，请使用独立 Key",409); throw error; }
      return { id: row.id };
    },
    async check(actor, id) {
      if (actor?.role !== "admin") throw fail("仅管理员可管理用户通道",403);
      const row=(await pool.query("SELECT * FROM ai_user_channels WHERE id=$1 AND deleted_at IS NULL",[id])).rows[0];
      if (!row) throw fail("通道不存在",404);
      let result;
      try {
        const c=await cipher();const port=gateway(row,c.decrypt(scope(row),row.credential));
        const catalog=await port.gateway.listModels({connection:{id:row.id,accountId:row.account_id,version:1,baseUrl:row.base_url,status:"ACTIVE"},correlationId:row.id,requestKey:randomUUID()});
        const models=catalog.models.map(m=>m.id);
        result={status:(direct(row)||models.includes(row.text_model))&&models.includes(row.image_model)?"AVAILABLE":"MODEL_MISSING",models,checkedAt:new Date().toISOString()};
      } catch(error) {result={status:"UNAVAILABLE",code:/^[A-Z][A-Z0-9_]{0,100}$/.test(error.code||"")?error.code:"CHANNEL_CHECK_FAILED",checkedAt:new Date().toISOString()};}
      await pool.query("UPDATE ai_user_channels SET connection_check=$2::jsonb WHERE id=$1 AND profile_id=$3",[id,JSON.stringify(result),row.profile_id]);
      return result;
    },
    async queueCapability(actor,id,input) {
      if(actor?.role!=='admin')throw fail('仅管理员可测试通道',403);
      if(input.confirmed!==true)throw fail('请确认能力测试可能产生费用');
      const intent=text(input.id,100);
      const row=(await pool.query('SELECT * FROM ai_user_channels WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
      if(!row)throw fail('通道不存在',404);
      if(row.capability_check?.type==='GRID_SAMPLE_V1'&&row.capability_check.id===intent)return visibleTest(row.capability_check);
      if(queuedTest(row.capability_check)||runningTest(row.capability_check))throw fail('该通道正在排队或测试，请等待完成',409);
      if(!row.enabled)throw fail('请先启用通道',409);
      const descriptor=await getTestSample();
      if(!descriptor.available||!generateTestGrid)throw fail(descriptor.reason||'智能拼图测试尚不可用',422);
      const requestKey=`channel-capability:${id}:${row.profile_id}:${intent}:image`;
      if((await pool.query('SELECT 1 FROM ai_user_channel_requests WHERE account_id=$1 AND request_key=$2',[row.account_id,requestKey])).rows.length)throw fail('该测试已执行或结果待确认，不会重复发送',409);
      const now=new Date().toISOString();
      const check={id:intent,type:'GRID_SAMPLE_V1',status:'QUEUED',stage:'queued',startedAt:now,updatedAt:now,requestedBy:actor.id,
        profile:{id:row.profile_id,textModel:row.text_model,imageModel:row.image_model,imageProtocol:row.image_protocol}};
      const result=await pool.query(`UPDATE ai_user_channels SET capability_check=$2::jsonb WHERE id=$1 AND profile_id=$3 AND enabled=TRUE AND deleted_at IS NULL
        AND COALESCE(capability_check->>'status','')<>'QUEUED'
        AND (capability_check->>'status' IS DISTINCT FROM 'RUNNING' OR COALESCE(capability_check->>'updatedAt',capability_check->>'startedAt')::timestamptz<NOW()-INTERVAL '20 minutes') RETURNING capability_check`,[id,JSON.stringify(check),row.profile_id]);
      if(result.rows.length)return result.rows[0].capability_check;
      const current=(await pool.query('SELECT capability_check FROM ai_user_channels WHERE id=$1',[id])).rows[0]?.capability_check;
      if(current?.id===intent)return visibleTest(current);
      throw fail('通道配置或测试已变更，请刷新查看',409);
    },
    async processNextCapability() {
      await pool.query(`UPDATE ai_user_channels SET capability_check=capability_check||'{"status":"FAILED","stage":"completed","errorCode":"CHANNEL_TEST_CANCELLED","message":"通道已停用，测试未发送。"}'::jsonb
        WHERE capability_check->>'status'='QUEUED' AND (NOT enabled OR deleted_at IS NOT NULL)`);
      const row=(await pool.query(`SELECT id,capability_check FROM ai_user_channels WHERE capability_check->>'status'='QUEUED' AND enabled=TRUE AND deleted_at IS NULL
        AND (product_lease_until IS NULL OR product_lease_until<NOW()) AND (lease_until IS NULL OR lease_until<NOW())
        ORDER BY capability_check->>'startedAt',id LIMIT 1`)).rows[0];
      if(!row)return null;
      try {return await this.testCapability({role:'admin',id:row.capability_check.requestedBy},row.id,{id:row.capability_check.id,confirmed:true},{queued:true});}
      catch(error){
        if(error.statusCode===409)return null;
        const failed={status:'FAILED',stage:'completed',deliveryState:'NOT_SENT',errorCode:'CHANNEL_TEST_PREPARATION_FAILED',message:'后台测试样本或文字识别暂不可用，测试未发送。',updatedAt:new Date().toISOString()};
        await pool.query("UPDATE ai_user_channels SET capability_check=capability_check||$3::jsonb WHERE id=$1 AND capability_check->>'id'=$2 AND capability_check->>'status'='QUEUED' AND capability_check->'profile'->>'id'=$4",[row.id,row.capability_check.id,JSON.stringify(failed),row.capability_check.profile.id]);
        return failed;
      }
    },
    async testCapability(actor,id,input,{queued=false}={}) {
      if(actor?.role!=="admin") throw fail("仅管理员可测试通道",403);
      if(input.confirmed!==true) throw fail("请确认能力测试可能产生费用");
      const intent=text(input.id,100);
      const row=(await pool.query("SELECT * FROM ai_user_channels WHERE id=$1 AND deleted_at IS NULL",[id])).rows[0];
      if(!row) throw fail("通道不存在",404);
      if(row.capability_check?.type==='GRID_SAMPLE_V1'&&row.capability_check.id===intent&&!(queued&&queuedTest(row.capability_check)))return visibleTest(row.capability_check);
      if(queued&&(!queuedTest(row.capability_check)||row.capability_check.id!==intent))throw fail('测试已由其他执行器领取',409);
      if(!queued&&queuedTest(row.capability_check))throw fail('该通道已有排队测试',409);
      if(runningTest(row.capability_check))throw fail('该通道正在测试，请等待完成',409);
      const requestKey=`channel-capability:${id}:${row.profile_id}:${intent}:image`;
      if((await pool.query('SELECT status FROM ai_user_channel_requests WHERE account_id=$1 AND request_key=$2',[row.account_id,requestKey])).rows.length)throw fail('该测试已执行或结果待确认，不会重复发送',409);
      const descriptor=await getTestSample();
      if(!descriptor.available||!generateTestGrid)throw fail(descriptor.reason||'智能拼图测试尚不可用',422);
      const startedAt=new Date().toISOString();
      const checks={id:intent,type:'GRID_SAMPLE_V1',status:'RUNNING',stage:'preparing',startedAt,updatedAt:startedAt,requestedBy:actor.id,
        sample:descriptor.sample,prompt:descriptor.prompt,image:descriptor.image,
        profile:{id:row.profile_id,textModel:row.text_model,imageModel:row.image_model,imageProtocol:row.image_protocol},
        automatic:{status:'PENDING',expectedCount:descriptor.expected.count,actualCount:0,expectedWidth:descriptor.expected.width,expectedHeight:descriptor.expected.height},images:[]};
      const claimed=await pool.query(`UPDATE ai_user_channels SET capability_check=$3::jsonb WHERE id=$1 AND account_id=$2 AND profile_id=$4 AND enabled=TRUE
        AND (lease_until IS NULL OR lease_until<NOW()) AND (product_lease_until IS NULL OR product_lease_until<NOW())
        AND (NOT $5::boolean OR (capability_check->>'status'='QUEUED' AND capability_check->>'id'=$6))
        AND (capability_check->>'status' IS DISTINCT FROM 'RUNNING' OR COALESCE(capability_check->>'updatedAt',capability_check->>'startedAt')::timestamptz<NOW()-INTERVAL '20 minutes') RETURNING id`,[id,row.account_id,JSON.stringify(checks),row.profile_id,queued,intent]);
      if(!claimed.rows.length)throw fail('通道正在使用、已停用或配置已变更，请刷新后重试',409);
      const persist=async()=>{
        checks.updatedAt=new Date().toISOString();
        const result=await pool.query("UPDATE ai_user_channels SET capability_check=$3::jsonb WHERE id=$1 AND account_id=$2 AND profile_id=$4 AND capability_check->>'id'=$5 RETURNING id",[id,row.account_id,JSON.stringify(checks),row.profile_id,intent]);
        if(!result.rows.length)throw fail('通道配置或测试已变更，请刷新查看最新结果',409);
      };
      try {
        const result=await generateTestGrid({accountId:row.account_id,channelId:id,profileId:row.profile_id,healthProbe:true,waitForCapacity:queued,beforeRequest:async()=>{
          const active=await pool.query("SELECT 1 FROM ai_user_channels WHERE id=$1 AND profile_id=$2 AND enabled=TRUE AND deleted_at IS NULL AND capability_check->>'id'=$3 AND capability_check->>'status'='RUNNING'",[id,row.profile_id,intent]);
          if(!active.rows.length)throw fail('通道配置或测试已变更',409);
        },textModel:row.text_model,imageModel:row.image_model,
          taskId:`channel-test:${intent}`,requestKey,sku:descriptor.sample.version,
          sources:descriptor.sample.images.map(image=>({index:image.index,sourceUrl:image.url})),prompt:descriptor.prompt.text,image:descriptor.image},
          async stage=>{checks.stage=stage;await persist();});
        checks.images=result.images.map(image=>({...image,sourceUrl:descriptor.sample.images.find(source=>source.index===image.index)?.url}));
        checks.automatic.actualCount=checks.images.length;
        const correct=checks.images.length===descriptor.expected.count&&descriptor.sample.images.every(source=>{
          const matches=checks.images.filter(image=>image.index===source.index);
          return matches.length===1&&matches[0].width===descriptor.expected.width&&matches[0].height===descriptor.expected.height;
        });
        if(!correct)throw Object.assign(new Error('切片数量或尺寸不符合要求'),{code:'CHANNEL_TEST_SLICE_INVALID'});
        checks.automatic.status='PASSED';checks.status='PENDING_REVIEW';
      } catch(error) {
        if(error.code==='AI_LISTING_WORKER_STOPPING'&&error.deliveryState==='NOT_SENT'){
          checks.status='QUEUED';checks.stage='queued';await persist();return checks;
        }
        checks.automatic.status='FAILED';checks.status='FAILED';checks.failedStage=checks.stage;
        checks.errorCode=/^[A-Z][A-Z0-9_]{0,100}$/.test(error.code||'')?error.code:'CHANNEL_TEST_FAILED';
        checks.message=({AI_LISTING_GRID_GEOMETRY_INVALID:'生成图的分隔带不完整，无法得到可靠切片。',CHANNEL_TEST_SLICE_INVALID:'切片数量或尺寸不符合要求。',AI_LISTING_OCR_UNAVAILABLE:'本机文字识别不可用。',AI_LISTING_OCR_FAILED:'样本原图文字识别失败。',AI_LISTING_STORAGE_FAILED:'结果图片保存失败。',AI_GATEWAY_NO_CAPACITY:'该通道正在使用或配置已变更，请稍后重新测试。'})[checks.errorCode]||'本次测试未完成，请结合错误码与请求记录检查；重新测试可能再次产生费用。';
      }
      checks.stage='completed';checks.checkedAt=new Date().toISOString();await persist();
      return checks;
    },
    async reviewCapability(actor,id,input) {
      if(actor?.role!=='admin')throw fail('仅管理员可确认通道测试结果',403);
      const intent=text(input.id,100);
      if(typeof input.productCorrect!=='boolean'||typeof input.textCorrect!=='boolean'||(input.notes!==undefined&&(typeof input.notes!=='string'||input.notes.length>1000)))throw fail('请明确确认商品和文字两项检查结果，备注不超过1000字');
      const review={productCorrect:input.productCorrect,textCorrect:input.textCorrect,notes:(input.notes||'').trim(),reviewedBy:actor.id,reviewedAt:new Date().toISOString()};
      const patch={status:input.productCorrect&&input.textCorrect?'PASSED':'REVIEW_FAILED',review};
      const result=await pool.query(`UPDATE ai_user_channels SET capability_check=capability_check||$3::jsonb WHERE id=$1 AND deleted_at IS NULL
        AND capability_check->>'id'=$2 AND capability_check->>'type'='GRID_SAMPLE_V1' AND capability_check->'automatic'->>'status'='PASSED'
        AND capability_check->>'status' IN ('PENDING_REVIEW','PASSED','REVIEW_FAILED') RETURNING capability_check`,[id,intent,JSON.stringify(patch)]);
      if(!result.rows.length)throw fail('测试已变更或自动检查尚未通过，请刷新后确认',409);
      return result.rows[0].capability_check;
    },
    async updateModels(actor, id, input) {
      if (actor?.role !== "admin") throw fail("仅管理员可管理用户通道",403);
      const row=(await pool.query("SELECT * FROM ai_user_channels WHERE id=$1 AND deleted_at IS NULL",[id])).rows[0];
      if (!row) throw fail("通道不存在",404);
      const textModel=direct(row)?"":text(input.textModel),imageModel=text(input.imageModel),billingAccount=text(input.billingAccount);
      const pricing=input.pricing===undefined?row.pricing:normalizeChannelPricing(input.pricing);
      // Updating a quote does not invalidate an already reviewed image capability test.
      if(textModel===row.text_model&&imageModel===row.image_model&&billingAccount===row.billing_account) {
        await pool.query('UPDATE ai_user_channels SET pricing=$2::jsonb WHERE id=$1',[id,JSON.stringify(pricing)]);
        return {id};
      }
      if(Date.parse(row.product_lease_until)>Date.now()||Date.parse(row.lease_until)>Date.now())throw fail("通道仍有商品占用或请求尚未结束，请等待释放后修改模型或计费账号",409);
      const c=await cipher();const port=gateway(row,c.decrypt(scope(row),row.credential));
      const catalog=await port.gateway.listModels({connection:{id:row.id,accountId:row.account_id,version:1,baseUrl:row.base_url,status:"ACTIVE"},correlationId:row.id,requestKey:randomUUID()});
      if((!direct(row)&&!catalog.models.some(m=>m.id===textModel))||!catalog.models.some(m=>m.id===imageModel)) throw fail("通道不支持所选模型，请重新检查模型目录");
      const profileId="user-channel-"+randomUUID();
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-user-channel-allocation'))");
        const active=await client.query('SELECT 1 FROM ai_user_channels WHERE id=$1 AND (product_lease_until>NOW() OR lease_until>NOW())',[id]);
        if(active.rows.length)throw fail('通道仍有商品占用或请求尚未结束，请等待释放后修改模型或计费账号',409);
      await client.query(`WITH snapshot AS (
        INSERT INTO ai_gateway_profiles(id,account_id,display_name,base_url,api_key_env_name,text_protocol,image_protocol,text_model,image_model,config_version,enabled,created_by)
        SELECT $2,account_id,name,base_url,'USER_AI_CHANNEL_KEY','SUB2API_RESPONSES',image_protocol,$3,$4,1,FALSE,$5 FROM ai_user_channels WHERE id=$1 RETURNING id
      ) UPDATE ai_user_channels SET profile_id=(SELECT id FROM snapshot),text_model=$3,image_model=$4,billing_account=$6,pricing=$7::jsonb,connection_check=NULL,capability_check=NULL,failure_count=0,needs_attention=FALSE,last_error_code=NULL,cooldown_until=NULL WHERE id=$1`,
      [id,profileId,textModel,imageModel,actor.id,billingAccount,JSON.stringify(pricing)]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      return {id};
    },
    async remove(actor, id) {
      if (actor?.role !== "admin") throw fail("仅管理员可管理用户通道",403);
      const result=await pool.query("UPDATE ai_user_channels SET deleted_at=NOW() WHERE id=$1 AND enabled=FALSE AND (lease_until IS NULL OR lease_until<NOW()) RETURNING id",[id]);
      if (!result.rows.length) throw fail("请先停用通道，并等待正在执行的请求结束");
      return {id};
    },
    async setEnabled(actor, id, enabled) {
      if (actor?.role !== "admin") throw fail("仅管理员可管理用户通道",403);
      if (typeof enabled !== "boolean") throw fail("无效的通道状态");
      const r = await pool.query("UPDATE ai_user_channels SET enabled=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id",[id,enabled]);
      if (!r.rows.length) throw fail("通道不存在",404);
      return { id, enabled };
    },
    async hasAssigned(accountId) {
      return (await pool.query("SELECT 1 FROM ai_user_channels WHERE account_id=$1 LIMIT 1",[accountId])).rows.length > 0;
    },
    async assertAvailable(accountId) {
      const r=await pool.query("SELECT 1 FROM ai_user_channels WHERE account_id=$1 AND enabled=TRUE AND connection_check->>'status' IS DISTINCT FROM 'MODEL_MISSING' LIMIT 1",[accountId]);
      if (!r.rows.length) throw fail("请在管理员配置中分配并启用模型可用的用户 AI 通道",409);
    },
    async run(input, generate) {
      const lease = randomUUID();
      const startedWaiting=Date.now();
      let row;
      while(!row) {
        await input.beforeRequest?.();
        const client = await pool.connect();
        let r;
        try {
          await client.query("BEGIN");
          // Serialize only allocation; provider requests run outside this transaction.
          // Separate statements ensure the count sees the last committed allocation.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-user-channel-allocation'))");
          if(input.productToken) {
            const bound=await assertProduct(client,input);
            if(!bound.enabled||bound.deleted_at||bound.needs_attention||bound.connection_check?.status==='MODEL_MISSING'||Date.parse(bound.cooldown_until)>Date.now()
              ||(input.textModel&&input.textModel!==bound.text_model)||(input.imageModel&&input.imageModel!==bound.image_model)||(input.profileId&&input.profileId!==bound.profile_id))throw noCapacity();
          }
        const {billingConcurrency,requestConcurrency}=getRuntimeSettings();
        r = await client.query(`WITH chosen AS (
          SELECT id FROM ai_user_channels candidate WHERE account_id=$1 AND enabled=TRUE AND deleted_at IS NULL AND connection_check->>'status' IS DISTINCT FROM 'MODEL_MISSING'
            AND ($5::text IS NULL OR id=$5)
            AND ($10::text IS NOT NULL OR $7::boolean OR (COALESCE(capability_check->>'status','')<>'QUEUED' AND (capability_check->>'status' IS DISTINCT FROM 'RUNNING' OR COALESCE(capability_check->>'updatedAt',capability_check->>'startedAt')::timestamptz<NOW()-INTERVAL '20 minutes')))
            AND (($10::text IS NULL AND (product_lease_until IS NULL OR product_lease_until<NOW()))
              OR (product_token=$10 AND product_task_id=$11 AND product_lease_until>NOW()))
            AND (needs_attention=FALSE OR $7::boolean) AND NOT (id=ANY($6::text[]))
            AND ($3::text IS NULL OR text_model=$3) AND ($4::text IS NULL OR image_model=$4)
            AND ($9::text IS NULL OR profile_id=$9)
            AND (lease_until IS NULL OR lease_until<NOW()) AND ($7::boolean OR cooldown_until IS NULL OR cooldown_until<NOW())
            AND (SELECT COUNT(*) FROM ai_user_channels WHERE lease_until>NOW())<$12
            AND (SELECT COUNT(*) FROM ai_user_channels busy
              WHERE busy.base_url=candidate.base_url AND busy.billing_account=candidate.billing_account
                AND busy.lease_until>NOW()) < $8
          ORDER BY failure_count ASC,last_used_at ASC NULLS FIRST,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE ai_user_channels c SET lease_token=$2,lease_until=NOW()+INTERVAL '15 minutes',last_used_at=NOW()
          FROM chosen WHERE c.id=chosen.id AND c.account_id=$1 RETURNING c.*`,[input.accountId,lease,input.textModel||null,input.imageModel||null,input.channelId||null,input.excludeChannelIds||[],input.healthProbe===true,billingConcurrency,input.profileId||null,input.productToken||null,input.taskId,requestConcurrency]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
        row=r.rows[0];
        if(!row) {
          if((!input.productToken&&!(input.healthProbe&&input.waitForCapacity&&input.channelId&&input.beforeRequest))||Date.now()-startedWaiting>=requestWaitMs)throw noCapacity();
          await new Promise(resolve=>setTimeout(resolve,requestRetryMs));
        }
      }
      const requestId=randomUUID(); let failed=false; let errorCode=null;let lost=false;let sent=false;let recorded=false;let quarantine=false;
      const heartbeat=setInterval(()=>{void pool.query("UPDATE ai_user_channels SET lease_until=NOW()+INTERVAL '15 minutes' WHERE id=$1 AND account_id=$2 AND lease_token=$3 RETURNING id",[row.id,input.accountId,lease]).then(r=>{if(!r.rows.length)lost=true;}).catch(()=>{lost=true;});},60_000);
      heartbeat.unref?.();
      try {
        const sample=row.pricing?null:(await pool.query("SELECT report FROM ai_channel_price_checks WHERE account_id=$1 AND channel_id=$2 AND report->>'model'=$3 AND report->>'status'='VERIFIED' ORDER BY day DESC LIMIT 1",[input.accountId,row.id,row.image_model])).rows[0]?.report;
        const pricing=row.pricing?{...row.pricing,source:'CONFIGURED'}:sampleChannelPricing(sample);
        const initialCost=estimateChannelCost(pricing,null);
        const c=await cipher();const port=gateway(row,c.decrypt(scope(row),row.credential));
        if(lost)throw Object.assign(new Error('通道租约已失效'),{code:'AI_LISTING_CHANNEL_LEASE_LOST'});
        await pool.query("INSERT INTO ai_user_channel_requests(id,account_id,channel_id,task_id,request_key,status,estimated_cost_cny,pricing_snapshot) VALUES($1,$2,$3,$4,$5,'STARTED',$6,$7::jsonb)",
          [requestId,input.accountId,row.id,input.taskId,input.requestKey,pricing?.currency==='CNY'?initialCost:null,JSON.stringify(pricing)]);
        recorded=true;
        if(input.productToken) {
          const bound=await assertProduct(pool,input);
          if(!bound.enabled||bound.deleted_at)throw noCapacity();
        }
        await input.beforeRequest?.();
        sent=true;
        const result=await generate(port);
        if(lost)throw Object.assign(new Error("通道租约已失效"),{code:"AI_LISTING_CHANNEL_LEASE_LOST"});
        const usage=result.usage||result.payload?.usage||null;
        const estimatedCost=estimateChannelCost(pricing,usage);
        await pool.query("UPDATE ai_user_channel_requests SET status='SUCCEEDED',gateway_request_id=$3,completed_at=NOW(),usage=$4::jsonb,estimated_cost=$5,cost_currency=$6,estimated_cost_cny=$7 WHERE id=$1 AND account_id=$2",
          [requestId,input.accountId,result.gatewayRequestId||result.requestId||null,JSON.stringify(usage),estimatedCost,estimatedCost===null?null:pricing.currency,pricing?.currency==='CNY'?estimatedCost:null]).catch(() => {});
        return {...result,generationConfig:{...result.generationConfig,channelId:row.id}};
      } catch(error) {
        if(!sent&&(error===null||typeof error!=='object'))throw error;
        if(error===null||typeof error!=='object')error=new Error('AI 请求失败');
        failed=sent&&error.stage!=="upload";
        // An unclassified transport outcome may already have reached the paid endpoint.
        quarantine=failed&&error.deliveryState!=="NOT_SENT";
        // The caller must pause rather than pay again on another channel for an unknown send.
        if(quarantine&&!Object.hasOwn(error,'deliveryState'))Object.defineProperty(error,'deliveryState',{
          value:'POSSIBLY_SENT',enumerable:true,writable:false,configurable:false,
        });
        const code=/^[A-Z][A-Z0-9_]{0,100}$/.test(error.code||"")?error.code:"AI_LISTING_IMAGE_FAILED";
        if(sent)await pool.query("UPDATE ai_user_channel_requests SET status='FAILED',error_code=$3,gateway_request_id=$4,completed_at=NOW() WHERE id=$1 AND account_id=$2",[requestId,input.accountId,code,error.requestId||null]).catch(() => {});
        errorCode=failed?code:null;
        error.channelId=row.id;
        throw error;
      } finally {
        clearInterval(heartbeat);
        const permanent=["NON_RETRYABLE_AUTH","AI_GATEWAY_MODEL_UNAVAILABLE","AI_GATEWAY_QUOTA_EXHAUSTED","AI_GATEWAY_PROFILE_INVALID","AI_GATEWAY_SECRET_MISSING"].includes(errorCode);
        if(!sent) {
          if(recorded)await pool.query('DELETE FROM ai_user_channel_requests WHERE id=$1 AND account_id=$2 AND status=\'STARTED\'',[requestId,input.accountId]).catch(()=>{});
          await pool.query('UPDATE ai_user_channels SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND account_id=$2 AND lease_token=$3',[row.id,input.accountId,lease]).catch(()=>{});
        } else await pool.query(`UPDATE ai_user_channels SET lease_token=CASE WHEN $7 THEN lease_token ELSE NULL END,
          lease_until=CASE WHEN $7 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END,
          failure_count=CASE WHEN $4 THEN failure_count+1 ELSE 0 END,
          needs_attention=CASE WHEN $4 THEN ($5 OR failure_count+1>=3) ELSE FALSE END,last_error_code=$6,
          cooldown_until=CASE WHEN $4 AND NOT $5 THEN NOW()+CASE WHEN failure_count=0 THEN INTERVAL '1 minute' WHEN failure_count=1 THEN INTERVAL '5 minutes' ELSE INTERVAL '15 minutes' END ELSE NULL END
          WHERE id=$1 AND account_id=$2 AND lease_token=$3`,[row.id,input.accountId,lease,failed,permanent,errorCode,quarantine]).catch(() => {});
      }
    },
  };
}
