import React,{useEffect,useRef,useState} from 'react';
import {Alert,App,Button,Checkbox,Empty,InputNumber,Modal,Space,Spin,Tag} from 'antd';
import Table from "./PagedTable.jsx";
import {apiRequest} from './client-transport.js';
import './stock-editor.css';

const labels={QUEUED:'等待执行',RUNNING:'正在提交',COMPLETED:'修改完成',PARTIAL:'部分成功',FAILED:'修改失败',UNCERTAIN:'待核对',CLOSED:'已结束核对',SUCCEEDED:'成功',SENDING:'等待平台结果'};
const colors={COMPLETED:'success',SUCCEEDED:'success',PARTIAL:'warning',UNCERTAIN:'warning',FAILED:'error',RUNNING:'processing'};
const number=value=>value===null||value===undefined?'未上报':value;
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';

export default function StockEditor({storeId,productId,row,onClose,onChanged,request=apiRequest}){
  const {message,modal}=App.useApp();
  const [data,setData]=useState(null),[records,setRecords]=useState([]),[draft,setDraft]=useState({});
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ambiguous,setAmbiguous]=useState(false),[showInactive,setShowInactive]=useState(false);
  const alive=useRef(true),intent=useRef(null),tracked=useRef(null),changed=useRef(onChanged);
  changed.current=onChanged;
  const query=`storeId=${encodeURIComponent(storeId)}&productId=${encodeURIComponent(productId)}`;
  const pending=records.some(r=>['QUEUED','RUNNING','UNCERTAIN'].includes(r.status));
  const polling=records.some(r=>['QUEUED','RUNNING'].includes(r.status)||(r.status==='UNCERTAIN'&&r.nextRunAt));
  const locked=loading||busy||pending||ambiguous;
  function acceptRecords(next){
    if(!alive.current)return;
    setRecords(next);
    const completed=next.find(r=>r.id===tracked.current);
    if(completed&&['COMPLETED','PARTIAL','FAILED','CLOSED'].includes(completed.status)){
      tracked.current=null;
      if(completed.items.some(i=>i.status==='SUCCEEDED')){void changed.current?.();void load();}
    }
  }
  async function readRecords(){
    const result=await request(`/ozon/stocks/changes?${query}`,{timeoutMs:30000});acceptRecords(result.records||[]);return result.records||[];
  }
  async function load(){
    setLoading(true);setError('');
    try{
      const result=await request(`/ozon/stocks/product?${query}`,{timeoutMs:60000});if(!alive.current)return;
      setData(result);setDraft({});acceptRecords(result.records||[]);
      tracked.current=(result.records||[]).find(r=>['QUEUED','RUNNING','UNCERTAIN'].includes(r.status))?.id||tracked.current;
      if(!ambiguous)intent.current=null;
    }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setLoading(false);}
  }
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!polling)return;
    let cancelled=false,timer;
    const poll=async()=>{try{await readRecords();}catch(e){if(!cancelled&&alive.current)setError(`修改记录暂时无法刷新：${e.message}`);}finally{if(!cancelled)timer=setTimeout(poll,2000);}};
    timer=setTimeout(poll,2000);return()=>{cancelled=true;clearTimeout(timer);};
  },[polling]);
  const modifications=(data?.warehouses||[]).filter(w=>w.writable&&draft[w.warehouseId]!==undefined&&draft[w.warehouseId]!==null&&draft[w.warehouseId]!==w.currentStock).map(w=>({warehouseId:w.warehouseId,warehouseName:w.name,expectedStock:w.currentStock,targetStock:draft[w.warehouseId]}));
  async function submit(){
    if(busy)return;
    if(!intent.current)intent.current={id:crypto.randomUUID(),productId:String(productId),items:modifications.map(({warehouseName,...item})=>item)};
    setBusy(true);setError('');
    try{
      const result=await request(`/ozon/stocks/changes?${query}`,{method:'POST',body:intent.current,timeoutMs:60000});
      if(!alive.current)return;
      tracked.current=result.id;acceptRecords([result,...records.filter(r=>r.id!==result.id)]);
      setAmbiguous(false);intent.current=null;setDraft({});
      message.success(['COMPLETED','PARTIAL','FAILED','CLOSED'].includes(result.status)?'已找到原提交结果':'库存修改已提交，可在下方查看执行结果');
      void readRecords().catch(()=>{});
    }catch(e){
      if(!alive.current)return;
      const unknown=!e.status||e.status>=500||e.code==='INVALID_JSON_RESPONSE';setAmbiguous(unknown);
      if(!unknown)intent.current=null;
      setError(unknown?'提交应答中断，请查询原提交结果；再次点击只会查询或提交同一个请求。':e.message);
      void readRecords().catch(()=>{});
    }finally{if(alive.current)setBusy(false);}
  }
  async function act(record,action){
    setBusy(true);setError('');
    try{
      const result=await request(`/ozon/stocks/changes/${encodeURIComponent(record.id)}/${action}?${query}`,{method:'POST',body:{},timeoutMs:60000});
      if(!alive.current)return;tracked.current=record.id;acceptRecords(records.map(r=>r.id===record.id?result:r));
    }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}
  }
  const warehouses=(data?.warehouses||[]).filter(w=>w.writable||showInactive).sort((a,b)=>Number(b.writable)-Number(a.writable));
  const inactive=(data?.warehouses||[]).filter(w=>!w.writable).length;
  return <Modal rootClassName="prototype-overlay" title="修改 SKU 库存" open onCancel={onClose} width={860} footer={<Space wrap>
    <Button onClick={onClose}>关闭</Button>
    <Button onClick={load} loading={loading} disabled={busy||ambiguous}>刷新当前库存</Button>
    {ambiguous?<Button type="primary" loading={busy} onClick={submit}>查询原提交结果</Button>:<Button type="primary" loading={busy} disabled={locked||!modifications.length} onClick={submit}>提交库存修改</Button>}
  </Space>}>
    <div className="stock-edit-modal">
      <div className="product-price-modal-head"><strong>{data?.product.name||row?._title||'—'}</strong><span>SKU：{data?.product.sku||row?._sku||'—'}</span><span>货号：{data?.product.offerId||row?._offerId||'—'}</span></div>
      <Alert type="info" showIcon message="填写修改后的可售数量，不包含订单预留。填 0 表示该仓库暂无可售库存。" description="支持 FBS / rFBS 卖家仓库；同一商品和仓库两次更新至少间隔 30 秒。提交前会重新检查库存是否变化。" />
      {error?<Alert type="error" showIcon message={error}/>:null}
      <Spin spinning={loading}>
        <Table size="small" rowKey="warehouseId"  dataSource={warehouses} scroll={{x:650}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={data?'没有可修改的卖家仓库':'正在读取平台库存'}/>}} columns={[
          {title:'仓库',dataIndex:'name',width:220,render:(value,w)=><div className="stock-edit-warehouse"><strong title={value}>{value}</strong><span>{w.scheme}{!w.writable?` · ${w.reason}`:''}</span></div>},
          {title:'当前可售',dataIndex:'currentStock',width:100,render:number},
          {title:'订单预留',dataIndex:'reserved',width:100,render:number},
          {title:'修改后可售',width:150,render:(_,w)=>w.writable?<InputNumber aria-label={`${w.name}修改后可售库存`} min={0} max={2147483647} precision={0} step={1} disabled={locked} placeholder="保持不变" value={draft[w.warehouseId]??null} onChange={value=>{intent.current=null;setDraft(previous=>({...previous,[w.warehouseId]:value}));}}/>:<span>不可修改</span>},
        ]}/>
      </Spin>
      {inactive?<Checkbox checked={showInactive} onChange={e=>setShowInactive(e.target.checked)}>显示不可修改仓库（{inactive}）</Checkbox>:null}
      {modifications.length?<div className="stock-change-preview"><strong>本次修改预览</strong>{modifications.map(item=><div key={item.warehouseId}>{item.warehouseName}：{number(item.expectedStock)} → <strong>{item.targetStock}</strong> 件可售{item.targetStock===0?'（无可售库存）':''}</div>)}</div>:null}
      {pending?<Alert type="warning" showIcon message="此商品有待执行或待核对的修改，请先查看下方记录。"/>:null}
      <div className="stock-record-title"><strong>最近修改记录</strong><Button size="small" disabled={busy} onClick={()=>readRecords().catch(e=>setError(e.message))}>刷新记录</Button></div>
      {!records.length?<span className="stock-record-note">暂无修改记录</span>:records.map((record,index)=><details className="stock-change-record" key={record.id} open={index===0?true:undefined}>
        <summary><Tag color={colors[record.status]}>{labels[record.status]}</Tag><span>{time(record.createdAt)}</span></summary>
        <div className="stock-record-items">{record.items.map(item=><div className="stock-record-item" key={item.warehouseId}>
          <strong>{item.warehouseName}：{number(item.expectedStock)} → {item.targetStock} 件</strong>
          <span><Tag color={colors[item.status]}>{labels[item.status]||item.status}</Tag>{item.message}</span>
          {Object.hasOwn(item,'observedStock')?<span className="stock-record-note">最近读取可售量：{number(item.observedStock)} · {time(record.checkedAt)}</span>:null}
        </div>)}</div>
        {record.readError?<p className="stock-record-note">{record.readError}</p>:null}
        {record.status==='UNCERTAIN'?<Space wrap><Button size="small" disabled={busy} onClick={()=>act(record,'reconcile')}>核对平台结果</Button><Button size="small" disabled={busy} onClick={()=>modal.confirm({title:'结束本次核对？',content:'这不会撤销已发送给 Ozon 的请求，也不代表修改失败。请先在平台确认库存；再次修改会重新读取当前数量。',okText:'已确认，结束核对',cancelText:'继续核对',onOk:()=>act(record,'close')})}>结束核对</Button></Space>:null}
        {record.status==='CLOSED'?<p className="stock-record-note">已停止本系统核对，平台请求未被撤销。</p>:null}
      </details>)}
    </div>
  </Modal>;
}
