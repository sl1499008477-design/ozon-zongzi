import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {AiListingCompletedRecords} from '../src/AiListingPage.jsx';
const request=async(path,options={})=>{
  const response=await fetch('/qa-api'+path,{...options,headers:{'content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.message),{status:response.status});return data;
};
createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><main style={{padding:24,maxWidth:1500,margin:'auto'}}>
  <h1>本机已上架任务恢复验收</h1><AiListingCompletedRecords accountId="qa-account" storeId="qa-store" stores={[{id:'qa-store',label:'验收店铺'}]} request={request}/>
</main></ConfigProvider>);
