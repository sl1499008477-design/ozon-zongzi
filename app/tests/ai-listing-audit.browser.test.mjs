import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{Form,Input}from'antd';import Presets from '/src/AiListingPresets.jsx';import{AiListingCompletedRecords}from'/src/AiListingPage.jsx';
window.pending=[];window.request=(path)=>new Promise((resolve,reject)=>window.pending.push({path,resolve,reject}));
function Fixture(){const[form]=Form.useForm();const manual=React.useRef(null);const[visible,setVisible]=React.useState(true);const[store,setStore]=React.useState('A');window.form=form;window.setStore=setStore;window.unmountPresets=()=>setVisible(false);return <><Form form={form} onValuesChange={()=>manual.current?.()}>{visible&&<Presets form={form} request={window.request} onManualEditRef={manual} onChange={()=>{}}/>}<Form.Item name="targetStoreId"><Input aria-label="manual store"/></Form.Item></Form><AiListingCompletedRecords accountId="test" storeId={store} request={window.request}/></>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
async function fixture(t){
 const vite=await createServer({root,configFile:false,logLevel:'silent',plugins:[react(),{name:'audit-fixture',resolveId(id){if(id==='/audit-entry.jsx')return root+'/audit-entry.jsx'},load(id){if(id===root+'/audit-entry.jsx')return entry}}],server:{host:'127.0.0.1',port:19090,strictPort:false}});await vite.listen();t.after(()=>vite.close());
 const browser=await chromium.launch({executablePath:process.env.JZ_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage();t.after(async()=>{await browser.close();await vite.close()});
 await page.route('**/audit.html',async r=>r.fulfill({contentType:'text/html',body:await vite.transformIndexHtml('/audit.html','<div id="root"></div><script type="module" src="/audit-entry.jsx"></script>')}));
 await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/audit.html`);await page.waitForFunction(()=>window.pending?.length>=3);
 await page.evaluate(()=>{for(const p of window.pending.splice(0)){if(p.path.endsWith('/prompts'))p.resolve({items:[{id:'p',name:'Prompt',content:'text'}]});else if(p.path.endsWith('/configs'))p.resolve({items:[{id:'A',name:'Config A'},{id:'B',name:'Config B'}]});else p.resolve({tasks:[],total:0})}});
 return page;
}
async function pick(page,name){await page.getByLabel('上架配置版本',{exact:true}).click();await page.getByText(name,{exact:true}).click();}
async function finish(page,id){await page.evaluate(id=>{const p=window.pending.findLast(p=>p.path.endsWith('/configs/'+id));p.resolve({item:{config:{targetStoreId:id,priceAdjustmentKopecks:0,promptId:'p'}}})},id);await page.waitForTimeout(30);await page.evaluate(()=>{for(const p of window.pending.filter(p=>p.path.endsWith('/prompts')||p.path.endsWith('/configs')))p.resolve({items:p.path.endsWith('/configs')?[{id:'A',name:'Config A'},{id:'B',name:'Config B'}]:[{id:'p',content:'text'}]})});await page.waitForTimeout(60);}
test('latest configuration wins and clearing invalidates an in-flight apply',async t=>{
 const page=await fixture(t);await pick(page,'Config A');await pick(page,'Config B');await finish(page,'B');await finish(page,'A');assert.equal(await page.evaluate(()=>window.form.getFieldValue('targetStoreId')),'B');
 await pick(page,'Config A');await page.locator('.ant-select-clear').first().click({force:true});await finish(page,'A');assert.equal(await page.evaluate(()=>window.form.getFieldValue('targetStoreId')),'B');
 await pick(page,'Config A');await page.getByLabel('manual store').fill('manual');await finish(page,'A');assert.equal(await page.evaluate(()=>window.form.getFieldValue('targetStoreId')),'manual');
 await pick(page,'Config B');await page.evaluate(()=>window.unmountPresets());await finish(page,'B');assert.equal(await page.evaluate(()=>window.form.getFieldValue('targetStoreId')),'manual');
});
test('completed records ignore a slower old-store response',async t=>{
 const page=await fixture(t);await page.evaluate(()=>window.setStore('X'));await page.waitForTimeout(30);await page.evaluate(()=>window.setStore('Y'));await page.waitForTimeout(30);
 await page.evaluate(()=>{window.pending.at(-1).resolve({tasks:[{id:'Y',name:'Y商品',status:'COMPLETED',config:{targetStoreId:'Y'},images:[]}],total:1})});await page.getByText('Y商品',{exact:true}).waitFor();
 await page.evaluate(()=>window.pending.at(-2).resolve({tasks:[{id:'X',name:'X商品',status:'COMPLETED',config:{targetStoreId:'X'},images:[]}],total:1}));await page.waitForTimeout(100);assert.equal(await page.getByText('X商品',{exact:true}).count(),0);
});
