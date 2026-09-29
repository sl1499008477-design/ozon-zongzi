import React from 'react';
import {createRoot} from 'react-dom/client';
import {App as AntApp,ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AiListingPage from '../src/AiListingPage.jsx';
import '../src/styles.css';

const groups={active:'QUEUED',paused:'PAUSED',failed:'SUBMISSION_FAILED',errors:'GENERATION_FAILED',cancelled:'CANCELLED',deleted:'CANCELLED'};
const qa=window.batchSelection={account:'A',requests:[],tasks:[],hold:false,pending:[]};
for(const account of ['A','B'])for(const [group,status] of Object.entries(groups)){
  for(let i=0;i<(group==='deleted'?52:2);i++)qa.tasks.push({id:`${account}-${group}-${i}`,sku:`${account}-${group}-${i}`,name:`${account} ${group} 商品 ${i}`,
    accountId:account,group,status,version:i+7,createdAt:'2026-09-18T02:00:00.000Z',images:[],config:{},
    ...(group==='deleted'?{deletedAt:1,taskActions:{resume:true,permanentDelete:true}}:{taskActions:{pause:group==='active',resume:group==='paused'||group==='cancelled',retry:group==='failed'||group==='errors',cancel:group==='active',delete:true}})});
}
const request=async(path,options={})=>{
  qa.requests.push({path,account:qa.account,method:options.method||'GET',body:options.body});
  const query=new URL(path,'http://fixture');
  if(path.startsWith('/ai-listing/tasks?')){
    const group=query.searchParams.get('group'),offset=Number(query.searchParams.get('offset')),rows=qa.tasks.filter(task=>task.accountId===qa.account&&task.group===group&&!['PENDING','RUNNING'].includes(task.purge?.state));
    const counts=Object.fromEntries(Object.keys(groups).map(group=>[group,qa.tasks.filter(task=>task.accountId===qa.account&&task.group===group&&!['PENDING','RUNNING'].includes(task.purge?.state)).length]));
    return {tasks:structuredClone(rows.slice(offset,offset+Number(query.searchParams.get("limit")))),total:rows.length,counts:{...counts,all:10,purging:qa.tasks.filter(task=>task.accountId===qa.account&&['PENDING','RUNNING'].includes(task.purge?.state)).length}};
  }
  const selected=()=>{
    const task=qa.tasks.find(task=>task.id===decodeURIComponent(path.split('/')[3])&&task.accountId===qa.account);
    if(!task)throw Object.assign(new Error('任务不存在'),{status:404});return task;
  };
  if(path.endsWith('/permanent-delete')){
    const task=selected();if(task.version!==options.body.expectedVersion)throw Object.assign(new Error('版本变化'),{status:409});
    if(qa.hold)await new Promise(resolve=>qa.pending.push(resolve));
    task.version++;task.purge={state:'PENDING'};task.taskActions={};return {task:structuredClone(task)};
  }
  if(path==='/ai-listing/tasks/batch/preview'){
    const rows=qa.tasks.filter(task=>task.accountId===qa.account&&task.group===options.body.group);
    return {...options.body,total:rows.length,items:rows.map(task=>({taskId:task.id,expectedVersion:task.version})),skipped:[]};
  }
  if(path==='/ai-listing/tasks/batch/apply'){
    for(const item of options.body.items){
      const task=qa.tasks.find(task=>task.id===item.taskId&&task.accountId===qa.account);
      if(!task||task.version!==item.expectedVersion)throw Error('Unexpected task/version');
      task.version++;task.group=options.body.action==='pause'?'paused':options.body.action==='delete'?'deleted':'active';
      task.status=groups[task.group];task.deletedAt=task.group==='deleted'?Date.now():null;
    }
    return {applied:options.body.items.length,pending:0,skipped:[],errors:[]};
  }
  if(query.pathname.startsWith('/ai-listing/tasks/'))return {task:structuredClone(selected())};
  if(path==='/ai-listing/capabilities')return {grid:{available:true}};
  if(path==='/ai-listing/channels')return {counts:{total:1,idle:1}};
  if(path.startsWith('/ai-listing/presets/'))return {items:[]};
  throw Error(`Unexpected request: ${path}`);
};
function Fixture(){
  const [account,setAccount]=React.useState('A');
  return <ConfigProvider locale={zhCN}><AntApp><main style={{padding:24,maxWidth:1500,margin:'auto'}}>
    <button onClick={()=>{qa.account=account==='A'?'B':'A';setAccount(qa.account);}}>切换验收账号</button>
    <AiListingPage account={{id:account,role:'admin'}} locationSearch="?tab=tasks" request={request}/>
  </main></AntApp></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
