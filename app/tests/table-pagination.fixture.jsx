import React from 'react';
import {createRoot} from 'react-dom/client';
import {App as AntApp,ConfigProvider} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Table from '../src/PagedTable.jsx';
import PricingSettingsPage from '../src/PricingSettingsPage.jsx';
import {ProductListPage} from '../src/App.jsx';
import {AiListingCompletedRecords} from '../src/AiListingPage.jsx';
import WebCollectionCard from '../src/WebCollectionCard.jsx';
import MessageManagementPage from '../src/MessageManagementPage.jsx';
import OrderManagementPage from '../src/OrderManagementPage.jsx';
import {productCatalogPage} from '../../shared/product-catalog.mjs';
import '../src/styles.css';
const qa=window.pageQA={requests:[],hold:false,pending:[]};
const items=Array.from({length:63},(_,i)=>({id:`item-${i}`,product_id:`item-${i}`,storeId:'store',name:`分页商品 ${i}`,sku:`test-${i}`,offer_id:`offer-${i}`,status:'selling',stock:i%2?4:0,price:'100',currency_code:'RUB'}));
const pageRows=p=>items.slice((Number(p.get('page')||1)-1)*Number(p.get('pageSize')||5),Number(p.get('page')||1)*Number(p.get('pageSize')||5));
const request=async(path,options={})=>{
 const u=new URL(path,'http://fixture'),p=u.searchParams;qa.requests.push({path,method:options.method||'GET'});
 if(u.pathname==='/ozon/products/cache'){
  const response=productCatalogPage(items,{...Object.fromEntries(p),page:Number(p.get('page')),pageSize:Number(p.get('pageSize'))});
  if(qa.hold)return new Promise(resolve=>qa.pending.push(()=>resolve(response)));return response;
 }
 if(u.pathname==='/admin/pricing/versions')return {versions:[{id:'fixture',status:'DRAFT',versionNo:1}]};
 if(u.pathname==='/admin/pricing/fx')return {probes:[]};
 if(u.pathname==='/admin/pricing/versions/fixture'){
  if(options.method==='PUT'){qa.savedPricing=JSON.parse(options.body);return {config:qa.savedPricing};}
  return {config:{id:'fixture',status:'DRAFT',versionNo:1,defaults:{},commissionRules:items.slice(0,12).map((r,i)=>({id:r.id,ruleName:`规则 ${i}`,fulfillmentType:'RFBS',commissionRate:10,minPriceRub:0})),logisticsRules:items.slice(0,12).map((r,i)=>({id:r.id,provider:`P${i}`,routeCode:`R${i}`,warehouseId:'*',minWeightG:0,baseFeeCny:0,feePerKgCny:0,minimumFeeCny:0})),domesticFeeRules:[]}};
 }
 if(u.pathname==='/ozon/product-costs')return {items:[]};
 if(u.pathname==='/ai-listing/tasks')return {tasks:items.slice(Number(p.get('offset')),Number(p.get('offset'))+Number(p.get('limit'))).map(item=>({...item,status:'COMPLETED',images:[],config:{},taskActions:{}})),total:63};
 if(u.pathname==='/ozon/collect-box/web-jobs')return {data:{items:pageRows(p).map(item=>({...item,status:'CANCELLED',scope:'CURRENT',message:'分页验收',sourceUrl:'https://example.invalid'})),total:63}};
 if(u.pathname==='/ozon/order-management/overview')return {items:pageRows(p).map(item=>({postingNumber:item.id,orderNumber:item.id,scheme:'FBS',status:'delivered',products:[{sku:item.sku,name:item.name}],sale:{amount:'100',currency:'RUB'}})),total:63,statusCounts:{all:63},sync:{status:'COMPLETED'}};
 if(u.pathname==='/ozon/messages/overview')return {settings:{enabled:false,counts:{},timeZone:'Asia/Shanghai'},templates:[],variables:[]};
 if(u.pathname==='/ozon/messages/postings')return {items:pageRows(p).map(item=>({postingNumber:item.id,orderNumber:item.id,status:'delivered',products:[{sku:item.sku,name:item.name}]})),total:63};
 if(u.pathname==='/ozon/messages/records')return {items:pageRows(p).map(item=>({...item,status:'SENT',trigger:'REVIEW',text:'验收消息'})),total:63};
 throw Error(`Unexpected fixture API ${path}`);
};
const originalFetch=window.fetch.bind(window);
window.fetch=async(url,options={})=>{
 if(!String(url).startsWith('/api/'))return originalFetch(url,options);
 return new Response(JSON.stringify(await request(String(url).slice(4),options)),{status:200,headers:{'Content-Type':'application/json'}});
};
const binding={id:'store',storeName:'验收店铺'},localData={currentStoreId:'store',stores:[binding],caches:{warehouses:[]}};
function Fixture(){
 const [view,setView]=React.useState('local');
 return <ConfigProvider locale={zhCN}><AntApp><main style={{padding:24}}><nav>{['local','empty','products','history','webjobs','orders','messages','pricing'].map(id=><button key={id} onClick={()=>setView(id)}>{id}</button>)}</nav>
 {view==='pricing'&&<PricingSettingsPage account={{role:'admin'}}/>}
 {view==='local'&&<Table rowKey="id" dataSource={items} columns={[{title:'商品',dataIndex:'name'}]}/>}
 {view==='empty'&&<Table key="empty" rowKey="id" dataSource={[]} columns={[{title:'商品',dataIndex:'name'}]}/>}
 {view==='products'&&<ProductListPage binding={binding} hasStore localData={localData}/>}
 {view==='history'&&<AiListingCompletedRecords accountId="A" storeId="store" request={request}/>}
 {view==='webjobs'&&<WebCollectionCard navigate={()=>{}}/>}
 {view==='orders'&&<OrderManagementPage binding={binding} localData={localData} account={{id:'A'}}/>}
 {view==='messages'&&<MessageManagementPage binding={binding} localData={localData} account={{id:'A'}} request={request}/>}
 </main></AntApp></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
