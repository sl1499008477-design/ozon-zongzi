import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp } from 'antd';
import { AppShell } from '../src/App.jsx';
import '../src/styles.css';

const pixel='data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const defaults=['02131','02478','02090','02782','02793','02809'];
const stores=['a','b'].map((id,index)=>({id:`store-${id}`,label:`质检测试${index+1}店`,storeName:`质检测试${index+1}店`,clientId:`fixture-${id}`,credentialsSaved:true,currencyCode:'RUB',savedAt:'2026-09-10T00:00:00Z'}));
const product={sku:'1553617193',name:'Настенный светильник · 质检测试商品',imageUrl:pixel,quantity:1,sale:{amount:'100.00',currency:'RUB'},commission:{amount:'10.00',currency:'RUB'},unitCostCny:null,lineCostCny:null};
const order=(storeId,orderNumber,status='delivered',count=1)=>({storeId,storeName:stores.find(store=>store.id===storeId)?.label,orderNumber,matchedPrefix:orderNumber.slice(0,5),orderAt:'2026-08-20T08:00:00Z',readAt:null,postings:Array.from({length:count},(_,index)=>({postingNumber:`${orderNumber}-${index+1}`,scheme:index?'FBO':'FBS',status,statusGroup:status,products:[{...product}]}))});
const makeAccount=unbound=>({prefixes:unbound?[]:[...defaults],stores:unbound?[]:stores,currentStoreId:unbound?'':'store-a',orders:unbound?[]:[order('store-a','02131-100','delivered',2),order('store-b','02478-200','awaiting_packaging'),{...order('store-a','02090-old','cancelled'),orderAt:'2020-01-01T08:00:00Z'}]});
let users={a:makeAccount(false),b:makeAccount(true)},active='a',mount=0,holdNext=false,held=[];
const calls=[];
const user=()=>users[active];
const account=()=>({id:`account-${active}`,username:active,displayName:`质检测试用户 ${active}`,role:'user',status:'active'});
const matched=()=>user().orders.filter(row=>user().prefixes.includes(row.orderNumber.slice(0,5)));
const summary=()=>({unreadCount:matched().filter(row=>!row.readAt).length,total:matched().length,latest:matched().filter(row=>!row.readAt).slice(0,5),checkedAt:new Date().toISOString()});
const coverage=()=>user().stores.map(store=>({storeId:store.id,storeName:store.label,boundAt:store.savedAt,since:'2026-08-26T00:00:00Z',to:store.id==='store-a'?'2026-09-12T00:00:00Z':null,targetTo:'2026-09-12T00:00:00Z',lastSyncedAt:store.id==='store-a'?'2026-09-12T00:00:00Z':null,status:store.id==='store-a'?'COMPLETED':'FAILED',lastError:store.id==='store-b'?'Fixture：第二店同步暂未完整完成':null}));
const localState=()=>({account:account(),stores:user().stores,currentStoreId:user().currentStoreId,binding:user().stores.find(store=>store.id===user().currentStoreId)||null,caches:{products:[],warehouses:[],collectBox:[],favorites:[],productTemplates:[]},summary:{},jobs:{}});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const nativeFetch=window.fetch.bind(window);
window.fetch=async(url,options={})=>{
 const parsed=new URL(url,location.origin),path=parsed.pathname.replace(/^\/api/,'');
 if(!parsed.pathname.startsWith('/api/'))return nativeFetch(url,options);
 const body=options.body?JSON.parse(options.body):{};
 calls.push({account:active,path,method:options.method||'GET',body,query:Object.fromEntries(parsed.searchParams)});
 if(path==='/local/state')return response(localState());
 if(path==='/local/current-store'){user().currentStoreId=body.storeId;return response({store:user().stores.find(store=>store.id===body.storeId)});}
 if(path==='/local/accounts/logout')return response({ok:true});
 if(path==='/local/accounts/login'){active=body.username==='b'?'b':'a';return response({token:'fixture-only',state:localState()});}
 if(path==='/ozon/order-inspection/settings'){
  if(options.method==='PUT')user().prefixes=[...body.prefixes];
  return response({prefixes:user().prefixes,updatedAt:new Date().toISOString()});
 }
 if(path==='/ozon/order-inspection/summary'){
  const captured=structuredClone(summary());
  if(holdNext){holdNext=false;return new Promise(resolve=>held.push(()=>resolve(response(captured))));}
  return response(captured);
 }
 if(path==='/ozon/order-inspection/read'){
  for(const target of body.items)for(const row of user().orders)if(row.storeId===target.storeId&&row.orderNumber===target.orderNumber)row.readAt ||= new Date().toISOString();
  return response(summary());
 }
 if(path==='/ozon/order-inspection/sync')return response({stores:coverage()});
 if(path==='/ozon/order-inspection/overview'){
  const p=parsed.searchParams,page=Number(p.get('page')||1),pageSize=Number(p.get('pageSize')||20),q=p.get('q')||'',read=p.get('readStatus');
  const items=matched().filter(row=>(!p.get('storeId')||row.storeId===p.get('storeId'))&&(!q||JSON.stringify(row).includes(q))&&(read!=='read'||row.readAt)&&(read!=='unread'||!row.readAt));
  return response({items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize,unreadCount:summary().unreadCount,stores:coverage()});
 }
 const postingRows=()=>user().orders.flatMap(row=>row.postings.map(posting=>({...posting,storeId:row.storeId,orderNumber:row.orderNumber,inProcessAt:row.orderAt,createdAt:row.orderAt,sale:{amount:'100.00',currency:'RUB'},commission:{amount:'10.00',currency:'RUB'},commissionMatch:'MATCHED',purchaseCostCny:null,grossProfitCny:null,qualityInspection:{matched:true,prefix:row.matchedPrefix,readAt:row.readAt}})));
 if(path==='/ozon/order-management/overview'){
  const items=postingRows().filter(row=>row.storeId===parsed.searchParams.get('storeId'));
  return response({items,total:items.length,statusCounts:{all:items.length},sync:{status:'COMPLETED',completedAt:'2026-09-12T00:00:00Z'}});
 }
 if(path.startsWith('/ozon/order-management/postings/')){
  const posting=postingRows().find(row=>row.storeId===parsed.searchParams.get('storeId')&&row.postingNumber===decodeURIComponent(path.split('/').at(-1))&&row.scheme===parsed.searchParams.get('scheme'));
  return response(posting?{posting}:{message:'Fixture店铺或包裹范围错误'},posting?200:404);
 }
 return response({message:`Fixture未定义接口：${path}`},404);
};
const root=createRoot(document.getElementById('root'));
function render(){
 localStorage.setItem('token','fixture-only');
 const binding=localState().binding;
 if(binding){localStorage.setItem('qh-local-binding-v1',JSON.stringify(binding));localStorage.setItem('currentOzonStoreId',binding.id);}
 else{localStorage.removeItem('qh-local-binding-v1');localStorage.removeItem('currentOzonStoreId');}
 root.render(<AntApp><AppShell key={`${active}:${mount}`} initialState={{authChecked:true,account:account(),localData:localState()}}/></AntApp>);
}
window.inspectionFixture={calls,
 switchAccount(id){active=id;mount++;render();},
 addUnread(){user().orders.push(order('store-b',`02809-new-${user().orders.length}`,'awaiting_deliver'));},
 holdNextSummary(){holdNext=true;},releaseSummary(){held.splice(0).forEach(resolve=>resolve());},
 snapshot(){return structuredClone({active,...user(),summary:summary(),held:held.length});},
 reset(){users={a:makeAccount(false),b:makeAccount(true)};active='a';mount++;calls.length=0;render();},
};
render();
