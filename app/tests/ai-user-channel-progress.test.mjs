import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';

test('capability progress changes stages while one paid request remains pending, and survives reload',async()=>{
 const vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),logLevel:'silent',server:{host:'127.0.0.1',port:5188,strictPort:false}});
 let browser;let response;let phase=null;let sends=0;
 const channel={id:'c',name:'测试通道',account_id:'a',enabled:true,text_model:'text',image_model:'image'};

 try{
  await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.JZ_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route('**/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/api/local/state')return route.fulfill({json:{account:{id:'a',role:'admin',username:'admin',status:'active'},token:'test-token',binding:null,currentStoreId:'',stores:[],summary:{},caches:{},jobs:{}}});
   if(pathname==='/api/ozon/order-inspection/summary')return route.fulfill({json:{latest:[],unreadCount:0}});
   if(!pathname.includes('/admin/ai-user-channels'))return route.fulfill({json:{}});
   if(route.request().method()==='POST'){sends++;phase='text';response=route;return;}
   await route.fulfill({json:{users:[],channels:[{...channel,active_test:phase?{stage:phase,startedAt:new Date(Date.now()-65000).toISOString()}:null}],requests:[],testSample:{available:true,sample:{name:'固定离线样本',version:'fixture-v1',images:[]},expected:{count:6,width:768,height:1024},image:{ratio:'3:4',language:'ru',quality:'high'},prompt:{version:'fixture-v1',text:'offline fixture'}}}});
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/ozon/settings/ai-user-channels/`);
  await page.getByRole('button',{name:'能力测试',exact:true}).click();await page.getByRole('button',{name:'开始测试（可能产生费用）',exact:true}).click();
  await page.waitForFunction(()=>document.body.innerText.includes('文字测试中'));
  await page.getByRole('dialog').getByText(/旧版文字测试中/).waitFor();
  assert.equal(sends,1);
  phase='image';await page.waitForFunction(()=>document.body.innerText.includes('拼图生图中')&&document.body.innerText.includes('已等待'));
  await page.reload();await page.waitForFunction(()=>document.body.innerText.includes('拼图生图中'));
  assert.equal(sends,1);
  phase=null;await response.fulfill({json:{status:'PASSED'}}).catch(()=>{});
 }finally{await browser?.close();await vite.close();}
});

test('capacity wait reasons and protection countdown agree in the channel table and modal',async()=>{
 const vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),logLevel:'silent',server:{host:'127.0.0.1',port:5188,strictPort:false}});
 let browser;
 const now=Date.parse('2026-09-27T06:00:00.000Z');
 const startedAt=new Date(now-65000).toISOString();
 const check={id:'current-test',type:'GRID_SAMPLE_V1',status:'QUEUED',stage:'queued',startedAt};
 let channel={id:'c',name:'排队测试通道',account_id:'a',enabled:true,text_model:'text',image_model:'image',capability_check:check,
  active_test:{id:'current-test',stage:'waiting_capacity',startedAt:new Date(now-5000).toISOString(),waitReason:'result_unknown',retryAt:new Date(now+61000).toISOString()}};
 try{
  await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.JZ_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage();
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(()=>localStorage.setItem('token','test-token'));
  await page.route('**/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   assert.equal(route.request().method(),'GET','viewing wait reasons must not submit a test');
   if(pathname==='/api/local/state')return route.fulfill({json:{account:{id:'a',role:'admin',username:'admin',status:'active'},token:'test-token',binding:null,currentStoreId:'',stores:[],summary:{},caches:{},jobs:{}}});
   if(pathname==='/api/ozon/order-inspection/summary')return route.fulfill({json:{latest:[],unreadCount:0}});
   if(!pathname.includes('/admin/ai-user-channels'))return route.fulfill({json:{}});
   return route.fulfill({json:{users:[],channels:[channel],requests:[],testSample:{available:true,sample:{name:'固定离线样本',version:'fixture-v1',images:[]},expected:{count:6,width:768,height:1024},image:{ratio:'3:4',language:'ru',quality:'high'},prompt:{version:'fixture-v1',text:'offline fixture'}}}});
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/ozon/settings/ai-user-channels/`);
  const row=page.locator('.ai-user-channel-table tbody tr').filter({hasText:'排队测试通道'});
  const protectedLabel='上一请求结果待核实 · 保护期剩余1分1秒 · 已等待 65 秒';
  await row.getByText(protectedLabel,{exact:true}).waitFor();
  if(process.env.CHANNEL_CAPACITY_QA_DIR)await row.getByRole('cell').filter({hasText:protectedLabel}).screenshot({path:`${process.env.CHANNEL_CAPACITY_QA_DIR}/channel-wait-table.png`,animations:'disabled'});
  await row.getByRole('button',{name:'能力测试',exact:true}).click();
  const dialog=page.getByRole('dialog');
  // AntD can retain an invisible "loading" icon in the accessible name after refresh completes.
  const refreshResult=()=>dialog.getByRole('button',{name:/刷新结果$/}).and(dialog.locator('button:not(.ant-btn-loading)')).click();
  await dialog.getByText(protectedLabel,{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'重新测试（可能产生费用）',exact:true}).isDisabled(),true);
  if(process.env.CHANNEL_CAPACITY_QA_DIR)await dialog.screenshot({path:`${process.env.CHANNEL_CAPACITY_QA_DIR}/channel-wait-modal.png`,animations:'disabled'});
  await page.clock.setFixedTime(new Date(now+2000));
  await row.getByText('上一请求结果待核实 · 保护期剩余0分59秒 · 已等待 67 秒',{exact:true}).waitFor();
  await dialog.getByText('上一请求结果待核实 · 保护期剩余0分59秒 · 已等待 67 秒',{exact:true}).waitFor();
  await page.clock.setFixedTime(new Date(now+61000));
  const expiredLabel='上一请求结果待核实 · 保护期已结束，等待后台更新 · 已等待 126 秒';
  await row.getByText(expiredLabel,{exact:true}).waitFor();
  await dialog.getByText(expiredLabel,{exact:true}).waitFor();
  await page.clock.setFixedTime(new Date(now));
  for(const [waitReason,label] of [
   ['test_queue','等待后台测试执行'],
   ['channel_busy','等待通道当前任务完成'],
   ['billing_busy','等待同计费账号请求名额'],
   ['request_capacity','等待全局请求名额'],
   ['result_unknown','上一请求结果待核实'],
  ]){
   channel={...channel,active_test:{id:'current-test',stage:'waiting_capacity',startedAt,waitReason,retryAt:null}};
   await refreshResult();
   await row.getByText(`${label} · 已等待 65 秒`,{exact:true}).waitFor();
   await dialog.getByText(`${label} · 已等待 65 秒`,{exact:true}).waitFor();
  }
  channel={...channel,active_test:{stage:'image',startedAt,waitReason:'future_reason'}};
  await refreshResult();
  await row.getByText('拼图生图中 · 已等待 65 秒',{exact:true}).waitFor();
  await dialog.getByText('拼图生图中 · 已等待 65 秒',{exact:true}).waitFor();
  channel={...channel,active_test:{id:'previous-test',stage:'waiting_capacity',startedAt,waitReason:'billing_busy'}};
  await refreshResult();
  await row.getByText('等待后台测试执行 · 已等待 65 秒',{exact:true}).waitFor();
  await dialog.getByText('等待后台测试执行 · 已等待 65 秒',{exact:true}).waitFor();
  channel={...channel,active_test:null};
  await refreshResult();
  await row.getByText('等待后台测试执行 · 已等待 65 秒',{exact:true}).waitFor();
  channel={...channel,capability_check:{...check,id:'previous-test',status:'FAILED',stage:'completed',errorCode:'PREVIOUS_TEST_FAILED',checkedAt:new Date(now-100000).toISOString()},active_test:{id:'current-test',stage:'queued',startedAt,waitReason:'test_queue'}};
  await refreshResult();
  await dialog.getByRole('heading',{name:'上次测试结果',exact:true}).waitFor();
  await dialog.getByText('错误码：PREVIOUS_TEST_FAILED',{exact:true}).waitFor();
  assert.equal(await row.getByText('PREVIOUS_TEST_FAILED',{exact:true}).count(),0);
 }finally{await browser?.close();await vite.close();}
});
