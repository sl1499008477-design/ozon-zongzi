import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const tasks=[
  {id:'partial',sku:'fixture-a',name:'部分创建商品',status:'SUBMITTED',createdSkuCount:1,totalSkuCount:3,
    completedSkuCount:0,quotaWait:{code:'DAILY_LIMIT',required:2},images:[],config:{targetStoreId:'fixture-store'}},
  {id:'target',sku:'fixture-b',name:'目标待确认商品',status:'GENERATING',generationStage:'waiting_target',
    submissionWait:{code:'TARGET_UNAVAILABLE',retryAt:Date.parse('2026-09-28T00:05:00Z')},images:[],config:{targetStoreId:'fixture-store'}},
];
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{AiListingTaskTable}from'/src/AiListingPage.jsx';
window.requests=[];const request=async(path)=>{window.requests.push(path);throw new Error('Unexpected request in read-only status fixture');};
createRoot(document.getElementById('root')).render(<AiListingTaskTable tasks={${JSON.stringify(tasks)}} request={request} pagination={false}/>);`;

test('the actual task table renders partial creation and target waiting without any business request',{timeout:30000},async t=>{
  const vite=await createServer({root,configFile:false,logLevel:'silent',plugins:[react(),{
    name:'quota-status-fixture',resolveId(id){if(id==='/quota-status-entry.jsx')return root+'/quota-status-entry.jsx';},
    load(id){if(id===root+'/quota-status-entry.jsx')return entry;},
  }],server:{host:'127.0.0.1',port:0,strictPort:false}});
  await vite.listen();t.after(()=>vite.close());
  const browser=await chromium.launch({executablePath:process.env.JZ_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1492,height:1092}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>route.abort());
  await page.route('**/quota-status.html',async route=>route.fulfill({contentType:'text/html',
    body:await vite.transformIndexHtml('/quota-status.html','<div id="root"></div><script type="module" src="/quota-status-entry.jsx"></script>')}));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/quota-status.html`);
  const partial=page.getByText('已创建 1/3，剩余 2 个等待每日额度',{exact:true});
  await partial.waitFor();assert.equal(await partial.count(),1);
  const target=page.getByText('店铺或仓库待确认',{exact:true});await target.waitFor();await target.hover();
  const tooltip=page.getByRole('tooltip');await tooltip.waitFor();
  assert.match(await tooltip.innerText(),/重新检查.*店铺.*仓库/);
  assert.doesNotMatch(await tooltip.innerText(),/确认额度|额度不足/);
  assert.deepEqual(await page.evaluate(()=>window.requests),[]);
  assert.deepEqual(errors,[]);
});
