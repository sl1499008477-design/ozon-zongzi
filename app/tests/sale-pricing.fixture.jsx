import React from 'react';
import {createRoot} from 'react-dom/client';
import {App,Button,ConfigProvider,Form,Select} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import SalePricingPage,{CompetitorPricingPage} from '../src/SalePricingPage.jsx';
import SalePricingSelect from '../src/SalePricingSelect.jsx';
import AiListingPresets from '../src/AiListingPresets.jsx';
import {serializeAiListingConfig} from '../src/ai-listing-page-state.js';
import '../src/styles.css';
const qa=window.salePricingQa={items:[{id:'listing',name:'黑绿分段',currency:'CNY',salePriceFormula:'IF(黑标价 < 绿标价 * 1.06, 黑标价 * 0.97, 黑标价 * 3.24 - 绿标价 * 2.24)',updatedAt:'2026-09-19T00:00:00.000Z'}],realItems:[{id:'real',name:'黑标真实价',currency:'CNY',realPriceFormula:'黑标价',isDefault:true,updatedAt:'2026-09-19T00:00:00.000Z'}],requests:[],submitted:null};
const request=async(path,options={})=>{
  qa.requests.push({path,...options});const id=path.split('/')[3];
  if(path.includes('/presets/prompts'))return {items:[{id:'prompt',name:'验收提示词',content:'fixture'}]};
  if(path.includes('/presets/configs')){
    const items=['preset-a','preset-b'].map(id=>({id,name:id,config:{targetStoreId:'store',targetWarehouseId:'warehouse',promptId:'prompt',salePricingId:qa.items[0]?.id,salePricingUpdatedAt:qa.items[0]?.updatedAt}}));
    return path.split('/')[4]?{item:items.find(item=>item.id===path.split('/')[4])}:{items};
  }
  const real=path.includes('/real-pricing-profiles'),key=real?'realItems':'items';
  if(path.endsWith('/default')){qa.realItems=qa.realItems.map(item=>({...item,isDefault:item.id===id,updatedAt:new Date().toISOString()}));return {item:qa.realItems.find(item=>item.id===id)};}
  if(options.method==='POST'){const item={...options.body,id:crypto.randomUUID(),...(real?{isDefault:false}:{}),updatedAt:new Date().toISOString()};qa[key].push(item);return {item};}
  if(options.method==='PUT'){const at=qa[key].findIndex(item=>item.id===id);qa[key][at]={...qa[key][at],...options.body,id,updatedAt:new Date().toISOString()};return {item:qa[key][at]};}
  if(options.method==='DELETE'){qa[key]=qa[key].filter(item=>item.id!==id);return {deleted:true};}
  return id?{item:qa[key].find(item=>item.id===id)}:{items:structuredClone(qa[key]),defaultRealPricing:qa.realItems.find(item=>item.isDefault)};

};
function Fixture(){
  const [view,setView]=React.useState('profiles'),[currency,setCurrency]=React.useState('CNY'),[role,setRole]=React.useState('admin');const [form]=Form.useForm();
  return <ConfigProvider locale={zhCN}><App><main style={{maxWidth:1100,margin:'24px auto',padding:20}}>
    <Button onClick={()=>setView(view==='profiles'?'select':'profiles')}>切换配置与选择面板</Button>
    <Button onClick={()=>setView('real')}>管理员竞品配置</Button><Button onClick={()=>setRole(role==='admin'?'user':'admin')}>切换账号角色</Button>
    {view==='real'?<CompetitorPricingPage key={role} account={{role}} request={request}/>:view==='profiles'?<SalePricingPage request={request}/>:<Form form={form} layout="vertical" onFinish={values=>{qa.submitted=serializeAiListingConfig({...values,targetStoreId:'store',targetWarehouseId:'warehouse'});}}>
      <Select aria-label="验收店铺币种" value={currency} onChange={value=>{setCurrency(value);form.setFieldsValue({salePricingId:undefined,salePricingUpdatedAt:undefined});}} options={[{value:'CNY'},{value:'RUB'}]}/>
      <AiListingPresets form={form} request={request} onChange={()=>{}}><SalePricingSelect form={form} request={request} currency={currency}/></AiListingPresets><Button htmlType="submit">检查新任务参数</Button>
    </Form>}
  </main></App></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
