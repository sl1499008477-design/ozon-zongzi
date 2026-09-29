import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const loader = new URL('./fixtures/desktop-module-loader.mjs', import.meta.url).href;
const run = body => execFileSync(process.execPath, ['--loader', loader, '--input-type=module', '-e', `
 import assert from 'node:assert/strict';
 import { operationStore } from './desktop/dist-electron/store/index.js';
 import { listCollectorFilterPresets, saveCollectorFilterPreset } from './desktop/dist-electron/services/collector-filter-presets.services.js';
 import * as presets from './desktop/dist-electron/services/collector-filter-presets.services.js';
 operationStore.set('token','fixture-token'); operationStore.set('user',{id:'account-a'});
 ${body}
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });

test('saved black-price ranges retain their CNY basis and cannot turn into Seller RUB ranges', () => {
 run(`
 const saved=saveCollectorFilterPreset({name:'人民币黑标价',filters:{salePriceBasis:'storefrontCny',salePriceMin:100,salePriceMax:150}}).item;
 assert.equal(listCollectorFilterPresets().items[0].filters.salePriceBasis,'storefrontCny');
 const updated=presets.updateCollectorFilterPreset({id:saved.id,name:saved.name,filters:{...saved.filters,salePriceMax:200}}).item;
 assert.equal(updated.filters.salePriceBasis,'storefrontCny');
 assert.equal(updated.filters.salePriceMax,200);
 assert.throws(()=>saveCollectorFilterPreset({name:'未知币种',filters:{salePriceBasis:'unknown'}}),/价格/);
 `);
});

test('presets preserve numeric boundaries and discrete filters and exclude unrelated task fields', () => {
 run(`
 const first = saveCollectorFilterPreset({ name: '  轻小件  ', filters: { soldCountMin: 0, soldCountMax: 50, ratingMin: '4.5', monthDynamicsMin: -50, monthDynamicsMax: 250, weightRangeMax: 500, brandType: '1', salesSchema: 'FBO,FBS', packageWidthMin: null, taskName: 'not stored', token: 'not stored', autoStartAiGeneration: true } });
 assert.equal(first.item.name,'轻小件');
 assert.deepEqual(first.item.filters, { soldCountMin: 0, soldCountMax: 50, ratingMin: 4.5, monthDynamicsMin: -50, monthDynamicsMax: 250, weightRangeMax: 500, brandType: '1', salesSchema: 'FBO,FBS' });
 assert.deepEqual(listCollectorFilterPresets().items,[first.item]);
 `);
});

test('duplicate names and invalid saved ranges leave existing conditions intact', () => {
 run(`
 const first = saveCollectorFilterPreset({name:'常用',filters:{brandType:'2',soldCountMin:0}});
 assert.throws(()=>saveCollectorFilterPreset({name:' 常用 ',filters:{soldCountMin:10}}), /同名/);
 for(const filters of [{soldCountMin:10,soldCountMax:0},{soldCountMin:'wrong'},{ratingMax:Infinity},{brandType:'wrong'},{salesSchema:'wrong'}]) assert.throws(()=>saveCollectorFilterPreset({name:'错误',filters}));
 assert.throws(()=>saveCollectorFilterPreset({name:' ',filters:{}}));
 assert.deepEqual(listCollectorFilterPresets().items,[first.item]);
 `);
});

test('local presets belong to current account and survive logout without leaking to another account', () => {
 run(`
 const a=saveCollectorFilterPreset({name:'账号A方案',filters:{soldCountMin:5}}).item;
 operationStore.set('user',{id:'account-b'});
 assert.deepEqual(listCollectorFilterPresets().items,[]);
 const b=saveCollectorFilterPreset({name:'账号A方案',accountId:'account-a',filters:{soldCountMin:9}}).item;
 assert.equal(listCollectorFilterPresets().items[0].id,b.id);
 operationStore.delete('token');assert.throws(()=>listCollectorFilterPresets(),/登录/);
 operationStore.set('token','fixture-token');operationStore.set('user',{id:'account-a'});
 assert.deepEqual(listCollectorFilterPresets().items,[a]);
 operationStore.set('user',{});assert.throws(()=>saveCollectorFilterPreset({name:'无账号',filters:{}}),/登录/);
 `);
});


test('renderer storage cannot impersonate another account when reading local presets', () => {
 run(`
 const { storeIpc } = await import('./desktop/dist-electron/ipc/store.ipc.js');
 const saved = saveCollectorFilterPreset({name:'A',filters:{}}).item;
 operationStore.set('user',{id:'account-b'});operationStore.set('token','token-b');
 storeIpc();const handlers=globalThis.__DESKTOP_IPC_HANDLERS__;
 for(const key of ['user','token',['user'],['token']]) {
   assert.throws(()=>handlers.get('store-set')(null,key,key==='user'?{id:'account-a'}:'token-a'));
   assert.throws(()=>handlers.get('store-delete')(null,key));
 }
 assert.deepEqual(listCollectorFilterPresets().items,[]);
 handlers.get('store-set')(null,'loginInfo',{phone:'fixture-user'});
 assert.equal(handlers.get('store-get')(null,'loginInfo').phone,'fixture-user');
 assert.equal(handlers.get('store-get')(null,'user').id,'account-b');
 `);
});

test('login and account refresh keep identity authoritative in main and ignore stale sessions', () => {
 run(`
 const { login, getUserInfo } = await import('./desktop/dist-electron/services/account.services.js');
 globalThis.__DESKTOP_AXIOS_REQUESTS__=[];
 globalThis.__DESKTOP_AXIOS_HANDLER__=config=>({data:{token:'token-new',account:{id:'account-new',username:'new'}}});
 assert.equal((await login({username:'fixture',password:'fixture'})).code,0);
 assert.equal(globalThis.__DESKTOP_AXIOS_REQUESTS__.at(-1).url,'/local/accounts/login?view=bootstrap');
 assert.equal(operationStore.get('token'),'token-new');
 assert.equal(operationStore.get('user').id,'account-new');
 let seen,resolve;
 globalThis.__DESKTOP_AXIOS_HANDLER__=config=>{seen=config.headers.Authorization;return {data:{account:{id:'account-new'}}}};
 assert.equal((await getUserInfo({token:'wrong-renderer-token'})).code,0);
 assert.equal(globalThis.__DESKTOP_AXIOS_REQUESTS__.at(-1).url,'/local/state?view=bootstrap');
 assert.equal(seen,'Bearer token-new');
 globalThis.__DESKTOP_AXIOS_HANDLER__=()=>new Promise(r=>{resolve=r});
 const refresh=getUserInfo();await new Promise(r=>setImmediate(r));
 operationStore.set('token','token-other');operationStore.set('user',{id:'account-other'});
 resolve({data:{account:{id:'account-new'}}});await refresh;
 assert.equal(operationStore.get('user').id,'account-other');
 assert.equal(operationStore.get('token'),'token-other');
 `);
});

test('editing an existing preset replaces its name and conditions without duplicating or retaining removed limits', () => {
 run(`
 const original=saveCollectorFilterPreset({name:'轻小件',filters:{soldCountMin:10,ratingMin:4,brandType:'1'}}).item;
 const other=saveCollectorFilterPreset({name:'另一个',filters:{soldCountMin:99}}).item;
 assert.equal(typeof presets.updateCollectorFilterPreset,'function','saved presets need an update operation');
 const updated=presets.updateCollectorFilterPreset({id:original.id,name:'  轻小件新版  ',filters:{soldCountMin:0,monthDynamicsMin:-50,brandType:'2',salesSchema:'FBS',taskName:'do not store'}});
 assert.equal(updated.item.id,original.id);
 assert.equal(updated.item.createdAt,original.createdAt);
 assert.ok(updated.item.updatedAt);
 assert.equal(updated.item.name,'轻小件新版');
 assert.deepEqual(updated.item.filters,{soldCountMin:0,monthDynamicsMin:-50,brandType:'2',salesSchema:'FBS'});
 assert.deepEqual(listCollectorFilterPresets().items,[other,updated.item]);
 `);
});

test('invalid edits and duplicate names cannot overwrite a saved preset', () => {
 run(`
 const original=saveCollectorFilterPreset({name:'A',filters:{soldCountMin:10}}).item;
 saveCollectorFilterPreset({name:'B',filters:{}});
 assert.equal(typeof presets.updateCollectorFilterPreset,'function');
 const before=listCollectorFilterPresets();
 assert.throws(()=>presets.updateCollectorFilterPreset({id:original.id,name:'B',filters:{}}),/同名/);
 assert.throws(()=>presets.updateCollectorFilterPreset({id:original.id,name:'A',filters:{soldCountMin:5,soldCountMax:0}}),/最小值/);
 assert.deepEqual(listCollectorFilterPresets(),before);
 const sameName=presets.updateCollectorFilterPreset({id:original.id,name:'A',filters:{soldCountMin:12}});
 assert.equal(sameName.item.filters.soldCountMin,12);
 `);
});

test('deleting a saved preset removes only that preset and a stale edit cannot recreate it', () => {
 run(`
 const first=saveCollectorFilterPreset({name:'A',filters:{soldCountMin:0}}).item;
 const kept=saveCollectorFilterPreset({name:'B',filters:{soldCountMax:50}}).item;
 assert.equal(typeof presets.deleteCollectorFilterPreset,'function','saved presets need a delete operation');
 assert.deepEqual(presets.deleteCollectorFilterPreset({id:first.id}).items,[kept]);
 assert.deepEqual(listCollectorFilterPresets().items,[kept]);
 assert.throws(()=>presets.updateCollectorFilterPreset({id:first.id,name:'A',filters:{}}),/不存在/);
 assert.deepEqual(listCollectorFilterPresets().items,[kept]);
 `);
});

test('preset updates and deletes stay within the authenticated main-process account', () => {
 run(`
 const a=saveCollectorFilterPreset({name:'A',filters:{soldCountMin:5}}).item;
 operationStore.set('user',{id:'account-b'});
 const b=saveCollectorFilterPreset({name:'B',filters:{soldCountMin:9}}).item;
 assert.equal(typeof presets.updateCollectorFilterPreset,'function');
 assert.equal(typeof presets.deleteCollectorFilterPreset,'function');
 assert.throws(()=>presets.updateCollectorFilterPreset({id:a.id,accountId:'account-a',name:'变更',filters:{}}),/不存在/);
 assert.throws(()=>presets.deleteCollectorFilterPreset({id:a.id,accountId:'account-a'}),/不存在/);
 assert.deepEqual(listCollectorFilterPresets().items,[b]);
 operationStore.set('user',{id:'account-a'});assert.deepEqual(listCollectorFilterPresets().items,[a]);
 operationStore.delete('token');
 assert.throws(()=>presets.updateCollectorFilterPreset({id:a.id,name:'变更',filters:{}}),/登录/);
 assert.throws(()=>presets.deleteCollectorFilterPreset({id:a.id}),/登录/);
 `);
});
