import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp, stat, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {encryptSecret, decryptSecret} from '../server/crypto-secrets.mjs';
import {createAutoListingCredentialCipher} from '../server/auto-listing-ai-credential-crypto.mjs';
import {createAccountRecord,createAuthSession} from '../server/account-context.mjs';
import {appendAuditEvent} from '../server/audit-event.mjs';
import {buildSeed, prepareExport, writeSeedFiles, validateTargetInventory, validateTargetMigrations, validateBootstrapAuth, validateBootstrapCategorySettings} from './deploy-seed.mjs';

function inAppKey(key, fn) {
  const old = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = key;
  try { return fn(); } finally { if (old === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = old; }
}
function fixture() {
  const oldAppKey=randomBytes(32).toString('base64url'), oldAiKey=randomBytes(32);
  const storeSecret=randomBytes(30).toString('base64url'), aiSecret=randomBytes(30).toString('base64url');
  const cipher=createAutoListingCredentialCipher({key:oldAiKey,keyVersion:'test-source-v1'});
  const channel={id:'channel-old',account_id:'old-admin',enabled:true,deleted_at:null,name:'Channel',base_url:'https://example.invalid/v1',
    text_model:'',image_model:'image-model',image_protocol:'SUB2API_OPENAI_IMAGES',billing_account:'billing-group',
    credential:cipher.encrypt({accountId:'old-admin',connectionId:'channel-old',connectionVersion:1},aiSecret),
    pricing:{currency:'CNY',unit:'IMAGE',price:'1.23'},connection_check:{status:'AVAILABLE'},capability_check:{status:'PASSED'},
    needs_attention:true,failure_count:8,lease_token:'old-lease',last_error_code:'old-error'};
  return {oldAppKey,oldAiKey,storeSecret,aiSecret,targetAppKey:randomBytes(32).toString('base64url'),targetAiKey:randomBytes(32),
    admin:createAccountRecord({username:'admin',password:randomBytes(30).toString('base64url'),role:'admin'}),source:{
    store:{id:'store-main',label:'sl-主店',owner_account_id:'old-admin',client_id:'seller-identity',currency_code:'RUB',raw:{apiKeyEncrypted:{ciphertext:'stale'}}},
    credential:inAppKey(oldAppKey,()=>encryptSecret(storeSecret)),
    audit:{wallets:0,taskBilling:0,walletEntries:0,messageRecords:0,orders:25,ordersWithFinancialData:10},
    rows:{ai_user_channels:[channel,{...channel,id:'deleted',deleted_at:new Date().toISOString(),enabled:false}],
      ai_listing_presets:[{id:'prompt-old',account_id:'old-admin',kind:'prompts',name:'Saved prompt',payload:{content:'Keep this saved prompt.'}},
        {id:'config-old',account_id:'old-admin',kind:'configs',name:'Saved images',payload:{config:{promptId:'prompt-old',targetStoreId:'test-store',targetWarehouseId:'test-warehouse',manualReview:false,autoSwitchStores:true,fallbackStores:[{targetStoreId:'test-two'}],generationMode:'GRID',image:{ratio:'3:4',quality:'high'},priceMultiplier:'1.125',priceAdjustmentKopecks:123,stock:5,brandMode:'FORCE_NO_BRAND'}}}],
      ozon_message_settings:[{config:{enabled:true,timeZone:'Europe/Moscow',displayName:'Shop',webhookBaseUrl:'https://old.invalid'},state:{syncing:true},webhook_token:'old-webhook'}],
      ozon_message_templates:[{id:'template',body:{enabled:true,trigger:'PICKUP',content:'saved message'}}],
      ozon_promotion_stores:[{config:{enabled:true,exitEnabled:true,protectPrices:true,floors:{'product-external':{price:'128.88',currency:'RUB'}}},snapshot:{products:[{productId:'product-external',currency:'RUB'}],actions:[],memberships:[]}}],
      ozon_promotion_rules:[{id:'rule',body:{enabled:true,name:'Saved rule'},next_run_at:123}],
      platform_product_restrictions:[{id:'restriction',payload:{enabled:true,action:'BLOCK',storeId:'store-main',warehouseId:''}}],
      pricing_config_versions:[{id:'pricing',scope_type:'global',scope_id:'',status:'ACTIVE',version_no:3}],
      pricing_official_imports:[{id:'import',version_id:'pricing',object_key:'tariff.xlsx',object_bucket:'private',sha256:'integrity-ref'}],
      pricing_official_category_mappings:[{id:'mapping',version_id:'pricing',source_import_id:'import',tariff_json:{RFBS:'12.5'}}],
      ozon_product_costs:[{account_id:'old-admin',store_id:'store-main',product_id:'product-external',unit_cost_cny:'18.25',auto_apply:true}],
      products:[{id:'product-local',store_id:'store-main',product_id:'product-external',raw:{}}],
      orders:[{id:'order',store_id:'store-main',posting_number:'real-posting',purchase_costs:{sku:{unitCostCny:'17.88',costSource:'MANUAL'}},raw:{financial_data:{currency_code:'RUB'}}}],
      order_items:[{id:'order-item',order_id:'order',sku:'sku',price:'98.15',currency_code:'RUB'}],
      warehouses:[]},legacy:{},migrations:['132_order_management.sql']}};
}

const options=f=>({oldAppKey:f.oldAppKey,oldAiKey:f.oldAiKey,oldAiVersion:'test-source-v1',targetAppKey:f.targetAppKey,targetAppVersion:'production-existing-v1',targetAiKey:f.targetAiKey,targetAiVersion:'production-existing-v1',admin:f.admin});

test('seed rotates both credential formats and account AAD, retaining values but no old secrets or health',()=>{
  const f=fixture(), out=buildSeed(f.source,options(f)),t=out.bundle.tables;
  const account=f.admin,channel=t.ai_user_channels[0];
  assert.equal(t.accounts.length,0);assert.equal(t.local_state[0].state.accounts[0].id,f.admin.id);
  assert.equal(t.local_state[0].state.accounts[0].passwordHash===f.admin.passwordHash,true);
  assert.equal(out.secrets.APP_ENCRYPTION_KEY===f.targetAppKey,true);
  assert.notEqual(account.id,'old-admin');assert.equal(account.role,'admin');assert.equal(t.ai_user_channels.length,1);
  assert.equal(inAppKey(out.secrets.APP_ENCRYPTION_KEY,()=>decryptSecret(t.store_credentials[0]))===f.storeSecret,true);
  const newCipher=createAutoListingCredentialCipher({key:Buffer.from(out.secrets.AUTO_LISTING_CREDENTIAL_MASTER_KEY,'base64url'),keyVersion:out.secrets.AUTO_LISTING_CREDENTIAL_KEY_VERSION});
  assert.equal(newCipher.decrypt({accountId:account.id,connectionId:channel.id,connectionVersion:1},channel.credential)===f.aiSecret,true);
  assert.throws(()=>newCipher.decrypt({accountId:'old-admin',connectionId:channel.id,connectionVersion:1},channel.credential));
  assert.equal(channel.enabled,false);assert.equal(channel.connection_check,null);assert.equal(channel.capability_check,null);assert.equal(channel.lease_token,null);assert.equal(channel.failure_count,0);
  assert.equal(JSON.stringify(out.bundle).includes(f.aiSecret),false);assert.equal(JSON.stringify(out.bundle).includes(f.storeSecret),false);
  assert.equal(JSON.stringify(out.bundle).includes(f.oldAppKey),false);assert.equal(JSON.stringify(out.bundle).includes('old-lease'),false);
  assert.equal(t.local_state[0].state.sessions && Object.keys(t.local_state[0].state.sessions).length,0);
  assert.equal(t.local_state[0].state.token,'');assert.equal(t.stores[0].raw.apiKeyEncrypted,undefined);
});

test('seed preserves official mappings and real manual money while disabling all automatic behavior',()=>{
  const f=fixture(),out=buildSeed(f.source,options(f)),t=out.bundle.tables;
  const config=t.ai_listing_presets.find(x=>x.kind==='configs').payload.config;
  assert.equal(config.priceMultiplier,'1.125');assert.equal(config.manualReview,true);assert.equal(config.autoSwitchStores,false);
  assert.equal(config.targetStoreId,'store-main');assert.equal(config.targetWarehouseId,'');assert.deepEqual(config.fallbackStores,[]);
  assert.equal(config.promptId,t.ai_listing_presets.find(x=>x.kind==='prompts').id);
  assert.equal(t.pricing_official_category_mappings[0].account_id,undefined);assert.equal(t.pricing_official_category_mappings.length,1);assert.equal(t.pricing_official_imports[0].object_key,'tariff.xlsx');
  assert.equal(t.ozon_product_costs[0].unit_cost_cny,'18.25');assert.equal(t.ozon_product_costs[0].auto_apply,false);
  assert.equal(t.orders[0].purchase_costs.sku.unitCostCny,'17.88');assert.equal(t.order_items[0].currency_code,'RUB');
  assert.equal(t.ozon_promotion_stores[0].config.floors['product-external'].price,'128.88');
  assert.equal(t.ozon_promotion_stores[0].config.enabled,false);assert.equal(t.ozon_promotion_stores[0].config.protectPrices,false);
  assert.equal(t.ozon_promotion_stores[0].sync_requested,false);assert.equal(t.ozon_promotion_rules[0].body.enabled,false);
  assert.equal(t.ozon_message_settings[0].config.enabled,false);assert.deepEqual(t.ozon_message_settings[0].state,{});
  assert.equal(t.ozon_message_templates[0].body.enabled,false);assert.notEqual(t.ozon_message_settings[0].webhook_token,'old-webhook');
  assert.equal(t.platform_product_restrictions[0].payload.enabled,true);
  assert.equal(t.ai_wallet_entries,undefined);assert.equal(t.ai_image_listing_tasks,undefined);assert.equal(t.sessions,undefined);
});

test('existing money or message records require explicit reconciliation instead of being discarded as tests',()=>{
  for(const field of ['wallets','taskBilling','walletEntries','messageRecords']){
    const f=fixture();f.source.audit[field]=1;
    assert.throws(()=>buildSeed(f.source,options(f)),/SOURCE_RECORDS_REQUIRE_RECONCILIATION/);
  }
});

test('only an explicitly named empty target database can accept a seed',()=>{
  assert.throws(()=>validateTargetInventory({database:'old',tables:[]},''),/TARGET_DATABASE_CONFIRMATION_REQUIRED/);
  assert.throws(()=>validateTargetInventory({database:'old',tables:[]},'new'),/TARGET_DATABASE_MISMATCH/);
  assert.throws(()=>validateTargetInventory({database:'new',tables:[{schema:'public',name:'accounts',count:1}]},'new'),/TARGET_NOT_EMPTY/);
  assert.throws(()=>validateTargetInventory({database:'new',tables:[{schema:'sonli_queue',name:'job',count:1}]},'new'),/TARGET_NOT_EMPTY/);
  assert.doesNotThrow(()=>validateTargetInventory({database:'new',tables:[{schema:'public',name:'schema_migrations',count:132},{schema:'public',name:'accounts',count:0}]},'new'));
});

test('private source export leaves production.env intact, is 0600 and refuses overwrites or symlinks',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'deploy-seed-test-'));
  try{
    const f=fixture(),out=prepareExport(f.source,options(f));
    const productionEnv=path.join(dir,'production.env');await writeFile(productionEnv,'existing production configuration',{mode:0o600});
    await writeSeedFiles(dir,out);
    assert.equal(await readFile(productionEnv,'utf8'),'existing production configuration');
    for(const name of ['seed-source.json','seed-transport.key','seed-report.json'])assert.equal((await stat(path.join(dir,name))).mode&0o777,0o600);
    const before=await readFile(path.join(dir,'seed-transport.key'),'utf8');
    await assert.rejects(()=>writeSeedFiles(dir,out));assert.equal((await readFile(path.join(dir,'seed-transport.key'),'utf8'))===before,true);
    const another=await mkdtemp(path.join(dir,'link-'));await writeFile(path.join(another,'untouched'),'original',{mode:0o600});
    await symlink(path.join(another,'untouched'),path.join(another,'seed-transport.key'));
    await assert.rejects(()=>writeSeedFiles(another,out));assert.equal(await readFile(path.join(another,'untouched'),'utf8'),'original');
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('export is independent of production identity; import binds to the already bootstrapped admin and keys',()=>{
  const f=fixture(),packet=prepareExport(f.source,options(f));
  assert.equal(packet.bundle.source.rows.ozon_message_settings[0].webhook_token,undefined);
  assert.equal(packet.bundle.source.rows.ozon_message_settings[0].state,undefined);
  assert.equal(packet.bundle.source.rows.ai_user_channels[0].capability_check,undefined);
  assert.equal(packet.bundle.format,'ozon-production-source-v2');
  const key=Buffer.from(packet.transportKey,'base64url');
  const out=buildSeed(packet.bundle.source,{...options(f),oldAppKey:packet.transportKey,oldAiKey:key,oldAiVersion:'seed-transport-v1'});
  assert.equal(out.bundle.tables.accounts.length,0);
  assert.equal(out.bundle.tables.ai_user_channels[0].account_id,f.admin.id);
  assert.equal(out.bundle.tables.local_state[0].state.accounts[0].passwordHash===f.admin.passwordHash,true);
  const cipher=createAutoListingCredentialCipher({key:f.targetAiKey,keyVersion:'production-existing-v1'}),channel=out.bundle.tables.ai_user_channels[0];
  assert.equal(cipher.decrypt({accountId:f.admin.id,connectionId:channel.id,connectionVersion:1},channel.credential)===f.aiSecret,true);
  assert.equal(JSON.stringify(packet).includes(f.oldAppKey),false);assert.equal(JSON.stringify(packet).includes(f.targetAppKey),false);
  assert.equal(JSON.stringify(packet).includes(f.storeSecret),false);assert.equal(JSON.stringify(packet).includes(f.aiSecret),false);
});

test('a bootstrapped admin and local state are allowed, existing business data and unapproved queue schemas are not',()=>{
  const allowed={bootstrap:true,queueSchema:'ozon_queue'};
  const state={database:'ozon_production',tables:[{schema:'public',name:'accounts',count:1},{schema:'public',name:'local_state',count:1},{schema:'ozon_queue',name:'queue',count:7}]};
  assert.doesNotThrow(()=>validateTargetInventory(state,'ozon_production',allowed));
  assert.throws(()=>validateTargetInventory({...state,tables:[...state.tables,{schema:'public',name:'stores',count:1}]},'ozon_production',allowed),/TARGET_NOT_EMPTY/);
  assert.throws(()=>validateTargetInventory({...state,tables:[...state.tables,{schema:'another_queue',name:'job',count:1}]},'ozon_production',allowed),/TARGET_NOT_EMPTY/);
});


test('dry-run requires explicit target arguments and cannot fall back to the source database',()=>{
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('./deploy-seed.mjs',import.meta.url)),'dry-run'],{encoding:'utf8'});
  assert.equal(cli.status,1);assert.equal(JSON.parse(cli.stderr).code,'IMPORT_ARGUMENTS_REQUIRED');
  const help=spawnSync(process.execPath,[fileURLToPath(new URL('./deploy-seed.mjs',import.meta.url)),'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/dry-run/);
});


