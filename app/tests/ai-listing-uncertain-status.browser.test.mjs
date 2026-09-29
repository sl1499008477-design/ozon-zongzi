import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const picture='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80"%3E%3Crect width="80" height="80" fill="%23e5eefb"/%3E%3C/svg%3E';
const tasks=[
  {id:'unknown-submission',sku:'4157480005',name:'提交结果待核实商品',status:'SUBMISSION_UNCERTAIN',
    skuProgress:[{sku:'4157480005',status:'READY',completed:1,total:1}],
    images:[{sku:'4157480005',index:0,status:'COMPLETED',sourceUrl:picture,generatedUrl:picture}],config:{}},
  {id:'unknown-image',sku:'unknown-image-sku',name:'同组图片待核实商品',status:'GENERATION_FAILED',
    skuProgress:[{sku:'unknown-image-sku',status:'RESULT_UNKNOWN',completed:1,total:3},{sku:'other-sku',status:'PENDING',completed:0,total:1}],
    images:[
      {sku:'unknown-image-sku',index:0,status:'GENERATION_FAILED',sourceUrl:picture,errorMessage:'原请求结果未知'},
      {sku:'unknown-image-sku',index:1,status:'PENDING',sourceUrl:picture},
      {sku:'unknown-image-sku',index:2,status:'COMPLETED',sourceUrl:picture,generatedUrl:picture},
      {sku:'other-sku',index:0,status:'PENDING',sourceUrl:picture},
    ],config:{}},
];
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{AiListingTaskTable}from'/src/AiListingPage.jsx';
const tasks=${JSON.stringify(tasks)};
window.requests=[];const request=async(path)=>{window.requests.push(path);const task=tasks.find(task=>path==='/ai-listing/tasks/'+task.id);
if(!task)throw new Error('Unexpected request in read-only status fixture');
return {task:task.id==='unknown-submission'?{...task,submissionResults:[{sku:task.sku,offerId:'fixture-offer',importStatus:'UNKNOWN',stockStatus:'PENDING'}]}:task};};
createRoot(document.getElementById('root')).render(<AiListingTaskTable tasks={tasks} request={request} pagination={false}/>);`;

test('task list and detail show uncertain submission and same-SKU image waiting without sending a business request',{timeout:30000},async t=>{
  const vite=await createServer({root,configFile:false,logLevel:'silent',plugins:[react(),{
    name:'uncertain-status-fixture',resolveId(id){if(id==='/uncertain-status-entry.jsx')return root+'/uncertain-status-entry.jsx';},
    load(id){if(id===root+'/uncertain-status-entry.jsx')return entry;},
  }],server:{host:'127.0.0.1',port:0,strictPort:false}});
  await vite.listen();t.after(()=>vite.close());
  const browser=await chromium.launch({executablePath:process.env.JZ_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1492,height:1092}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>route.abort());
  await page.route('**/uncertain-status.html',async route=>route.fulfill({contentType:'text/html',
    body:await vite.transformIndexHtml('/uncertain-status.html','<div id="root"></div><script type="module" src="/uncertain-status-entry.jsx"></script>')}));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/uncertain-status.html`);
  await page.getByText('同组图片待核实商品',{exact:true}).waitFor();
  await page.locator('tr[data-row-key="unknown-image"]').getByRole('button',{name:/查\s*看/}).click();
  const detail=page.getByRole('dialog',{name:'任务详情',exact:true});
  const pending=detail.getByRole('button',{name:'放大对比 unknown-image-sku 第 2 张图片',exact:true});
  await pending.waitFor();
  assert.match(await pending.innerText(),/等待同组结果核实/);
  assert.match(await detail.getByRole('button',{name:'放大对比 other-sku 第 1 张图片',exact:true}).innerText(),/等待生图/);
  assert.equal(await detail.getByRole('img',{name:'unknown-image-sku 生成图 3',exact:true}).count(),1);
  await pending.click();
  const comparison=page.getByRole('dialog',{name:'图片对比 · SKU unknown-image-sku · 第 2 张',exact:true});
  await comparison.getByText('等待同组结果核实',{exact:true}).waitFor();
  await comparison.getByRole('button',{name:'Close',exact:true}).click();
  await detail.getByRole('button',{name:'Close',exact:true}).click();
  const submission=page.locator('tr[data-row-key="unknown-submission"]');
  await submission.getByText('提交结果待核实',{exact:true}).waitFor();
  assert.equal(await submission.getByText('待上架',{exact:true}).count(),0);
  await submission.getByRole('button',{name:/查\s*看/}).click();
  await detail.getByText('提交结果待核实',{exact:true}).waitFor();
  assert.equal(await detail.getByText('待上架',{exact:true}).count(),0);
  assert.deepEqual([...new Set(await page.evaluate(()=>window.requests))],['/ai-listing/tasks/unknown-image','/ai-listing/tasks/unknown-submission']);
  assert.deepEqual(errors,[]);
});
