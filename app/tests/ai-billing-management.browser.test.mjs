import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';

const appRoot=fileURLToPath(new URL('..',import.meta.url));
const date='2026-09-13T02:00:00.000Z';
const wallet={account_id:'user-a',username:'tbc123',sku_price_cents:'200',balance_cents:'1200',reserved_cents:'200'};
const charge={id:'entry-charge',account_id:'user-a',username:'tbc123',task_id:'task-a',sku:'sku-a',product:'示例商品',kind:'SKU_CHARGE',amount_cents:'-200',original_amount_cents:'-200',revision:4,voided_at:null,created_at:date};
const cost={id:'request-a',account_id:'user-a',username:'tbc123',task_id:'task-a',product:'示例商品',status:'SUCCEEDED',created_at:date,completed_at:date,estimated_cost_cny:'0.123456',effective_cost_cny:'0.123456',billing_cost_overridden:false,billing_cost_deleted_at:null,billing_revision:2};
const snapshot=()=>({wallets:[{...wallet},{...wallet,account_id:'user-b',username:'other-user',balance_cents:'0',reserved_cents:'0',sku_price_cents:null}],entries:[{...charge}],products:[{account_id:'user-a',username:'tbc123',task_id:'task-a',product:'示例商品',successful_skus:1,charged_cents:'200'}],costs:[{account_id:'user-a',username:'tbc123',task_id:'task-a',product:'示例商品',requests:2,estimated_cny:'0.123456',unpriced:1}],costTotal:{estimated_cny:'0.123456',unpriced:1},history:[{id:'audit-a',action:'price',account_id:'user-a',actor_id:'admin-a',reason:'核对单价',before:{sku_price_cents:null},after:{sku_price_cents:'200'},created_at:date}]});

