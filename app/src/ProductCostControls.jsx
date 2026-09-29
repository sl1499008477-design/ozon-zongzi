import React,{useEffect,useRef,useState} from 'react';
import {Alert,App,Button,Form,InputNumber,Modal,Switch} from 'antd';
import {EditOutlined} from '@ant-design/icons';
import {apiRequest} from './client-transport.js';

export function useProductCosts(storeId,enabled){
  const [items,setItems]=useState({}),[error,setError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState({}),[attempt,setAttempt]=useState(0);
  const active=useRef(true),saving=useRef(new Set());
  useEffect(()=>{active.current=true;const controller=new AbortController();setItems({});setError('');
    if(enabled&&storeId){setLoading(true);apiRequest(`/ozon/product-costs?storeId=${encodeURIComponent(storeId)}`,{signal:controller.signal,timeoutMs:30000}).then(data=>{if(active.current)setItems(Object.fromEntries((data.items||[]).map(item=>[item.productId,item])));}).catch(e=>{if(active.current&&!controller.signal.aborted)setError(e.message);}).finally(()=>{if(active.current)setLoading(false);});}
    return()=>{active.current=false;controller.abort();};
  },[storeId,enabled,attempt]);
  async function save(productId,patch){
    if(saving.current.has(productId))return;
    saving.current.add(productId);setBusy(previous=>({...previous,[productId]:true}));
    try{const result=await apiRequest(`/ozon/product-costs/${encodeURIComponent(productId)}?storeId=${encodeURIComponent(storeId)}`,{method:'PUT',body:patch,timeoutMs:30000});if(active.current){setItems(previous=>({...previous,[productId]:result}));setError('');}return result;}
    finally{saving.current.delete(productId);if(active.current)setBusy(previous=>({...previous,[productId]:false}));}
  }
  return {items,error,loading,busy,save,reload:()=>setAttempt(value=>value+1)};
}
export function ProductCostField({productId,name,cost,onSave,disabled}){
  const {message}=App.useApp();const [open,setOpen]=useState(false),[value,setValue]=useState(null),[busy,setBusy]=useState(false);
  async function save(){setBusy(true);try{await onSave(productId,{unitCostCny:value===null?null:String(value),autoApply:value===null?false:Boolean(cost?.autoApply)});setOpen(false);message.success('采购成本已保存');}catch(e){message.error(e.message);}finally{setBusy(false);}}
  return <><Button className="product-cost-button" disabled={disabled} onClick={()=>{setValue(cost?.unitCostCny??null);setOpen(true);}} icon={<EditOutlined/>}>{cost?.unitCostCny!=null?`¥ ${cost.unitCostCny}`:'设置成本'}</Button>
    <Modal rootClassName="prototype-overlay" title="商品采购成本" open={open} onCancel={()=>setOpen(false)} onOk={save} confirmLoading={busy} okText="保存成本" cancelText="取消" width={500}>
      <p className="catalog-detail-name">{name}</p><Form layout="vertical"><Form.Item label="每件采购成本（人民币）"><InputNumber style={{width:'100%'}} min={0} stringMode precision={2} value={value} onChange={setValue} placeholder="留空表示未设置"/></Form.Item></Form>
      <Alert type="info" showIcon message="成本用于订单利润计算，不修改 Ozon 售价。" description="开启自动应用后，用于尚未设置成本的订单；已确认的订单成本保留。清空成本会同时关闭自动应用。"/>
    </Modal></>;
}
export function ProductCostSwitch({productId,cost,onSave,disabled,loading}){
  const {message}=App.useApp();return <Switch aria-label="自动应用采购成本" size="small" checked={Boolean(cost?.autoApply)} disabled={disabled||cost?.unitCostCny==null} loading={loading} onChange={async value=>{try{await onSave(productId,{unitCostCny:cost.unitCostCny,autoApply:value});message.success(value?'已开启自动应用采购成本':'已关闭自动应用采购成本');}catch(e){message.error(e.message);}}}/>;
}