test('normal production login sessions and audit are preserved; another account or business audit is refused',()=>{
  const f=fixture(),state={accounts:[f.admin],stores:[],sessions:{},auditEvents:[]};
  const token=createAuthSession(state,f.admin,{headers:{}});
  const event=appendAuditEvent(state,{action:'ACCOUNT_LOGIN',accountId:f.admin.id,actorId:f.admin.id,entityType:'account',entityId:f.admin.id,source:'web'});
  const sessions=[{token,account_id:f.admin.id}],audits=[{event_id:event.eventId,account_id:f.admin.id,actor_id:f.admin.id,actor_type:'account',store_id:null,action:'ACCOUNT_LOGIN',status:'SUCCESS',source:'web',entity_type:'account',entity_id:f.admin.id}];
  const auth={adminId:f.admin.id,state,sessions,audits};
  assert.doesNotThrow(()=>validateBootstrapAuth(auth));
  const out=buildSeed(f.source,{...options(f),bootstrapState:state});
  assert.deepEqual(out.bundle.tables.local_state[0].state.sessions,state.sessions);
  assert.deepEqual(out.bundle.tables.local_state[0].state.auditEvents,state.auditEvents);
  assert.equal(out.bundle.tables.local_state[0].state.token===token,true);
  assert.throws(()=>validateBootstrapAuth({...auth,sessions:[{token,account_id:'another'}]}),/BOOTSTRAP_AUTH_NOT_ALLOWED/);
  assert.throws(()=>validateBootstrapAuth({...auth,audits:[{...audits[0],action:'STORE_BOUND'}]}),/BOOTSTRAP_AUTH_NOT_ALLOWED/);
  assert.throws(()=>validateBootstrapAuth({...auth,audits:[{...audits[0],status:'FAILED'}]}),/BOOTSTRAP_AUTH_NOT_ALLOWED/);
  assert.throws(()=>validateBootstrapAuth({...auth,state:{...state,auditEvents:[{...event,accountId:'another'}]}}),/BOOTSTRAP_AUTH_NOT_ALLOWED/);
  assert.doesNotThrow(()=>validateTargetInventory({database:'ozon_production',tables:[{schema:'public',name:'sessions',count:1},{schema:'public',name:'audit_events',count:1}]},'ozon_production',{bootstrap:true}));
});


