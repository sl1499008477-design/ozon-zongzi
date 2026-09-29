import React from 'react';
import {createRoot} from 'react-dom/client';
import {App as AntApp,ConfigProvider,Layout} from 'antd';
import {ApartmentOutlined,BellOutlined,DownloadOutlined,MenuOutlined,UserOutlined} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import OzonRouteSwitch from '../src/OzonRouteSwitch.jsx';
import '../src/styles.css';

const qa=window.routeQA={account:'a',saved:{a:{route:'CN',revision:0},b:{route:'RU',revision:2}},requests:[],failSave:false,hold:false,pending:[]};
const view=data=>({...data,updatedAt:null,sellerOrigin:`https://seller.${data.route==='CN'?'ozonru.cn':'ozon.ru'}`,apiBase:`https://api-seller.${data.route==='CN'?'ozonru.cn':'ozon.ru'}`});
async function request(path,options={}){
  const account=qa.account;qa.requests.push({account,path,method:options.method||'GET',body:options.body});
  if(new URLSearchParams(location.search).has('http')){
    const response=await fetch(`http://127.0.0.1:19146${path}`,{method:options.method||'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${account}`},body:options.body?JSON.stringify(options.body):undefined});
    const data=await response.json();if(!response.ok)throw Object.assign(Error(data.message),{status:response.status});return data;
  }
  if(path!=='/account/ozon-route')throw Error(`Unexpected request ${path}`);
  if(options.method==='PUT'){
    if(qa.failSave)throw Object.assign(Error('测试：保存失败'),{status:503});
    if(options.body.revision!==qa.saved[account].revision)throw Object.assign(Error('配置已在其他设备更新，请重新选择'),{status:409});
    qa.saved[account]={route:options.body.route,revision:qa.saved[account].revision+1};
  }
  const result=view(qa.saved[account]);
  if(qa.hold)return new Promise(resolve=>qa.pending.push(()=>resolve(result)));
  return result;
}
function Fixture(){const[account,setAccount]=React.useState('a');return <ConfigProvider locale={zhCN}><AntApp>
  <Layout className="qh-shell prototype-shell"><Layout.Header className="qh-topbar">
    <button className="prototype-mobile-menu-trigger" aria-label="打开导航"><MenuOutlined/></button>
    <OzonRouteSwitch key={account} accountId={account} request={request}/>
    <div className="qh-top-actions"><a className="qh-header-action tone-blue" href="#downloads" aria-label="软件下载"><span><DownloadOutlined/></span><div><strong>软件下载</strong><em>扩展与采集助手</em></div></a><button className="qh-header-action tone-orange" aria-label="当前门店"><span><ApartmentOutlined/></span><div><strong>当前门店</strong><em>验收门店</em></div></button><button className="qh-header-action" aria-label="质检提醒"><span><BellOutlined/></span><div><strong>质检提醒</strong><em>暂无提醒</em></div></button><button className="qh-user" aria-label="账户菜单"><UserOutlined/><div><span>当前用户</span><strong>已登录</strong></div></button></div>
  </Layout.Header><main className="qh-content"><h1>账号线路验收</h1><p>当前账号 {account}</p>
    <button onClick={()=>{qa.account=account==='a'?'b':'a';setAccount(qa.account);}}>切换测试账号</button>
    <button onClick={()=>{qa.hold=false;qa.pending.splice(0).forEach(resolve=>resolve());}}>完成延迟请求</button>
  </main></Layout>
</AntApp></ConfigProvider>}
createRoot(document.getElementById('root')).render(<Fixture/>);
