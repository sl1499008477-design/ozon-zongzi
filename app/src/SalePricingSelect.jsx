import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,Select,Space} from 'antd';
import {salePriceUsesRealPrice,displaySalePriceFormula} from '../../shared/sale-pricing.mjs';
export default function SalePricingSelect({form,request,currency,onChange}){
  const [items,setItems]=useState([]),[defaultReal,setDefaultReal]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const id=Form.useWatch('salePricingId',form),revision=Form.useWatch('salePricingUpdatedAt',form),realRevision=Form.useWatch('realPricingUpdatedAt',form),selected=items.find(item=>item.id===id),loadId=useRef(0);
  const usesReal=selected&&salePriceUsesRealPrice(selected.salePriceFormula);
  const load=async()=>{const current=++loadId.current;setLoading(true);try{const result=await request('/ai-listing/pricing-profiles');if(current===loadId.current){setItems(result.items||[]);setDefaultReal(result.defaultRealPricing);setError('');}}catch(e){if(current===loadId.current)setError(e.message);}finally{if(current===loadId.current)setLoading(false);}};
  useEffect(()=>{void load();return()=>{loadId.current++;};},[request]);
  useEffect(()=>{
    form.setFieldsValue({salePricingUpdatedAt:selected?.updatedAt,realPricingId:usesReal?defaultReal?.id:undefined,realPricingUpdatedAt:usesReal?defaultReal?.updatedAt:undefined});
    if(id)void form.validateFields(['salePricingId']).catch(()=>{});
    onChange?.();
  },[id,selected,usesReal,defaultReal,realRevision,currency,form]);
  useEffect(()=>{if(id&&((revision&&revision!==selected?.updatedAt)||(realRevision&&realRevision!==defaultReal?.updatedAt)))void load();},[revision,realRevision]);
  return <div style={{gridColumn:'span 2',minWidth:0}}>
    <Form.Item label="产品上架售价配置" name="salePricingId" rules={[{required:true,message:'请选择已保存的上架售价配置'},{validator:(_,value)=>{
      if(!value)return Promise.resolve();
      const item=items.find(item=>item.id===value);
      const reason=!item?'所选上架售价配置已删除或尚未加载，请刷新配置后重新选择'
        :item.currency!==currency?`上架售价配置使用 ${item.currency}，与当前店铺币种 ${currency||'未确定'} 不一致，请重新选择`
        :item.updatedAt!==form.getFieldValue('salePricingUpdatedAt')?'上架售价配置版本已更新，请刷新配置后重试'
        :salePriceUsesRealPrice(item.salePriceFormula)&&defaultReal?.currency!==currency?`默认竞品真实售价计算配置使用 ${defaultReal?.currency||'未确定币种'}，上架配置使用 ${currency}，请调整为相同币种`:'';
      return reason?Promise.reject(new Error(reason)):Promise.resolve();
    }}]}>
      <Select aria-label="产品上架售价配置" loading={loading} showSearch optionFilterProp="label" allowClear placeholder="选择已保存的上架售价配置" options={items.filter(item=>item.currency===currency).map(item=>({value:item.id,label:`${item.name}（${item.currency}）`}))} onChange={value=>{form.setFieldsValue({salePricingUpdatedAt:items.find(item=>item.id===value)?.updatedAt});onChange?.();}}/>
    </Form.Item>
    <Form.Item name="salePricingUpdatedAt" hidden><input/></Form.Item><Form.Item name="realPricingId" hidden><input/></Form.Item><Form.Item name="realPricingUpdatedAt" hidden><input/></Form.Item>
    <Space wrap style={{marginTop:-12,marginBottom:16}}><a href="/ozon/tools/sale-pricing" target="_blank" rel="noreferrer">管理售价配置</a><Button type="link" onClick={load} loading={loading}>刷新配置</Button></Space>
    {error&&<Alert type="error" message={error} style={{marginBottom:16}}/>}
    {selected&&<details style={{marginBottom:16,overflowWrap:'anywhere'}}><summary>查看当前售价公式</summary><p>上架售价 = {displaySalePriceFormula(selected.salePriceFormula)}（{selected.currency}）</p>{usesReal?<><p>引用默认竞品真实售价计算：{defaultReal?.name}（{defaultReal?.currency}）</p><p>竞品真实售价计算 = {defaultReal?.realPriceFormula}</p></>:<p>此配置不引用竞品真实售价计算。</p>}</details>}
  </div>;
}