async function fixture(t,handler,{readonly=false,admin=true}={}){
 const vite=await createServer({root:appRoot,configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,strictPort:false}});
 await vite.listen();
 const executable=[process.env.JZ_BROWSER_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
 assert.ok(executable,'Chrome/Chromium is required for billing management regression');
 const browser=await chromium.launch({executablePath:executable,headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();
 page.setDefaultTimeout(8000);
 const pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.addInitScript(()=>{
  const intervals=new Map();let next=0;
  window.setInterval=(fn,delay)=>{const id=++next;intervals.set(id,{fn,delay});return id;};
  window.clearInterval=id=>intervals.delete(id);
  window.__pollBilling=()=>{for(const {fn,delay} of intervals.values())if(delay===30000)fn();};
 });
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  const handled=await handler?.({route,request,url,page});
  if(handled)return;
  if(url.pathname==='/api/ai-listing/billing'){
   const data=snapshot();
   if(!admin){delete data.costs;delete data.costTotal;delete data.history;data.wallets=[data.wallets[0]];}
   await route.fulfill({status:200,json:data});return;
  }
  await route.fulfill({status:404,json:{message:'未定义的隔离测试接口'}});
 });
 t.after(async()=>{await Promise.allSettled([context.close(),browser.close(),vite.close()]);assert.deepEqual(pageErrors,[]);});
 await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/ai-billing-management.fixture.html${readonly?'?readonly':''}`);
 await page.getByRole('cell',{name:'tbc123',exact:true}).first().waitFor();
 return {page};
}
const walletRow=page=>page.getByRole('region',{name:'用户钱包'}).getByRole('row').filter({has:page.getByRole('cell',{name:'tbc123',exact:true})});
const dialog=page=>page.locator('.ant-modal:visible').last();
async function confirm(page,reason='核对原始记录'){
 await dialog(page).getByRole('textbox',{name:'修改原因'}).fill(reason);
 const response=page.waitForResponse(value=>value.request().method()==='POST');
 await dialog(page).getByRole('button',{name:'确认保存',exact:true}).click();
 await response;
}

test('wallet balance correction keeps the selected account and draft through polling, then ignores an older response',async t=>{
 let data=snapshot(),held=null,hold=false,body;
 const {page}=await fixture(t,async({route,request})=>{
  if(request.method()==='POST'){
   body=request.postDataJSON();data.wallets[0].balance_cents='1500';
   await route.fulfill({status:200,json:{ok:true}});return true;
  }
  if(hold){hold=false;held=route;return true;}
  await route.fulfill({status:200,json:data});return true;
 });
 const row=walletRow(page);
 await row.getByRole('button',{name:'调整余额',exact:true}).click();
 assert.equal(await dialog(page).getByRole('textbox',{name:'调整后余额（元）'}).inputValue(),'12.00');
 assert.match(await dialog(page).innerText(),/预留.*2\.00/);
 await dialog(page).getByRole('textbox',{name:'调整后余额（元）'}).fill('15.00');
 await page.evaluate(()=>window.__pollBilling());
 assert.equal(await dialog(page).getByRole('textbox',{name:'调整后余额（元）'}).inputValue(),'15.00');
 assert.match(await dialog(page).innerText(),/增加.*3\.00/);
 assert.equal(await dialog(page).getByRole('button',{name:'确认保存',exact:true}).isDisabled(),true);
 hold=true;
 const pollSeen=page.waitForRequest(request=>request.method()==='GET'&&new URL(request.url()).pathname==='/api/ai-listing/billing');
 await page.evaluate(()=>window.__pollBilling());await pollSeen;
 await confirm(page,'核对到账余额');
 await row.getByRole('cell',{name:'¥15.00',exact:true}).waitFor();
 assert.equal(body.accountId,'user-a');assert.equal(body.action,'balance');assert.equal(body.amount,'15.00');assert.equal(body.expectedBalanceCents,'1200');assert.equal(body.reason,'核对到账余额');assert.match(body.idempotencyKey,/^[0-9a-f-]{36}$/);
 await held.fulfill({status:200,json:snapshot()});
 await page.evaluate(()=>new Promise(requestAnimationFrame));
 await row.getByRole('cell',{name:'¥15.00',exact:true}).waitFor();
 assert.equal(await row.getByRole('cell',{name:'¥12.00',exact:true}).count(),0);
});

test('price editing pre-fills the saved price and clearing requires a reason without removing the user',async t=>{
 let data=snapshot(),bodies=[];
 const {page}=await fixture(t,async({route,request})=>{
  if(request.method()==='POST'){
   const body=request.postDataJSON();bodies.push(body);
   data.wallets[0].sku_price_cents=body.action==='price'?'250':null;
   await route.fulfill({status:200,json:{ok:true}});return true;
  }
  await route.fulfill({status:200,json:data});return true;
 });
 await walletRow(page).getByRole('button',{name:'修改单价',exact:true}).click();
 assert.equal(await dialog(page).getByRole('textbox',{name:'每 SKU 单价（元）'}).inputValue(),'2.00');
 await dialog(page).getByRole('textbox',{name:'每 SKU 单价（元）'}).fill('2.50');
 await dialog(page).getByRole('button',{name:'确认保存',exact:true}).click();
 await walletRow(page).getByRole('cell',{name:'¥2.50',exact:true}).waitFor();
 await walletRow(page).getByRole('button',{name:'清除单价',exact:true}).click();
 assert.equal(await dialog(page).getByRole('button',{name:'确认保存',exact:true}).isDisabled(),true);
 await confirm(page,'暂停后续 SKU 定价');
 await walletRow(page).getByRole('cell',{name:'未设置',exact:true}).waitFor();
 assert.equal(bodies[0].expectedPriceCents,'200');assert.equal(bodies[1].expectedPriceCents,'250');
 assert.equal(bodies[1].action,'clear_price');assert.equal(bodies[1].reason,'暂停后续 SKU 定价');
 assert.equal(await walletRow(page).count(),1);
});

test('a topup with a lost response retains its intent when retried or its note is edited',async t=>{
 const bodies=[];
 const {page}=await fixture(t,async({route,request})=>{
  if(request.method()==='POST'){
   bodies.push(request.postDataJSON());
   await route.fulfill({status:bodies.length<3?503:409,json:{message:bodies.length<3?'充值结果暂未确认，请重试核对':'该操作已经入账，请关闭弹窗核对记录后再操作'}});return true;
  }
 });
 await walletRow(page).getByRole('button',{name:'充值',exact:true}).click();
 await dialog(page).getByRole('textbox',{name:'充值金额（元）'}).fill('10.00');
 await dialog(page).getByRole('button',{name:'确认保存',exact:true}).click();
 await dialog(page).getByText('充值结果暂未确认，请重试核对',{exact:true}).waitFor();
 const retried=page.waitForResponse(response=>response.request().method()==='POST');
 await dialog(page).getByRole('button',{name:'确认保存',exact:true}).click();await retried;
 assert.equal(bodies.length,2);assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);
 await dialog(page).getByRole('textbox',{name:'修改原因'}).fill('补充到账凭据');
 await dialog(page).getByRole('button',{name:'确认保存',exact:true}).click();
 await dialog(page).getByText('该操作已经入账，请关闭弹窗核对记录后再操作',{exact:true}).waitFor();
 assert.equal(bodies[2].idempotencyKey,bodies[0].idempotencyKey);
 assert.equal(bodies[2].reason,'补充到账凭据');
 assert.equal(await page.locator('.ant-modal:visible').count(),1);
});

test('a successful correction followed by a read failure is reported as saved and cannot resubmit',async t=>{
 let saved=false,posts=0;
 const {page}=await fixture(t,async({route,request})=>{
  if(request.method()==='POST'){saved=true;posts+=1;await route.fulfill({status:200,json:{ok:true}});return true;}
  if(saved){await route.fulfill({status:503,json:{message:'账本刷新暂不可用'}});return true;}
 });
 await walletRow(page).getByRole('button',{name:'充值',exact:true}).click();
 await dialog(page).getByRole('textbox',{name:'充值金额（元）'}).fill('10.00');
 await dialog(page).getByRole('button',{name:'确认保存',exact:true}).click();
 await page.getByText(/已保存，但费用记录刷新失败.*账本刷新暂不可用/).waitFor();
 await page.locator('.ant-modal:visible').waitFor({state:'hidden'});
 await page.getByRole('button',{name:/刷新费用记录/}).click();
 assert.equal(posts,1);
});

test('a saved record correction reports refresh failure inside the remaining records dialog',async t=>{
 let saved=false;
 const {page}=await fixture(t,async({route,request,url})=>{
  if(request.method()==='POST'){saved=true;await route.fulfill({status:200,json:{ok:true}});return true;}
  if(url.pathname.endsWith('/records')){
   await route.fulfill(saved?{status:503,json:{message:'分页记录暂不可用'}}:{status:200,json:{items:[charge],total:1,page:1,pageSize:20}});return true;
  }
 });
 await page.getByRole('button',{name:'管理收费',exact:true}).click();
 await dialog(page).getByRole('button',{name:'修改',exact:true}).click();
 await dialog(page).getByRole('textbox',{name:'记录金额（元）'}).fill('1.50');await confirm(page);
 await dialog(page).getByText(/已保存，但费用记录刷新失败.*分页记录暂不可用/).waitFor();
 assert.equal(await dialog(page).getByRole('textbox',{name:'记录金额（元）'}).count(),0);
});

test('product ledger management scopes records and edits, deletes, and restores the source charge revision',async t=>{
 let record={...charge};const bodies=[],queries=[];
 const {page}=await fixture(t,async({route,request,url})=>{
  if(request.method()==='POST'){
   const body=request.postDataJSON();bodies.push(body);
   if(body.action==='edit_entry')record.amount_cents=body.amount==='0.00'?'0':'-150';
   if(body.action==='delete_entry')record.voided_at=date;
   if(body.action==='restore_entry')record.voided_at=null;
   record.revision+=1;
   await route.fulfill({status:200,json:{ok:true}});return true;
  }
  if(url.pathname.endsWith('/records')){
   queries.push(Object.fromEntries(url.searchParams));
   const items=Boolean(record.voided_at)===(url.searchParams.get('deleted')==='true')?[record]:[];
   await route.fulfill({status:200,json:{items,total:items.length,page:1,pageSize:20}});return true;
  }
  const data=snapshot();data.entries=[record];await route.fulfill({status:200,json:data});return true;
 });
 await page.getByRole('button',{name:'管理收费',exact:true}).click();
 await dialog(page).getByRole('cell',{name:'sku-a',exact:true}).waitFor();
 assert.equal(queries[0].accountId,'user-a');assert.equal(queries[0].taskId,'task-a');assert.equal(queries[0].type,'wallet');assert.equal(queries[0].deleted,'false');
 await dialog(page).getByRole('button',{name:'修改',exact:true}).click();
 assert.equal(await dialog(page).getByRole('textbox',{name:'记录金额（元）'}).inputValue(),'2.00');
 await dialog(page).getByRole('textbox',{name:'记录金额（元）'}).fill('1.50');await confirm(page);
 await dialog(page).getByRole('cell',{name:'¥-1.50',exact:true}).waitFor();
 await dialog(page).getByRole('button',{name:'修改',exact:true}).click();
 await dialog(page).getByRole('textbox',{name:'记录金额（元）'}).fill('0.00');
 await confirm(page,'免除本条生图收费');
 await dialog(page).getByRole('cell',{name:'¥0.00',exact:true}).waitFor();
 await dialog(page).getByRole('button',{name:'删除',exact:true}).click();await confirm(page,'撤销错误扣费');
 await dialog(page).getByRole('switch',{name:'查看已删除'}).click();
 await dialog(page).getByRole('button',{name:'恢复',exact:true}).click();await confirm(page,'确认恢复原扣费');
 assert.deepEqual(bodies.map(x=>[x.action,x.revision]),[['edit_entry',4],['edit_entry',5],['delete_entry',6],['restore_entry',7]]);
 assert.equal(bodies[0].amount,'1.50');assert.equal(bodies[1].amount,'0.00');assert.ok(bodies.every(x=>x.accountId==='user-a'&&x.entryId==='entry-charge'));
});

test('cost management exposes paginated records, blocks running requests, and preserves unknown cost separately from zero',async t=>{
 let record={...cost},deleted=false;const bodies=[],queries=[];
 const {page}=await fixture(t,async({route,request,url})=>{
  if(request.method()==='POST'){
   const body=request.postDataJSON();bodies.push(body);
   if(body.action==='edit_cost'){record.effective_cost_cny=body.amount;record.billing_cost_overridden=true;}
   if(body.action==='delete_cost')deleted=true;
   if(body.action==='restore_cost')deleted=false;
   record.billing_cost_deleted_at=deleted?date:null;record.billing_revision+=1;
   await route.fulfill({status:200,json:{ok:true}});return true;
  }
  if(url.pathname.endsWith('/records')){
   const query=Object.fromEntries(url.searchParams);queries.push(query);
   let items=query.page==='2'?[{...record,id:'request-page-two',product:'第二页商品'}]:[record,{...cost,id:'request-running',status:'STARTED',completed_at:null}];
   if((query.deleted==='true')!==deleted)items=[];
   await route.fulfill({status:200,json:{items,total:items.length?21:0,page:Number(query.page),pageSize:20}});return true;
  }
 });
 await page.getByRole('button',{name:'管理明细',exact:true}).click();
 const running=dialog(page).getByRole('row').filter({hasText:'进行中'});
 await running.waitFor();
 await dialog(page).getByText('成功',{exact:true}).waitFor();
 assert.equal(await running.getByRole('button',{name:'修改',exact:true}).isDisabled(),true);
 assert.equal(await running.getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
 await dialog(page).getByRole('button',{name:'修改',exact:true}).first().click();
 assert.equal(await dialog(page).getByRole('textbox',{name:'估算成本（元）'}).inputValue(),'0.123456');
 await dialog(page).getByRole('checkbox',{name:'金额待核实'}).check();await confirm(page);
 assert.equal(bodies[0].amount,null);assert.equal(bodies[0].revision,2);
 await dialog(page).getByRole('button',{name:'修改',exact:true}).first().click();
 await dialog(page).getByRole('checkbox',{name:'金额待核实'}).uncheck();
 await dialog(page).getByRole('textbox',{name:'估算成本（元）'}).fill('0.000001');await confirm(page);
 assert.equal(bodies[1].amount,'0.000001');assert.equal(bodies[1].revision,3);
 await dialog(page).getByRole('button',{name:'删除',exact:true}).first().click();await confirm(page);
 await dialog(page).getByRole('switch',{name:'查看已删除'}).click();
 await dialog(page).getByRole('button',{name:'恢复',exact:true}).first().click();await confirm(page);
 assert.deepEqual(bodies.slice(2).map(x=>x.action),['delete_cost','restore_cost']);
 await dialog(page).getByRole('switch',{name:'查看已删除'}).click();
 await dialog(page).locator('.ant-pagination-item-2').click();
 await dialog(page).getByRole('cell',{name:'第二页商品',exact:true}).waitFor();
 assert.equal(queries.at(-1).page,'2');assert.equal(queries[0].accountId,'user-a');assert.equal(queries[0].taskId,'task-a');
 await page.setViewportSize({width:390,height:844});
 const bounds=await dialog(page).boundingBox();assert.ok(bounds.x>=15&&bounds.x+bounds.width<=375);
});

test('billing views remain read only for ordinary users and administrator read-only panels',async t=>{
 for(const admin of [false,true]){
  const {page}=await fixture(t,null,{readonly:true,admin});
  for(const name of ['修改单价','清除单价','调整余额','充值','管理收费','管理明细','修改','删除','恢复'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name);
 }
});
