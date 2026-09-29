#!/usr/bin/env node
// Offline, one-shot configuration seed. No app runtime, gateway or object-storage service is started.
import {randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv} from 'node:crypto';
import {open, lstat, readFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createAutoListingCredentialCipher} from '../server/auto-listing-ai-credential-crypto.mjs';
import {loadAutoListingCredentialKey} from '../server/auto-listing-ai-credential-config.mjs';

// Ordered parents before children; no queue, session, wallet, request or task history table is accepted.
const TABLES=['accounts','stores','store_credentials','warehouses','products','orders','order_items','local_state',
  'ai_gateway_profiles','ai_user_channels','ai_listing_presets','pricing_config_versions',
  'pricing_commission_rules','pricing_logistics_rules','pricing_domestic_fee_rules','pricing_default_rules','pricing_exchange_rates',
  'pricing_official_imports','pricing_official_category_mappings','platform_product_restrictions',
  'ozon_message_settings','ozon_message_templates','ozon_promotion_stores','ozon_promotion_rules','ozon_product_costs'];
const CATEGORY_BOOTSTRAP_TABLES=['auto_listing_category_strategy_account_settings','auto_listing_category_strategy_events'];
const failure=code=>Object.assign(new Error(code),{code});
const clone=value=>structuredClone(value);
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
const qid=value=>'"'+String(value).replaceAll('"','""')+'"';

// crypto-secrets.mjs uses SHA-256(APP_ENCRYPTION_KEY) and AES-GCM without AAD.
// Explicit keys here avoid changing process.env while old and new credentials coexist in memory.
function openStore(payload,key){
  const cipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(key).digest(),Buffer.from(payload.iv,'base64'));
  cipher.setAuthTag(Buffer.from(payload.authTag||payload.auth_tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(payload.ciphertext||payload.encrypted_api_key,'base64')),cipher.final()]).toString('utf8');
}
function sealStore(value,key,keyVersion){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(key).digest(),iv);
  return {algorithm:'aes-256-gcm',ciphertext:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64'),
    iv:iv.toString('base64'),authTag:cipher.getAuthTag().toString('base64'),keyVersion};
}