test('account trigger settings and its single bootstrap event are retained; changed modes or historical events are refused',()=>{
  const adminId='production-admin',key='category-strategy-settings-bootstrap:'+adminId;
  const base={account_id:adminId,actor_account_id:adminId,idempotency_key:key,correlation_id:key,request_hash:'0'.repeat(64)};
  const settings=[{...base,mode:'LEGACY_FALLBACK',version:'1'}];
  const events=[{...base,id:'category-strategy-settings:'+adminId+':1',event_type:'ACCOUNT_SETTINGS_CHANGED',settings_version:'1',event_payload:{mode:'LEGACY_FALLBACK'},draft_id:null,analysis_result_id:null,published_strategy_version_id:null}];
  assert.doesNotThrow(()=>validateBootstrapCategorySettings({adminId,settings,events}));
  assert.throws(()=>validateBootstrapCategorySettings({adminId,settings:[{...settings[0],version:'2'}],events}),/BOOTSTRAP_CATEGORY_NOT_ALLOWED/);
  assert.throws(()=>validateBootstrapCategorySettings({adminId,settings,events:[...events,events[0]]}),/BOOTSTRAP_CATEGORY_NOT_ALLOWED/);
  assert.throws(()=>validateBootstrapCategorySettings({adminId,settings,events:[{...events[0],actor_account_id:'other'}]}),/BOOTSTRAP_CATEGORY_NOT_ALLOWED/);
  assert.throws(()=>validateBootstrapCategorySettings({adminId,settings,events:[{...events[0],event_type:'PUBLISHED'}]}),/BOOTSTRAP_CATEGORY_NOT_ALLOWED/);
});

test('historical FX migration label requires its current replacement; unknown gaps still fail',()=>{
  assert.doesNotThrow(()=>validateTargetMigrations(['014_dynamic_fx_probes','015_dynamic_fx_probes'],new Set(['015_dynamic_fx_probes'])));
  assert.throws(()=>validateTargetMigrations(['014_dynamic_fx_probes'],new Set()),/TARGET_MIGRATIONS_REQUIRED/);
  assert.throws(()=>validateTargetMigrations(['132_order_management'],new Set(['015_dynamic_fx_probes'])),/TARGET_MIGRATIONS_REQUIRED/);
});
