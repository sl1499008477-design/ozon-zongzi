import React from 'react';
import {createRoot} from 'react-dom/client';
import {App as AntApp,ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {CollectPage} from '../src/App.jsx';
import PromotionManagementPage from '../src/PromotionManagementPage.jsx';
import '../src/styles.css';

localStorage.setItem('token','local-fixture-only');
const qa=window.unifiedQA={requests:[],navigations:[],account:'qa-owner'};
const product=(id,sku,status='待处理')=>({id,sku,name:`已采集商品 ${sku}`,status,source:'ozon',price:'100.00',currency:'RUB',createdAt:'2026-09-23T01:00:00Z',
  enrichment:{status:'COMPLETE'},categoryResolution:{status:'ACTIVE'},variants:[],selectable:status!=='已上架'});
qa.products=Array.from({length:7},(_,i)=>product(`collect_${i}`,String(10000+i)));
qa.listed=[product('collect_listed','5145368340','已上架')];
qa.jobs=[{id:'wc_running',sku:'547133456',scope:'ALL',status:'PROCESSING',message:'正在读取变体资料'},
  {id:'wc_failed',sku:'3000',scope:'CURRENT',status:'FAILED',message:'商品页面需要验证',errorCode:'CAPTURE_FAILED'}];
const summary=params=>{
  let all=[...qa.jobs.map(job=>({id:job.id,sku:job.sku,name:`SKU ${job.sku}`,source:'ozon',createdAt:'2026-09-23T02:00:00Z',
    status:['FAILED','WAITING'].includes(job.status)?'失败':job.status==='CANCELLED'?'已跳过':'待处理',variants:[],selectable:false,webCollectionJob:job})),...qa.products];
  const counts={全部:all.length,待处理:all.filter(x=>x.status==='待处理').length,失败:all.filter(x=>x.status==='失败').length,已跳过:all.filter(x=>x.status==='已跳过').length,已上架:qa.listed.length};
  const status=params.get('status'),variant=params.get('variant');if(status==='已上架')all=qa.listed;else if(status&&status!=='全部')all=all.filter(x=>x.status===status);
  if(variant)all=all.filter(x=>variant==='多变体'?x.variants.length>1:!x.webCollectionJob||x.webCollectionJob.scope==='CURRENT');
  const offset=Number(params.get('offset')),limit=Number(params.get('limit'));
  return {items:structuredClone(all.slice(offset,offset+limit)),total:all.length,counts,sources:['ozon'],hasActiveWebJobs:qa.jobs.some(j=>['QUEUED','PROCESSING','WAITING'].includes(j.status))};
};
window.fetch=async(url,options={})=>{
  const path=String(url).replace(/^.*\/api(?=\/)/,''),body=options.body?JSON.parse(options.body):{};qa.requests.push({path,method:options.method||'GET',body});let value;
  if(path.startsWith('/ozon/collect-box/summary'))value=summary(new URLSearchParams(path.split('?')[1]));
  else if(path==='/ozon/collect-box/web-jobs'&&options.method==='POST'){
    const job={id:'wc_added',...body,status:'QUEUED',message:'等待扩展领取'};qa.jobs.unshift(job);value={data:job};
  }else if(/^\/ozon\/collect-box\/web-jobs\/.+\/(retry|cancel)$/.test(path)){
    const [,id,action]=path.match(/web-jobs\/([^/]+)\/(retry|cancel)$/);const job=qa.jobs.find(j=>j.id===id);
    job.status=action==='retry'?'PROCESSING':'CANCELLED';job.message=action==='retry'?'正在继续采集':'任务已取消';value={data:job};
  }else throw Error(`unexpected fixture request: ${path}`);
  return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
};
const overview={settings:{enabled:false,timeZone:'Asia/Shanghai'},state:{},products:[{productId:'p',sku:'9000',name:'活动商品'}],actions:[{id:'a',title:'活动',type:'ELASTIC_BOOSTING'}],memberships:[],
  rules:[{id:'r',name:'降幅上限50%',enabled:false,minStock:2,maxDiscountPercent:50,actionIds:['a'],productIds:[],categoryIds:[],schedule:{mode:'DAILY',time:'09:00',timeZone:'Asia/Shanghai'}}],
  records:[{id:'receipt',source:'RULE',status:'COMPLETED',createdAt:'2026-09-23T02:00:00Z',items:[{operation:'JOIN',productId:'p',actionId:'a',price:'80.00',basePrice:'100.00',discountPercent:'20.00',maxDiscountPercent:50,currency:'CNY',status:'SUCCEEDED'}],skipped:[],summary:{total:1,succeeded:1}}]};
qa.promotionOverview=overview;
const request=async(path,options={})=>{
  const body=options.body;qa.requests.push({path,method:options.method||'GET',body});
  if(path.startsWith('/ozon/promotions/overview'))return structuredClone(overview);
  if(path.startsWith('/ozon/promotions/runs/receipt'))return structuredClone(overview.records[0]);
  if(path.startsWith('/ozon/promotions/rules')&&['POST','PUT'].includes(options.method)){
    if(qa.promotionSaveError)throw Object.assign(Error(qa.promotionSaveError),{code:'PROMOTION_INVALID'});
    const id=options.method==='PUT'?path.match(/\/rules\/([^?]+)/)[1]:`r${overview.rules.length+1}`;
    const rule={...body,id};overview.rules=overview.rules.filter(item=>item.id!==id).concat(rule);
    return structuredClone(overview);
  }
  if(path.startsWith('/ozon/promotions/preview')&&options.method==='POST'){
    const rule=overview.rules.find(item=>item.id===body.ruleId);
    const target=rule.targetDiscountPercent??null;
    const record={id:'ratio-preview',source:'RULE',status:'PREVIEW',createdAt:'2026-09-23T03:00:00Z',
      items:[{operation:'JOIN',productId:'p',actionId:'a',basePrice:'100.00',price:target===null?'80.00':'70.00',discountPercent:target===null?'20.00':'30.00',targetDiscountPercent:target,maxDiscountPercent:rule.maxDiscountPercent,currency:'CNY',status:'PLANNED'}],
      skipped:target===null?[]:[{operation:'JOIN',productId:'p',name:'平台至少降价40%的商品',actionId:'a',basePrice:'100.00',price:'70.00',discountPercent:'30.00',targetDiscountPercent:target,maxDiscountPercent:rule.maxDiscountPercent,currency:'CNY',reason:'设定报名降价比例30%不足平台要求的40%，已跳过，不自动加大降幅'}]};
    overview.records=[record,...overview.records.filter(item=>item.id!==record.id)];return structuredClone(record);
  }
  throw Error(path);
};
function Fixture(){const [view,setView]=React.useState('collect');return <ConfigProvider locale={zhCN}><AntApp><main style={{padding:20}}>
  <div><button onClick={()=>setView('collect')}>采集验收</button><button onClick={()=>setView('promotions')}>活动验收</button>
    <button onClick={()=>{qa.jobs=qa.jobs.filter(j=>j.id!=='wc_running');qa.products.unshift(product('collect_completed','547133456'));}}>模拟采集完成</button></div>
  {view==='collect'?<CollectPage account={{id:qa.account}} hasStore localData={{caches:{collectBox:[]}}} navigate={path=>qa.navigations.push(path)}/>
    :<PromotionManagementPage account={{id:qa.account}} binding={{id:'qa-store'}} localData={{}} request={request}/>}
</main></AntApp></ConfigProvider>}
createRoot(document.getElementById('root')).render(<Fixture/>);