function assertSourceSafe(source){
  if(['wallets','taskBilling','walletEntries','messageRecords'].some(k=>Number(source.audit[k]||0)>0))throw failure('SOURCE_RECORDS_REQUIRE_RECONCILIATION');
}
export function prepareExport(source,{oldAppKey,oldAiKey,oldAiVersion}={}){
  assertSourceSafe(source);if(!oldAppKey)throw failure('SOURCE_APP_KEY_REQUIRED');
  const transportKey=randomBytes(32).toString('base64url'),data=clone(source);
  delete data.store.raw;
  data.credential=sealStore(openStore(source.credential,oldAppKey),transportKey,'seed-transport-v1');
  const oldCipher=createAutoListingCredentialCipher({key:oldAiKey,keyVersion:oldAiVersion});
  const transportCipher=createAutoListingCredentialCipher({key:Buffer.from(transportKey,'base64url'),keyVersion:'seed-transport-v1'});
  data.rows.ai_user_channels=(source.rows.ai_user_channels||[]).filter(c=>c.enabled&&!c.deleted_at).map(c=>{
    const scope={accountId:c.account_id,connectionId:c.id,connectionVersion:1};
    const secret=oldCipher.decrypt(scope,c.credential);
    return {...pick(c,['id','account_id','name','base_url','text_model','image_model','image_protocol','billing_account','pricing']),
      enabled:true,deleted_at:null,credential:transportCipher.encrypt(scope,secret)};
  });
  data.rows.ozon_message_settings=(data.rows.ozon_message_settings||[]).map(m=>({config:{...pick(m.config,['displayName','timeZone']),enabled:false,webhookBaseUrl:''}}));
  data.rows.ozon_message_templates=(data.rows.ozon_message_templates||[]).map(t=>({...pick(t,['id','body']),body:{...t.body,enabled:false}}));
  data.rows.ozon_promotion_stores=(data.rows.ozon_promotion_stores||[]).map(p=>({
    config:{...p.config,enabled:false,exitEnabled:false,protectPrices:false},
    snapshot:{products:(p.snapshot?.products||[]).filter(x=>Object.hasOwn(p.config.floors||{},x.productId)),actions:[],memberships:[]}}));
  data.rows.ozon_promotion_rules=(data.rows.ozon_promotion_rules||[]).map(r=>({...pick(r,['id','body']),body:{...r.body,enabled:false}}));
  data.rows.ozon_product_costs=(data.rows.ozon_product_costs||[]).map(c=>({...c,auto_apply:false}));
  data.rows.warehouses=(data.rows.warehouses||[]).map(w=>({...w,raw:{}}));
  const report={createdAt:new Date().toISOString(),mode:'EXPORT_ONLY',sourceAudit:source.audit,
    sourceConfigurationCounts:Object.fromEntries(Object.entries(data.rows).map(([name,rows])=>[name,rows.length])),
    deferredConfigurationCounts:Object.fromEntries(Object.entries(source.legacy||{}).map(([name,rows])=>[name,rows.length])),
    objectReferences:(data.rows.pricing_official_imports||[]).map(row=>pick(row,['object_bucket','object_key','sha256','file_size'])),
    notes:['Production env and admin password are never generated or overwritten.','Import binds to the existing bootstrap admin and production encryption keys.',
      'Messages, promotions, channel availability and cost autoApply are disabled on import; health and lease fields are reset.',
      'Source wallet or message records require separate reconciliation. Real order financial snapshots and AI request receipts remain in the existing backup.',
      'Old warehouse bindings need an explicit main-store selection. Legacy strategy/preference configuration is exported but not activated.',
      'Original published media and official tariff object references must remain available; no objects are fetched or deleted.']};
  return {bundle:{format:'ozon-production-source-v2',createdAt:report.createdAt,source:data},transportKey,report};
}
export function buildSeed(source,{oldAppKey,oldAiKey,oldAiVersion,targetAppKey,targetAppVersion,targetAiKey,targetAiVersion,admin,bootstrapState}={}){
  assertSourceSafe(source);
  if(!oldAppKey)throw failure('SOURCE_APP_KEY_REQUIRED');
  if(!admin?.id||admin.role!=='admin'||!admin.passwordHash)throw failure('BOOTSTRAP_ADMIN_REQUIRED');
  if(!targetAppKey||!targetAppVersion||!targetAiKey||!targetAiVersion)throw failure('PRODUCTION_KEYS_REQUIRED');
  const now=new Date().toISOString(),secrets={APP_ENCRYPTION_KEY:targetAppKey,APP_ENCRYPTION_KEY_VERSION:targetAppVersion,
    AUTO_LISTING_CREDENTIAL_MASTER_KEY:targetAiKey.toString('base64url'),AUTO_LISTING_CREDENTIAL_KEY_VERSION:targetAiVersion};
  const rows=name=>clone(source.rows[name]||[]),tables=Object.fromEntries(TABLES.map(name=>[name,[]]));
  const scoped=row=>({...row,...('account_id' in row?{account_id:admin.id}:{}),...('created_by' in row?{created_by:admin.id}:{}),...('updated_by' in row?{updated_by:admin.id}:{}),...('published_by' in row?{published_by:row.published_by?admin.id:null}:{})});
  const store=source.store,storeId=store.id,protectedKey=sealStore(openStore(source.credential,oldAppKey),secrets.APP_ENCRYPTION_KEY,secrets.APP_ENCRYPTION_KEY_VERSION);
  const stateStore={id:storeId,storeId,ownerAccountId:admin.id,label:store.label,companyName:store.company_name||store.label,
    legalName:store.legal_name||store.label,clientId:store.client_id,inn:store.inn||'',taxId:store.tax_id||'',
    currencyCode:store.currency_code,currencySource:store.currency_source||'',currencySyncedAt:store.currency_synced_at||null,
    status:store.status||'active',savedAt:now,updatedAt:now,apiKeyCreatedAt:store.api_key_created_at||null,
    apiKeyExpiresAt:store.api_key_expires_at||null,apiKeyEncrypted:protectedKey,apiKeyProtected:true};
  const {apiKeyEncrypted, ...rawStore}=stateStore;
  tables.accounts=[]; // The target bootstrap account and password hash are never rewritten.
  tables.stores=[{...pick(store,['id','label','company_name','legal_name','client_id','inn','tax_id','currency_code','seller_company_id','api_key_created_at','api_key_expires_at','currency_source','currency_synced_at']),
    owner_account_id:admin.id,status:stateStore.status,is_current:true,is_premium:false,saved_at:now,updated_at:now,profile_synced_at:null,raw:{...rawStore,apiKey:'__encrypted__'}}];
  tables.store_credentials=[{store_id:storeId,client_id:store.client_id,encrypted_api_key:protectedKey.ciphertext,iv:protectedKey.iv,auth_tag:protectedKey.authTag,
    algorithm:protectedKey.algorithm,key_version:protectedKey.keyVersion,updated_at:now,api_key_created_at:store.api_key_created_at||null,api_key_expires_at:store.api_key_expires_at||null}];
  tables.warehouses=rows('warehouses').map(w=>({...w,raw:{}}));
  tables.products=rows('products');tables.orders=rows('orders');tables.order_items=rows('order_items');
  const state={...clone(bootstrapState||{}),accounts:[admin],stores:[stateStore],sessions:clone(bootstrapState?.sessions||{}),token:bootstrapState?.token||'',sessionIssuedAt:bootstrapState?.sessionIssuedAt||'',currentAccountId:admin.id,currentStoreId:storeId,
    currentStoreIdsByAccount:{[admin.id]:storeId},caches:{},jobs:{},leases:{},reports:[],auditEvents:clone(bootstrapState?.auditEvents||[]),hashes:{},browserAgents:{},pendingObjectDeletions:[],updatedAt:now};
  tables.local_state=[{id:'local-state',state,version:1,created_at:now,updated_at:now}];
  const oldCipher=createAutoListingCredentialCipher({key:oldAiKey,keyVersion:oldAiVersion});
  const newCipher=createAutoListingCredentialCipher({key:Buffer.from(secrets.AUTO_LISTING_CREDENTIAL_MASTER_KEY,'base64url'),keyVersion:secrets.AUTO_LISTING_CREDENTIAL_KEY_VERSION});
  for(const sourceChannel of rows('ai_user_channels').filter(c=>c.enabled&&!c.deleted_at)){
    const key=oldCipher.decrypt({accountId:sourceChannel.account_id,connectionId:sourceChannel.id,connectionVersion:1},sourceChannel.credential);
    const id=randomUUID(),profileId='user-channel-'+id;
    tables.ai_gateway_profiles.push({id:profileId,account_id:admin.id,display_name:sourceChannel.name,base_url:sourceChannel.base_url,
      api_key_env_name:'USER_AI_CHANNEL_KEY',text_protocol:'SUB2API_RESPONSES',image_protocol:sourceChannel.image_protocol,text_model:sourceChannel.text_model,
      image_model:sourceChannel.image_model,config_version:1,enabled:false,created_by:admin.id,connection_id:null,connection_version:null});
    tables.ai_user_channels.push({id,account_id:admin.id,created_by:admin.id,...pick(sourceChannel,['name','base_url','text_model','image_model','image_protocol','billing_account','pricing']),
      profile_id:profileId,credential:newCipher.encrypt({accountId:admin.id,connectionId:id,connectionVersion:1},key),key_fingerprint:newCipher.fingerprint(key),
      enabled:false,lease_token:null,lease_until:null,cooldown_until:null,last_used_at:null,connection_check:null,capability_check:null,
      failure_count:0,needs_attention:false,last_error_code:null,deleted_at:null,created_at:now});
  }
  const presets=rows('ai_listing_presets'),promptIds=new Map(),pendingBindings=[];
  for(const p of presets.filter(p=>p.kind==='prompts')){
    const id=randomUUID();promptIds.set(p.id,id);
    tables.ai_listing_presets.push({id,account_id:admin.id,kind:'prompts',name:p.name,payload:{content:p.payload.content},created_at:now,updated_at:now});
  }
  for(const p of presets.filter(p=>p.kind==='configs')){
    const old=p.payload.config,promptId=promptIds.get(old.promptId);
    if(!promptId)throw failure('SAVED_PROMPT_REFERENCE_MISSING');
    const warehouse=tables.warehouses.find(w=>w.id===old.targetWarehouseId&&w.store_id===storeId);
    const config={...pick(old,['stock','priceAdjustmentKopecks','priceMultiplier','brandMode','generationMode','image']),promptId,
      targetStoreId:storeId,targetWarehouseId:warehouse?.id||'',manualReview:true,autoSwitchStores:false,fallbackStores:[]};
    const id=randomUUID();if(!warehouse)pendingBindings.push({kind:'ai_listing_presets',id,reason:'SELECT_MAIN_STORE_WAREHOUSE'});
    tables.ai_listing_presets.push({id,account_id:admin.id,kind:'configs',name:p.name,payload:{config},created_at:now,updated_at:now});
  }
  for(const table of TABLES.filter(t=>t.startsWith('pricing_')))tables[table]=rows(table).map(row=>{
    const result=scoped(row);if(result.scope_type==='account')result.scope_id=admin.id;return result;
  });
  tables.platform_product_restrictions=rows('platform_product_restrictions').map(r=>({...r,updated_by:admin.id}));
  for(const m of rows('ozon_message_settings'))tables.ozon_message_settings.push({account_id:admin.id,store_id:storeId,
    config:{...pick(m.config,['displayName','timeZone']),enabled:false,webhookBaseUrl:''},state:{},webhook_token:randomBytes(32).toString('hex'),next_sync_at:0});
  tables.ozon_message_templates=rows('ozon_message_templates').map(t=>({id:randomUUID(),account_id:admin.id,store_id:storeId,body:{...t.body,enabled:false},created_at:Date.now()}));
  tables.ozon_promotion_stores=rows('ozon_promotion_stores').map(p=>({account_id:admin.id,store_id:storeId,
    config:{...p.config,enabled:false,exitEnabled:false,protectPrices:false},state:{},sync_requested:false,next_sync_at:0,
    snapshot:{actions:[],memberships:[],products:(p.snapshot?.products||[]).filter(x=>Object.hasOwn(p.config.floors||{},x.productId))}}));
  tables.ozon_promotion_rules=rows('ozon_promotion_rules').map(r=>({id:randomUUID(),account_id:admin.id,store_id:storeId,body:{...r.body,enabled:false},version:1,next_run_at:null,last_run_at:null,created_at:Date.now()}));
  tables.ozon_product_costs=rows('ozon_product_costs').map(row=>({...scoped(row),auto_apply:false}));
  const deferred=clone(source.legacy||{});
  const report={createdAt:now,mode:'EXPORT_ONLY',sourceAudit:source.audit,counts:Object.fromEntries(TABLES.map(t=>[t,tables[t].length])),pendingBindings,
    deferredConfigurationCounts:Object.fromEntries(Object.entries(deferred).map(([key,value])=>[key,value.length])),
    notes:['No source business writes or external API calls.','Old orders, platform request receipts and published objects remain in the existing backup; they are not classified as fake.',
      'Source wallet or message records block this minimal seed.','Legacy category configuration is preserved under deferredConfiguration, not activated.',
      'Select a main-store warehouse before creating listing tasks.','Import requires an explicitly named, migrated, empty database.','Existing production keys and bootstrap admin are retained.'],
    objectReferences:tables.pricing_official_imports.map(row=>pick(row,['object_bucket','object_key','sha256','file_size']))};
  return {bundle:{format:'ozon-production-config-seed-v1',createdAt:now,sourceMigrations:source.migrations||[],tables,deferredConfiguration:deferred},secrets,report};
}

