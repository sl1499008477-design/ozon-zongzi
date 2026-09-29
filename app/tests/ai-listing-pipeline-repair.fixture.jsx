import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AiListingPage from '../src/AiListingPage.jsx';

const request=async(path,options={})=>{
  const response=await fetch('/qa-api'+path,{...options,headers:{'content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.message),{status:response.status,code:data.code});
  return data;
};
createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#065bff',borderRadius:12}}}>
  <main style={{padding:24,maxWidth:1500,margin:'auto'}}><p style={{padding:12,background:'#e6f4ff'}}>本地验收：真实页面、服务与 API 路由；内存数据，外部生图和上架请求使用测试替身。</p>
    <AiListingPage account={{id:'qa-account',role:'admin'}} localData={{stores:[{id:'qa-store',label:'验收店铺',currencyCode:'CNY'}]}} locationSearch="?tab=tasks" request={request}/>
  </main>
</ConfigProvider>);
