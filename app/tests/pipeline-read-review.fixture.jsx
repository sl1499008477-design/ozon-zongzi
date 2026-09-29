import React from 'react';
import {createRoot} from 'react-dom/client';
import {App as AntApp,ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {CollectPage} from '../src/App.jsx';
import AiListingPage,{AiListingTaskTable} from '../src/AiListingPage.jsx';
import '../src/styles.css';

const qa=window.readReview={account:'A',requests:[],navigations:[],pending:[],hold:false,timers:[],hidden:false,detailFailure:null};
qa.deletedTask={id:'deleted',sku:'9024',name:'删除后库存失败商品',version:7,deletedAt:1,status:'SUBMISSION_FAILED',images:[],config:{},
  submissionId:'original-submission',taskActions:{resume:true,permanentDelete:true},submissionRevisions:[{sku:'9024',name:'保留资料',description:'保留简介'}],
  submissionResults:[{sku:'9024',offerId:'original-offer',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['stock failed']}],};
Object.defineProperty(document,'hidden',{configurable:true,get:()=>qa.hidden});
// Visibility in this fixture is controlled by its toggle. Ego focus changes must
// not emit a second contradictory transition while a modal button is clicked.
document.addEventListener('visibilitychange',event=>{if(event.isTrusted)event.stopImmediatePropagation();},true);
const nativeTimeout=window.setTimeout.bind(window);
window.setTimeout=(fn,ms,...args)=>{if(ms>=3000)qa.timers.push(ms);return nativeTimeout(fn,ms,...args);};
const activeCategory={status:'ACTIVE',taxonomyScope:'OZON:DEFAULT',source:'SOURCE_DIRECT',sourceDescriptionCategoryId:10,sourceTypeId:20,
  currentDescriptionCategoryId:30,currentTypeId:40,version:1,validatedAt:null,action:'NONE',message:'使用采集类目准备上架'};
const categories=[activeCategory,{...activeCategory,status:'INVALIDATED',source:'OZON_REFRESH',validatedAt:'2026-08-12T01:02:03.000Z',action:'WAIT',message:'Ozon 类目已失效，正在自动修复'},
  {status:'NEEDS_REVIEW',taxonomyScope:'OZON:DEFAULT',sourceDescriptionCategoryId:null,sourceTypeId:null,currentDescriptionCategoryId:null,currentTypeId:null,
    source:null,version:null,validatedAt:null,action:'REVIEW',message:'无法确认商品类目，请人工选择'},
  {status:'UNKNOWN_VENDOR_STATE',message:'untrusted backend copy must not render'}];
const item=(account,index)=>({id:`${account}-${index}`,sku:`${account}-${index}-a`,name:`${account} 商品 ${index}`,source:'ozon',status:'待处理',price:'555.35',currency:'RUB',
  enrichment:{status:'COMPLETE'},categoryResolution:categories[index%categories.length],
  variants:['a','b'].map(suffix=>({sku:`${account}-${index}-${suffix}`,name:`${account} 规格 ${suffix}`,price:'555.35',currency:'RUB',aspectValues:{size:suffix}}))});
const request=async(path,options={})=>{
  qa.requests.push({path,account:qa.account,method:options.method||'GET',body:options.body});
  if(path.startsWith('/ai-listing/tasks?')){
    const group=new URLSearchParams(path.split('?')[1]).get('group'),present=!!qa.deletedTask,deleted=!!qa.deletedTask?.deletedAt;
    const purging=deleted&&['PENDING','RUNNING'].includes(qa.deletedTask?.purge?.state);
    const tasks=present&&((group==='deleted'&&deleted&&!purging)||(group==='failed'&&!deleted))?[qa.deletedTask]:[];
    return {tasks:structuredClone(tasks),total:tasks.length,counts:{all:present&&!deleted?1:0,active:0,failed:present&&!deleted?1:0,deleted:deleted&&!purging?1:0,purging:purging?1:0}};
  }
  if(path==='/ai-listing/tasks/deleted?includeDeleted=1'){
    if(qa.detailFailure){const error=new Error(qa.detailFailure.message);if(qa.detailFailure.status!==undefined)error.status=qa.detailFailure.status;throw error;}
    if(!qa.deletedTask)throw Object.assign(new Error('任务不存在'),{status:404});
    return {task:structuredClone(qa.deletedTask)};
  }
  const restore=()=>{qa.deletedTask={...qa.deletedTask,deletedAt:null,version:8,taskActions:{retry:true}};return {task:structuredClone(qa.deletedTask)};};
  if(path==='/ai-listing/tasks/deleted/resume'){
    if(options.body?.expectedVersion!==7)throw Error('Fixture expectedVersion mismatch');return restore();
  }
  if(path==='/ai-listing/tasks/deleted/permanent-delete'){
    if(options.body?.expectedVersion!==qa.deletedTask.version)throw Error('Fixture expectedVersion mismatch');
    qa.deletedTask={...qa.deletedTask,version:qa.deletedTask.version+1,
      purge:{state:'PENDING',requestedAt:'2026-09-18T02:00:00.000Z'},taskActions:{}};
    return {task:structuredClone(qa.deletedTask)};
  }
  if(path==='/ai-listing/tasks/batch/preview')return {action:'resume',group:'deleted',total:1,items:[{taskId:'deleted',expectedVersion:7}],skipped:[]};
  if(path==='/ai-listing/tasks/batch/apply'){restore();return {applied:1,pending:0,skipped:[],errors:[]};}
  if(path==='/ai-listing/capabilities')return {grid:{available:true}};
  if(path==='/ai-listing/channels')return {counts:{total:1,idle:1}};
  if(path.startsWith('/ai-listing/presets/'))return {items:[]};
  if(path.startsWith('/ozon/collect-box/summary')){
    const params=new URLSearchParams(path.split('?')[1]);
    const rows=Array.from({length:23},(_,index)=>item(qa.account,index));
    const value={items:rows.slice(Number(params.get('offset')),Number(params.get('offset'))+Number(params.get('limit'))),total:23,counts:{全部:23,待处理:23},sources:['ozon']};
    if(qa.hold)return new Promise(resolve=>qa.pending.push(()=>resolve(value)));
    return value;
  }
  if(path.startsWith('/ozon/collect-box/web-jobs'))return {data:{items:[],total:0}};
  if(path==='/ai-listing/tasks/detail')return {task:{id:'detail',sku:'detail',name:'详情商品',status:qa.taskStatus||'GENERATING',images:[],config:{}}};
  throw Error(`Unmocked request: ${path}`);
};
window.fetch=async(url,options={})=>new Response(JSON.stringify(await request(String(url).replace(/^.*\/api(?=\/)/,''),options)),{status:200,headers:{'content-type':'application/json'}});
function Fixture(){
  const [account,setAccount]=React.useState('A'),[view,setView]=React.useState('collect');
  return <ConfigProvider locale={zhCN}><AntApp><main style={{padding:20}}>
    <div><button onClick={()=>{qa.hold=true;qa.account=account==='A'?'B':'A';setAccount(qa.account);}}>切换账号并延迟响应</button>
      <button onClick={()=>{qa.hold=false;qa.pending.splice(0).forEach(resolve=>resolve());}}>完成延迟读取</button>
      <button onClick={()=>setView(view==='collect'?'tasks':'collect')}>切换测试页面</button>
      <button onClick={()=>setView('deleted')}>已删除任务验收</button>
      <button onClick={()=>{qa.hidden=!qa.hidden;document.dispatchEvent(new Event('visibilitychange'));}}>切换页面可见性</button>
      <span data-testid="account">当前账号 {account}</span></div>
    {view==='collect'?<CollectPage account={{id:account}} hasStore localData={{caches:{collectBox:[]}}} navigate={path=>qa.navigations.push(path)}/>
      :view==='deleted'?<AiListingPage account={{id:account}} locationSearch="?tab=tasks" request={request}/>
      :<AiListingTaskTable tasks={[{id:'detail',sku:'detail',name:'详情商品',status:'GENERATING',images:[],config:{}}]} request={request}/>}
  </main></AntApp></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
