import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,InputNumber,Modal,Select,Space,Tag} from 'antd';
import Table from "./PagedTable.jsx";
import {apiRequest} from './client-transport.js';
const labels={QUEUED:'等待执行',RUNNING:'正在提交',COMPLETED:'修改完成',PARTIAL:'部分成功',FAILED:'修改失败',UNCERTAIN:'待核对',CLOSED:'已结束核对'};
const valueText=value=>value==null?'未上报':value;
export default function BatchStockEditor({storeId,rows,onClose,onChanged,onInspect}){
  const [items,setItems]=useState([]),[warehouseId,setWarehouseId]=useState(),[target,setTarget]=useState(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[results,setResults]=useState([]),[ambiguous,setAmbiguous]=useState(false);
  const alive=useRef(true),intent=useRef(null),notified=useRef(false),query=`storeId=${encodeURIComponent(storeId)}`;
  useEffect(()=>{let cancelled=false;alive.current=true;
    apiRequest(`/ozon/stocks/batch-preview?${query}`,{method:'POST',body:{productIds:rows.map(r=>String(r._raw.product_id||r._raw.id))},timeoutMs:60000}).then(data=>{if(!cancelled){setItems(data.items||[]);const first=data.items?.flatMap(i=>i.warehouses).find(w=>w.writable);setWarehouseId(first?.warehouseId);}}).catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;alive.current=false;};
  },[]);
  const polling=results.some(r=>r.record&&(['QUEUED','RUNNING'].includes(r.record.status)||(r.record.status==='UNCERTAIN'&&r.record.nextRunAt)));
  useEffect(()=>{
    if(!polling)return;let cancelled=false,timer;
    const poll=async()=>{try{const ids=results.filter(r=>r.record).map(r=>r.record.id).join(',');const data=await apiRequest(`/ozon/stocks/batch-status?${query}&ids=${encodeURIComponent(ids)}`,{timeoutMs:30000});if(!cancelled)setResults(previous=>previous.map(r=>({...r,record:data.records.find(x=>x.id===r.record?.id)||r.record})));}catch(e){if(!cancelled)setError(e.message);}finally{if(!cancelled)timer=setTimeout(poll,2500);}};
    timer=setTimeout(poll,1500);return()=>{cancelled=true;clearTimeout(timer);};
  },[polling,results.length]);
  useEffect(()=>{if(results.length&&!polling&&!notified.current){notified.current=true;if(results.some(r=>r.record?.items.some(i=>i.status==='SUCCEEDED')))void onChanged?.();}},[results,polling]);
  const options=[...new Map(items.flatMap(i=>i.warehouses).filter(w=>w.writable).map(w=>[w.warehouseId,{value:w.warehouseId,label:w.name}])).values()];
  const preview=items.map(item=>{const warehouse=item.warehouses.find(w=>w.warehouseId===warehouseId);return {...item,warehouse,reason:item.reason||(!warehouse?.writable?'不支持此仓库':'')};});
  const changed=preview.filter(i=>!i.reason&&target!==null&&i.warehouse.currentStock!==target);
  const locked=loading||busy||Boolean(results.length)||ambiguous;
  async function submit(){
    if(!intent.current)intent.current={requests:changed.map(item=>({id:crypto.randomUUID(),productId:item.product.productId,items:[{warehouseId,expectedStock:item.warehouse.currentStock,targetStock:target}]}))};
    setBusy(true);setError('');
    try{const data=await apiRequest(`/ozon/stocks/batch?${query}`,{method:'POST',body:intent.current,timeoutMs:60000});if(!alive.current)return;setResults(data.results||[]);setAmbiguous(false);}
    catch(e){if(!alive.current)return;setError(e.message);const unknown=!e.status||e.status>=500||e.code==='INVALID_JSON_RESPONSE';setAmbiguous(unknown);if(!unknown)intent.current=null;}
    finally{if(alive.current)setBusy(false);}
  }
  return <Modal rootClassName="prototype-overlay" title="批量修改库存" width={960} open onCancel={onClose} footer={<Space><Button onClick={onClose}>关闭</Button>{(!results.length||ambiguous)?<Button type="primary" onClick={submit} loading={busy} disabled={loading||(!ambiguous&&!changed.length)}>{ambiguous?'查询原提交结果':`确认修改 ${changed.length} 个商品`}</Button>:null}</Space>}>
    <div className="stock-edit-modal">
      <Alert type="info" showIcon message={`本次范围：${rows.length} 个商品。按商品保留独立修改记录。`} description="填写所选仓库修改后的可售数量，不包含订单预留。部分商品失败时，已成功的修改会保留。"/>
      {error?<Alert type="error" showIcon message={error}/>:null}
      <div className="batch-stock-fields"><label>修改仓库<Select style={{width:'100%'}} placeholder="选择仓库" options={options} value={warehouseId} onChange={setWarehouseId} disabled={locked}/></label><label>修改后可售数量<InputNumber min={0} max={2147483647} precision={0} value={target} onChange={setTarget} disabled={locked} placeholder="0 表示无可售库存" style={{width:'100%'}}/></label></div>
      <Table rowKey={item=>item.product.productId} dataSource={preview} loading={loading}  scroll={{x:680}} size="small" columns={[
        {title:'商品 / SKU',width:320,render:(_,item)=><div className="product-info-cell"><span className="catalog-product-name">{item.product.name}</span><span>SKU：{item.product.sku}</span></div>},
        {title:'当前可售',width:110,render:(_,item)=>valueText(item.warehouse?.currentStock)},
        {title:'修改后可售',width:115,render:()=>target??'—'},
        {title:'执行结果',width:240,render:(_,item)=>{const result=results.find(r=>r.productId===item.product.productId);if(result?.record)return <div className="product-info-cell"><Tag color={result.record.status==='COMPLETED'?'success':result.record.status==='FAILED'?'error':'processing'}>{labels[result.record.status]}</Tag><span>{result.record.items[0]?.message}</span><Button type="link" size="small" onClick={()=>onInspect(rows.find(r=>String(r._raw.product_id||r._raw.id)===item.product.productId))}>查看记录</Button></div>;return result?.error||item.reason||(!changed.includes(item)?'保持不变':'待确认');}},
      ]}/>
    </div>
  </Modal>;
}