async function privateFile(file){
  const s=await lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw failure('PRIVATE_FILE_0600_REQUIRED');
  return readFile(file,'utf8');
}
export async function writeSeedFiles(directory,result){
  const s=await lstat(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw failure('PRIVATE_DIRECTORY_0700_REQUIRED');
  const contents={'seed-source.json':JSON.stringify(result.bundle),'seed-transport.key':result.transportKey+'\n',
    'seed-report.json':JSON.stringify(result.report,null,2)+'\n'};
  const handles=[];
  try{
    // Reserve every destination before writing: a repeat or symlink cannot replace a previous seed.
    for(const name of Object.keys(contents)){const file=path.join(directory,name);handles.push({file,name,handle:await open(file,'wx',0o600)});}
    for(const {handle,name}of handles){await handle.writeFile(contents[name],'utf8');await handle.sync();}
  }catch(e){for(const {handle,file}of handles){await handle.close().catch(()=>{});await unlink(file).catch(()=>{});}throw e;}
  finally{for(const {handle}of handles)await handle.close().catch(()=>{});}
}
async function readEnv(file){
  const env={};
  for(const line of (await privateFile(file)).split(/\r?\n/)){
    const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(!m)continue;
    let value=m[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1).replace(/\\n/g,'\n').replace(/\\"/g,'"');
    else value=value.replace(/\s+#.*$/,'');env[m[1]]=value;
  }
  if(env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE)env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE=path.resolve(path.dirname(file),env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE);
  return env;
}
function dbConfig(env){
  if(!env.DATABASE_URL&&(!env.POSTGRES_HOST||!env.POSTGRES_DB||!env.POSTGRES_USER||!env.POSTGRES_PASSWORD))throw failure('DATABASE_CONFIGURATION_REQUIRED');
  const config=env.DATABASE_URL?{connectionString:env.DATABASE_URL}:{host:env.POSTGRES_HOST,port:Number(env.POSTGRES_PORT||5432),database:env.POSTGRES_DB,user:env.POSTGRES_USER,password:env.POSTGRES_PASSWORD};
  return {...config,connectionTimeoutMillis:8000,application_name:'ozon-deploy-seed',ssl:['1','true'].includes(env.POSTGRES_SSL)?{rejectUnauthorized:true}:false};
}
async function readSource(client,storeLabel){
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    const stores=(await client.query('SELECT * FROM public.stores WHERE label=$1',[storeLabel])).rows;
    if(stores.length!==1)throw failure('SOURCE_STORE_NOT_UNIQUE');
    const store=stores[0],scope=[store.owner_account_id,store.id],rows={};
    const credential=(await client.query('SELECT * FROM public.store_credentials WHERE store_id=$1',[store.id])).rows[0];
    if(!credential)throw failure('SOURCE_STORE_CREDENTIAL_REQUIRED');
    const audit=(await client.query(`SELECT
      (SELECT count(*)::int FROM ai_user_wallets) AS wallets,(SELECT count(*)::int FROM ai_task_billing) AS "taskBilling",
      (SELECT count(*)::int FROM ai_wallet_entries) AS "walletEntries",(SELECT count(*)::int FROM ozon_message_records) AS "messageRecords",
      (SELECT count(*)::int FROM orders WHERE store_id=$1) AS orders,
      (SELECT count(*)::int FROM orders WHERE store_id=$1 AND jsonb_typeof(raw->'financial_data')='object') AS "ordersWithFinancialData",
      (SELECT count(*)::int FROM ai_user_channel_requests) AS "aiRequestReceipts",
      (SELECT count(*)::int FROM auto_listing_asset_publications) AS "publishedAssetRows"`,[store.id])).rows[0];
    if(['wallets','taskBilling','walletEntries','messageRecords'].some(k=>audit[k]>0))throw failure('SOURCE_RECORDS_REQUIRE_RECONCILIATION');
    for(const table of ['ozon_message_settings','ozon_message_templates','ozon_promotion_stores','ozon_promotion_rules','ozon_product_costs'])rows[table]=(await client.query(`SELECT * FROM public.${qid(table)} WHERE account_id=$1 AND store_id=$2`,scope)).rows;
    rows.warehouses=(await client.query('SELECT * FROM public.warehouses WHERE store_id=$1',[store.id])).rows;
    rows.ai_user_channels=(await client.query('SELECT * FROM public.ai_user_channels WHERE account_id=$1 AND enabled=TRUE AND deleted_at IS NULL',[scope[0]])).rows;
    rows.ai_listing_presets=(await client.query('SELECT * FROM public.ai_listing_presets WHERE account_id=$1 ORDER BY kind,id',[scope[0]])).rows;
    rows.platform_product_restrictions=(await client.query('SELECT * FROM public.platform_product_restrictions')).rows;
    // Only cost-bearing orders and their identities need to accompany this otherwise empty business database.
    rows.orders=(await client.query("SELECT * FROM public.orders WHERE store_id=$1 AND purchase_costs<>'{}'::jsonb",[store.id])).rows;
    rows.order_items=(await client.query('SELECT * FROM public.order_items WHERE order_id=ANY($1::text[])',[rows.orders.map(r=>r.id)])).rows;
    const productIds=[...new Set([...rows.ozon_product_costs.map(x=>x.product_id),...rows.ozon_promotion_stores.flatMap(x=>Object.keys(x.config.floors||{}))])];
    rows.products=(await client.query('SELECT * FROM public.products WHERE store_id=$1 AND product_id=ANY($2::text[])',[store.id,productIds])).rows;
    // Supporting product images can be resynced; do not carry file-table foreign keys into an empty database.
    rows.products=rows.products.map(p=>({...p,primary_file_id:null}));
    rows.pricing_config_versions=(await client.query(`SELECT * FROM public.pricing_config_versions WHERE status IN ('ACTIVE','DRAFT','VALIDATED','SCHEDULED')
      AND (scope_type='global' OR scope_type='account' AND scope_id=$1 OR scope_type='store' AND scope_id=$2)`,scope)).rows;
    const versionIds=rows.pricing_config_versions.map(r=>r.id);
    for(const table of TABLES.filter(t=>t.startsWith('pricing_')&&t!=='pricing_config_versions'))rows[table]=(await client.query(`SELECT * FROM public.${qid(table)} WHERE version_id=ANY($1::text[])`,[versionIds])).rows;
    const legacy={};
    legacy.preferences=(await client.query('SELECT * FROM auto_listing_preferences WHERE account_id=$1',[scope[0]])).rows;
    legacy.strategies=(await client.query("SELECT * FROM ai_content_strategy_versions WHERE account_id=$1 AND status='PUBLISHED'",[scope[0]])).rows;
    legacy.strategyRules=(await client.query('SELECT * FROM ai_content_strategy_rules WHERE strategy_version_id=ANY($1::text[])',[legacy.strategies.map(x=>x.id)])).rows;
    const migrations=(await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version);
    await client.query('ROLLBACK');return {store,credential,rows,audit,legacy,migrations};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
}

// The source retains an old 014 label; fresh installs use the current 015 FX migration.
// Only that recorded alias is compatible, and only when the current migration was applied.
export function validateTargetMigrations(source,applied){
  for(const version of source){
    if(applied.has(version))continue;
    if(version==='014_dynamic_fx_probes'&&applied.has('015_dynamic_fx_probes'))continue;
    throw failure('TARGET_MIGRATIONS_REQUIRED');
  }
}
export function validateTargetInventory(inventory,expectedDatabase,{bootstrap=false,queueSchema=''}={}){
  if(!expectedDatabase)throw failure('TARGET_DATABASE_CONFIRMATION_REQUIRED');
  if(inventory.database!==expectedDatabase)throw failure('TARGET_DATABASE_MISMATCH');
  const allowed=t=>t.schema==='public'&&(t.name==='schema_migrations'||bootstrap&&['accounts','local_state','sessions','audit_events',...CATEGORY_BOOTSTRAP_TABLES].includes(t.name))
    ||bootstrap&&t.schema===queueSchema&&['queue','version'].includes(t.name);
  if(inventory.tables.some(t=>!allowed(t)&&Number(t.count)>0))throw failure('TARGET_NOT_EMPTY');
}
// Only normal successful bootstrap logins for the single production admin may preexist.
// These relational rows are never updated, deleted or reinserted by the seed.
export function validateBootstrapAuth({adminId,state,sessions,audits}){
  const stateSessions=Object.entries(state.sessions||{}),stateAudits=state.auditEvents||[];
  const allowed=a=>a.accountId===adminId&&a.actorId===adminId&&a.actorType==='account'&&!a.storeId
    &&a.action==='ACCOUNT_LOGIN'&&a.status==='SUCCESS'&&a.source==='web'&&a.entityType==='account'&&a.entityId===adminId;
  const relationalAudits=audits.map(a=>({eventId:a.event_id,accountId:a.account_id,actorId:a.actor_id,actorType:a.actor_type,
    storeId:a.store_id,action:a.action,status:a.status,source:a.source,entityType:a.entity_type,entityId:a.entity_id}));
  if(sessions.some(s=>s.account_id!==adminId||!state.sessions?.[s.token])
    ||stateSessions.some(([token,s])=>s.accountId!==adminId||s.token!==token||!sessions.some(row=>row.token===token))
    ||[...stateAudits,...relationalAudits].some(a=>!allowed(a))
    ||stateAudits.length!==audits.length||stateAudits.some(a=>!relationalAudits.some(row=>row.eventId===a.eventId))
    ||state.token&&(!state.sessions?.[state.token]||state.currentAccountId!==adminId))throw failure('BOOTSTRAP_AUTH_NOT_ALLOWED');
}
// Migration 075 creates exactly these two rows when the bootstrap account is inserted.
export function validateBootstrapCategorySettings({adminId,settings,events}){
  const key='category-strategy-settings-bootstrap:'+adminId;
  const owned=row=>row.account_id===adminId&&row.actor_account_id===adminId&&row.idempotency_key===key
    &&row.correlation_id===key&&row.request_hash==='0'.repeat(64);
  if(settings.length!==1||events.length!==1)throw failure('BOOTSTRAP_CATEGORY_NOT_ALLOWED');
  const s=settings[0],e=events[0];
  if(!owned(s)||!owned(e)||s.mode!=='LEGACY_FALLBACK'||Number(s.version)!==1
    ||e.id!=='category-strategy-settings:'+adminId+':1'||e.event_type!=='ACCOUNT_SETTINGS_CHANGED'
    ||Number(e.settings_version)!==1||e.event_payload?.mode!=='LEGACY_FALLBACK'
    ||e.draft_id||e.analysis_result_id||e.published_strategy_version_id)throw failure('BOOTSTRAP_CATEGORY_NOT_ALLOWED');
}
async function inventory(client){
  const database=(await client.query('SELECT current_database() AS name')).rows[0].name;
  const tables=(await client.query("SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2")).rows;
  for(const t of tables)t.count=(await client.query(`SELECT EXISTS(SELECT 1 FROM ${qid(t.schema)}.${qid(t.name)} LIMIT 1) AS populated`)).rows[0].populated?1:0;
  return {database,tables};
}
export async function importSource(client,packet,transportKey,env,expectedDatabase,{dryRun=false}={}){
  if(packet.format!=='ozon-production-source-v2'||!packet.source)throw failure('SEED_FORMAT_INVALID');
  const targetAiKey=await loadAutoListingCredentialKey({env});
  await client.query(dryRun?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE');
  try{
    const allowance={bootstrap:true,queueSchema:env.PG_BOSS_SCHEMA||'sonli_queue'};
    let target=await inventory(client);validateTargetInventory(target,expectedDatabase,allowance);
    if(!target.tables.some(t=>t.schema==='public'&&t.name==='schema_migrations'))throw failure('TARGET_MIGRATIONS_REQUIRED');
    const applied=new Set((await client.query('SELECT version FROM public.schema_migrations')).rows.map(x=>x.version));
    validateTargetMigrations(packet.source.migrations,applied);
    // Only seed destination tables are locked. The configured boss queue's bootstrap metadata is left intact.
    if(!dryRun)await client.query('LOCK TABLE '+[...TABLES,'sessions','audit_events',...CATEGORY_BOOTSTRAP_TABLES].map(t=>'public.'+qid(t)).join(',')+' IN ACCESS EXCLUSIVE MODE');
    target=await inventory(client);validateTargetInventory(target,expectedDatabase,allowance);
    const accounts=(await client.query('SELECT * FROM public.accounts')).rows;
    if(accounts.length!==1||accounts[0].role!=='admin'||accounts[0].username!==(env.SONLI_ADMIN_USERNAME||'admin')||accounts[0].status!=='active')throw failure('BOOTSTRAP_ADMIN_REQUIRED');
    const a=accounts[0],states=(await client.query('SELECT id,state,version FROM public.local_state')).rows;
    if(states.length!==1||states[0].id!=='local-state'||states[0].state.accounts?.length!==1||states[0].state.accounts[0].id!==a.id
      ||states[0].state.stores?.length||Object.keys(states[0].state.jobs||{}).length||states[0].state.pendingObjectDeletions?.length)throw failure('BOOTSTRAP_STATE_NOT_EMPTY');
    validateBootstrapAuth({adminId:a.id,state:states[0].state,
      sessions:(await client.query('SELECT token,account_id FROM public.sessions')).rows,
      audits:(await client.query('SELECT event_id,account_id,actor_id,actor_type,store_id,action,status,source,entity_type,entity_id FROM public.audit_events')).rows});
    validateBootstrapCategorySettings({adminId:a.id,
      settings:(await client.query('SELECT * FROM public.auto_listing_category_strategy_account_settings')).rows,
      events:(await client.query('SELECT * FROM public.auto_listing_category_strategy_events')).rows});
    const stateRow=states[0],admin={...stateRow.state.accounts[0],id:a.id,username:a.username,displayName:a.display_name,role:a.role,status:a.status,
      passwordHash:a.password_hash,passwordSalt:a.password_salt,passwordAlgorithm:a.password_algorithm};
    const result=buildSeed(packet.source,{oldAppKey:transportKey,oldAiKey:Buffer.from(transportKey,'base64url'),oldAiVersion:'seed-transport-v1',
      targetAppKey:env.APP_ENCRYPTION_KEY||env.SONLI_ENCRYPTION_KEY,targetAppVersion:env.APP_ENCRYPTION_KEY_VERSION||'v1',targetAiKey,
      targetAiVersion:env.AUTO_LISTING_CREDENTIAL_KEY_VERSION,admin,bootstrapState:stateRow.state});
    const bundle=result.bundle;
    for(const table of TABLES){
      const rows=bundle.tables[table]||[];if(!rows.length)continue;
      if(table==='local_state'){
        if(dryRun)continue;
        const updated=await client.query('UPDATE public.local_state SET state=$1::jsonb,version=version+1,updated_at=NOW() WHERE id=$2 AND version=$3',[JSON.stringify(rows[0].state),stateRow.id,stateRow.version]);
        if(updated.rowCount!==1)throw failure('BOOTSTRAP_STATE_CHANGED');continue;
      }
      const metadata=(await client.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
      const types=new Map(metadata.map(x=>[x.column_name,x.data_type])),columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
      if(columns.some(column=>!types.has(column)))throw failure('TARGET_SCHEMA_MISMATCH');
      if(dryRun)continue;
      for(let start=0;start<rows.length;start+=250){
        const values=[],sqlRows=rows.slice(start,start+250).map(row=>'('+columns.map(column=>{
          const value=row[column]??null;values.push(['json','jsonb'].includes(types.get(column))&&value!==null?JSON.stringify(value):value);return '$'+values.length;
        }).join(',')+')');
        await client.query(`INSERT INTO public.${qid(table)} (${columns.map(qid).join(',')}) VALUES ${sqlRows.join(',')}`,values);
      }
    }
    await client.query(dryRun?'ROLLBACK':'COMMIT');return {...result.report,mode:dryRun?'DRY_RUN':'IMPORTED'};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{targetAiKey.fill(0);}
}
function argumentsFor(argv){
  const [mode,...flags]=argv,options={};
  for(let i=0;i<flags.length;i+=2){if(!flags[i].startsWith('--')||!flags[i+1]||flags[i+1].startsWith('--'))throw failure('CLI_ARGUMENT_INVALID');options[flags[i].slice(2)]=flags[i+1];}
  return {mode,options};
}
async function main(){
  const {mode,options:o}=argumentsFor(process.argv.slice(2));
  if(!mode||mode==='--help'){console.log('export --source-env FILE --source-ai-key-file FILE --out PRIVATE_DIRECTORY [--store-label NAME]\ndry-run --bundle SOURCE_FILE --target-env PRODUCTION_ENV_OR_process --expect-database NAME [--transport-key-file FILE]\nimport --bundle SOURCE_FILE --target-env PRODUCTION_ENV_OR_process --expect-database NAME [--transport-key-file FILE]\nNo target connection or import occurs in export mode.');return;}
  if(mode==='export'){
    if(!o['source-env']||!o.out)throw failure('EXPORT_ARGUMENTS_REQUIRED');
    const env=await readEnv(o['source-env']);
    if(o['source-ai-key-file']){delete env.AUTO_LISTING_CREDENTIAL_MASTER_KEY;env.AUTO_LISTING_CREDENTIAL_MASTER_KEY_FILE=path.resolve(o['source-ai-key-file']);}
    const oldAiKey=await loadAutoListingCredentialKey({env});
    const client=new pg.Client({...dbConfig(env),options:'-c default_transaction_read_only=on -c statement_timeout=15000'});
    try{
      await client.connect();const source=await readSource(client,o['store-label']||'sl-主店');
      const result=prepareExport(source,{oldAppKey:env.APP_ENCRYPTION_KEY||env.SONLI_ENCRYPTION_KEY,oldAiKey,oldAiVersion:env.AUTO_LISTING_CREDENTIAL_KEY_VERSION});
      await writeSeedFiles(path.resolve(o.out),result);
      console.log(JSON.stringify({ok:true,mode:'EXPORT_ONLY',files:['seed-source.json','seed-transport.key','seed-report.json'],counts:result.report.sourceConfigurationCounts}));
    }finally{await client.end().catch(()=>{});oldAiKey.fill(0);}
  }else if(mode==='import'||mode==='dry-run'){
    if(!o.bundle||!o['target-env']||!o['expect-database'])throw failure('IMPORT_ARGUMENTS_REQUIRED');
    const packet=JSON.parse(await privateFile(o.bundle)),env=o['target-env']==='process'?{...process.env}:await readEnv(o['target-env']);
    const transportKey=(await privateFile(o['transport-key-file']||path.join(path.dirname(o.bundle),'seed-transport.key'))).trim();
    const client=new pg.Client({...dbConfig(env),options:(mode==='dry-run'?'-c default_transaction_read_only=on ':'')+'-c statement_timeout=60000 -c lock_timeout=5000'});
    try{await client.connect();const report=await importSource(client,packet,transportKey,env,o['expect-database'],{dryRun:mode==='dry-run'});console.log(JSON.stringify({ok:true,mode:report.mode,adminPreserved:true,counts:report.counts,pendingWarehouseBindings:report.pendingBindings.length}));}
    finally{await client.end().catch(()=>{});}
  }else throw failure('CLI_MODE_INVALID');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  // pg errors may include entire inserted rows or connection details: never log message/detail/stack.
  const code=/^[A-Z][A-Z_]{4,80}$/.test(error?.code||'')?error.code:'SEED_OPERATION_FAILED';
  console.error(JSON.stringify({ok:false,code}));process.exitCode=1;
});
