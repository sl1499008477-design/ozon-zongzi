import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Checkbox,Input,Modal,Select,Space,Switch,Tag} from 'antd';
import Table from "./PagedTable.jsx";
import {apiRequest} from './client-transport.js';

const kindName={TOPUP:'充值',SKU_CHARGE:'生图收费',BALANCE_ADJUSTMENT:'余额调整'};
const actionName={price:'修改单价',clear_price:'清除单价',topup:'充值',balance:'调整余额',edit_entry:'修改收支记录',delete_entry:'删除收支记录',restore_entry:'恢复收支记录',edit_cost:'修改估算成本',delete_cost:'删除成本记录',restore_cost:'恢复成本记录'};
const dateText=value=>value?new Date(value).toLocaleString():'—';
function decimal(units,digits=2){
 const value=BigInt(units||0),absolute=value<0n?-value:value,scale=10n**BigInt(digits);
 return `${value<0n?'-':''}${absolute/scale}.${String(absolute%scale).padStart(digits,'0')}`;
}
const yuan=value=>`¥${decimal(value)}`;
const costText=value=>value==null?'待核实':`¥${value}`;
function parseAmount(value,digits=2,signed=false){
 if(!new RegExp(`^${signed?'-?':''}\\d+(?:\\.\\d{1,${digits}})?$`).test(value.trim()))return null;
 const [whole,fraction='']=value.trim().replace(/^-/,'').split('.');
 const units=(BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0')))*(value.trim().startsWith('-')?-1n:1n);
 return {units,text:decimal(units,digits)};
}
function historyValue(value){
 if(!value)return '—';
 const fields={sku_price_cents:'SKU 单价',balance_cents:'余额',reserved_cents:'预留',amount_cents:'记录金额',estimated_cost_cny:'原估算成本',effective_cost_cny:'生效估算成本',billing_cost_cny:'更正成本',billing_cost_override_cny:'更正成本',voided_at:'删除时间',billing_cost_deleted_at:'删除时间'};
 const parts=[];
 for(const [key,label] of Object.entries(fields))if(Object.hasOwn(value,key))parts.push(`${label}：${key.endsWith('_cents')?(value[key]==null?'未设置':yuan(value[key])):key.endsWith('_at')?(value[key]?dateText(value[key]):'未删除'):costText(value[key])}`);
 for(const key of ['wallet','entry','request'])if(value[key])parts.push(historyValue(value[key]));
 return parts.filter(part=>part!=='—').join('；')||'记录已更新';
}

export default function AiBillingPanel({management=false}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(null),[refreshing,setRefreshing]=useState(false),[busy,setBusy]=useState(false),[user,setUser]=useState();
 const [editor,setEditor]=useState(null),[saveError,setSaveError]=useState(''),[saveUncertain,setSaveUncertain]=useState(false),[records,setRecords]=useState(null),[recordData,setRecordData]=useState(null),[recordError,setRecordError]=useState(''),[recordLoading,setRecordLoading]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[showDeleted,setShowDeleted]=useState(false);
 const mounted=useRef(false),saving=useRef(false),reading=useRef(0),sequence=useRef(0),recordSequence=useRef(0),recordsRef=useRef(null);
 const admin=Boolean(data&&Object.hasOwn(data,'costs')),canManage=admin&&management;
 const username=row=>row.username||data?.wallets?.find(wallet=>wallet.account_id===row.account_id)?.username||row.account_id||'—';
 const scoped=rows=>(rows||[]).filter(row=>!user||row.account_id===user);

 const load=useCallback(async({poll=false}={})=>{
  if(poll&&(saving.current||reading.current))return;
  const current=++sequence.current;reading.current=current;
  if(!poll)setRefreshing(true);
  try{
   const result=await apiRequest('/ai-listing/billing');
   if(mounted.current&&current===sequence.current){setData(result);setError('');}
   return result;
  }catch(failure){
   if(mounted.current&&current===sequence.current)setError(failure.message||'费用记录读取失败');
   throw failure;
  }finally{
   if(reading.current===current)reading.current=0;
   if(mounted.current&&current===sequence.current)setRefreshing(false);
  }
 },[]);
 const loadRecords=useCallback(async view=>{
  const current=++recordSequence.current;
  setRecordLoading(true);setRecordError('');
  const query=new URLSearchParams({type:view.type,page:String(view.page),pageSize:String(view.pageSize),deleted:String(view.deleted)});
  if(view.accountId)query.set('accountId',view.accountId);
  if(view.taskId)query.set('taskId',view.taskId);
  try{
   const result=await apiRequest(`/ai-listing/billing/records?${query}`);
   if(mounted.current&&current===recordSequence.current)setRecordData(result);
   return result;
  }catch(failure){
   if(mounted.current&&current===recordSequence.current)setRecordError(failure.message||'明细读取失败');
   throw failure;
  }finally{if(mounted.current&&current===recordSequence.current)setRecordLoading(false);}
 },[]);
 useEffect(()=>{
  mounted.current=true;void load().catch(()=>{});
  const timer=setInterval(()=>void load({poll:true}).catch(()=>{}),30000);
  return()=>{mounted.current=false;sequence.current+=1;recordSequence.current+=1;clearInterval(timer);};
 },[load]);
 useEffect(()=>{
  recordsRef.current=records;
  if(records)void loadRecords(records).catch(()=>{});
  else{recordSequence.current+=1;setRecordData(null);setRecordError('');}
 },[records,loadRecords]);

 const openEditor=(action,row)=>{
  const wallet=data.wallets.find(item=>item.account_id===row.account_id)||row;
  let amount='';
  if(action==='price')amount=row.sku_price_cents==null?'':decimal(row.sku_price_cents);
  if(action==='balance')amount=decimal(row.balance_cents);
  if(action==='edit_entry')amount=decimal(row.kind==='SKU_CHARGE'?-BigInt(row.amount_cents):row.amount_cents);
  if(action==='edit_cost')amount=row.effective_cost_cny==null?'':String(row.effective_cost_cny).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');
  setSaveError('');setSaveUncertain(false);setEditor({action,row:{...row},wallet:{...wallet},username:username(row),amount,unknown:action==='edit_cost'&&row.effective_cost_cny==null,reason:'',intent:crypto.randomUUID()});
 };
 const changeEditor=patch=>{setSaveError('');setEditor(value=>({...value,...patch}));};
 const openRecords=(type,row=null)=>{
  setRecordData(null);setRecords({type,accountId:row?.account_id||user,taskId:row?.task_id,product:row?.product,username:row?username(row):'',page:1,pageSize:5,deleted:false});
 };
 const action=editor?.action||'',isCost=action.endsWith('_cost'),isEntry=action.endsWith('_entry');
 const hasAmount=['price','topup','balance','edit_entry','edit_cost'].includes(action);
 const requiresReason=action&&action!=='price'&&action!=='topup';
 const parsed=editor&&hasAmount&&!(isCost&&editor.unknown)?parseAmount(editor.amount,isCost?6:2,isEntry&&editor.row.kind==='BALANCE_ADJUSTMENT'):null;
 const positive=action==='topup'||(action==='edit_entry'&&editor?.row.kind==='TOPUP');
 const amountValid=!hasAmount||(isCost&&editor?.unknown)||Boolean(parsed&&(!positive||parsed.units>0n));
 const tooLow=action==='balance'&&parsed&&parsed.units<BigInt(editor.wallet.reserved_cents||0);
 const canSave=Boolean(editor&&amountValid&&(!requiresReason||editor.reason.trim())&&!tooLow);
 let delta=null;
 if(editor){
  if(action==='balance'&&parsed)delta=parsed.units-BigInt(editor.wallet.balance_cents||0);
  if(action==='topup'&&parsed)delta=parsed.units;
  if(action==='edit_entry'&&parsed)delta=(editor.row.kind==='SKU_CHARGE'?-parsed.units:parsed.units)-BigInt(editor.row.amount_cents);
  if(action==='delete_entry')delta=-BigInt(editor.row.amount_cents);
  if(action==='restore_entry')delta=BigInt(editor.row.amount_cents);
 }
 const save=async()=>{
  if(!canSave||saving.current)return;
  saving.current=true;setBusy(true);setSaveError('');setNotice(null);
  sequence.current+=1;recordSequence.current+=1;setRefreshing(false);setRecordLoading(false);
  const body={action,accountId:editor.row.account_id,idempotencyKey:editor.intent};
  if(hasAmount)body.amount=isCost&&editor.unknown?null:parsed.text;
  if(editor.reason.trim())body.reason=editor.reason.trim();
  if(action==='price'||action==='clear_price')body.expectedPriceCents=editor.row.sku_price_cents==null?null:String(editor.row.sku_price_cents);
  if(action==='balance')body.expectedBalanceCents=String(editor.wallet.balance_cents??0);
  if(isEntry){body.entryId=editor.row.id;body.revision=editor.row.revision||0;}
  if(isCost){body.requestId=editor.row.id;body.revision=editor.row.billing_revision||0;}
  try{
   await apiRequest('/ai-listing/billing',{method:'POST',body});
  }catch(failure){
   setSaveError(failure.message||'操作未完成，请重试');
   if(!failure.status||failure.status>=500||(failure.status>=200&&failure.status<300)||failure.status===408)setSaveUncertain(true);
   saving.current=false;setBusy(false);return;
  }
  setEditor(null);setNotice({type:'success',text:'已保存'});
  const results=await Promise.allSettled([load(),...(recordsRef.current?[loadRecords(recordsRef.current)]:[])]);
  const failed=results.find(result=>result.status==='rejected');
  if(failed)setNotice({type:'warning',text:`已保存，但费用记录刷新失败：${failed.reason?.message||'请刷新后查看'}`});
  saving.current=false;setBusy(false);
 };
 const recordActions=(row,type)=>{
  const deleted=type==='cost'?row.billing_cost_deleted_at:row.voided_at;
  const disabled=busy||(type==='cost'&&row.status==='STARTED');
  return <Space size={4}>{deleted?<Button size="small" disabled={disabled} onClick={()=>openEditor(`restore_${type==='cost'?'cost':'entry'}`,row)}>恢复</Button>:<><Button size="small" disabled={disabled} onClick={()=>openEditor(`edit_${type==='cost'?'cost':'entry'}`,row)}>修改</Button><Button size="small" danger disabled={disabled} onClick={()=>openEditor(`delete_${type==='cost'?'cost':'entry'}`,row)}>删除</Button></>}</Space>;
 };
 const userColumn={title:'用户',key:'user',width:120,render:(_,row)=>username(row)};
 const entryColumns=[{title:'时间',dataIndex:'created_at',width:180,render:dateText},...(admin?[userColumn]:[]),{title:'商品',dataIndex:'product',ellipsis:true,width:190,render:value=>value||'—'},{title:'SKU',dataIndex:'sku',width:130,render:value=>value||'—'},{title:'类型',dataIndex:'kind',width:110,render:value=>kindName[value]||value},{title:'金额',dataIndex:'amount_cents',width:120,render:yuan},...(canManage?[{title:'操作',width:150,render:(_,row)=>recordActions(row,'wallet')}]:[])];
 const costColumns=[{title:'时间',dataIndex:'created_at',width:180,render:dateText},userColumn,{title:'商品',dataIndex:'product',width:190,ellipsis:true},{title:'请求状态',dataIndex:'status',width:110,render:value=>value==='STARTED'?<Tag color="processing">进行中</Tag>:value==='SUCCEEDED'?<Tag color="success">成功</Tag>:value==='FAILED'?<Tag color="error">失败</Tag>:value},{title:'原估算成本',dataIndex:'estimated_cost_cny',width:130,render:costText},{title:'当前估算成本',key:'effective',width:150,render:(_,row)=><>{costText(row.effective_cost_cny)}{row.billing_cost_overridden?<Tag>已更正</Tag>:null}</>},{title:'操作',width:150,render:(_,row)=>recordActions(row,'cost')}];
 const refresh=()=>{setNotice(null);void load().catch(()=>{});};

 return <Card title={admin?(management?'用户定价、余额与商品成本':'生图费用与成本'):'我的生图费用'} style={{marginBottom:20,minWidth:0}}>
  {error?<Alert type="error" showIcon title={error} style={{marginBottom:12}}/>:null}
  {notice?<Alert type={notice.type} showIcon title={notice.text} style={{marginBottom:12}}/>:null}
  <Space wrap style={{marginBottom:16}}>
   {canManage?<Select aria-label="筛选收费用户" placeholder="全部用户" allowClear showSearch optionFilterProp="label" style={{width:200}} value={user} onChange={setUser} options={(data.wallets||[]).map(row=>({value:row.account_id,label:row.username}))}/>:null}
   <Button aria-label="刷新费用记录" loading={refreshing} disabled={busy} onClick={refresh}>刷新费用记录</Button>
   {canManage?<Button onClick={()=>setHistoryOpen(true)}>修改历史</Button>:null}
  </Space>
  <p>{canManage?'单价在任务首次预留时固定；充值登记实际到账金额。更正记录会同步调整余额，并保留修改历史。':'生图前预留费用，SKU 全部图片成功后扣费；失败部分释放预留，余额不足时等待充值。'}</p>
  <section aria-label="用户钱包">
   <Table rowKey="account_id" size="small" loading={!data&&!error} dataSource={scoped(data?.wallets)}  scroll={{x:canManage?1050:650}} columns={[userColumn,{title:'SKU 单价',width:120,render:(_,row)=>row.sku_price_cents==null?'未设置':yuan(row.sku_price_cents)},{title:'余额',dataIndex:'balance_cents',width:120,render:yuan},{title:'预留',dataIndex:'reserved_cents',width:120,render:yuan},{title:'可用余额',width:120,render:(_,row)=>yuan(BigInt(row.balance_cents||0)-BigInt(row.reserved_cents||0))},...(canManage?[{title:'操作',width:390,render:(_,row)=><Space size={6} wrap><Button size="small" disabled={busy} onClick={()=>openEditor('price',row)}>修改单价</Button><Button size="small" disabled={busy||row.sku_price_cents==null} onClick={()=>openEditor('clear_price',row)}>清除单价</Button><Button size="small" disabled={busy} onClick={()=>openEditor('balance',row)}>调整余额</Button><Button size="small" type="primary" disabled={busy} onClick={()=>openEditor('topup',row)}>充值</Button></Space>}]:[])]}/>
  </section>
  {canManage?<p style={{color:'#64748b'}}>预留和可用余额由任务计算；正在使用的预留不能清除。计费 SKU 数由当前收费记录计算。</p>:null}
  <section aria-label="按商品收费汇总">
   <h3>按商品收费汇总</h3>
   <Table size="small" rowKey={row=>`${row.account_id}:${row.task_id}`} dataSource={scoped(data?.products)}  scroll={{x:canManage?750:550}} columns={[...(admin?[userColumn]:[]),{title:'商品',dataIndex:'product',ellipsis:true,width:250},{title:'计费 SKU',dataIndex:'successful_skus',width:100},{title:'已收费用',dataIndex:'charged_cents',render:yuan,width:120},...(canManage?[{title:'操作',width:120,render:(_,row)=><Button size="small" disabled={busy} onClick={()=>openRecords('wallet',row)}>管理收费</Button>}]:[])]}/>
  </section>
  <section aria-label="最近收支记录">
   <Space wrap style={{margin:'16px 0'}}><h3 style={{margin:0}}>最近收支记录（人民币）</h3><Button disabled={busy} onClick={()=>openRecords('wallet')}>{canManage?'全部收支明细':'全部收支记录'}</Button>{canManage?<><Switch aria-label="最近记录查看已删除" checked={showDeleted} onChange={setShowDeleted}/><span>查看已删除</span></>:null}</Space>
   <Table size="small" rowKey="id" dataSource={scoped(data?.entries).filter(row=>Boolean(row.voided_at)===(canManage&&showDeleted))}  columns={entryColumns} scroll={{x:canManage?1100:850}}/>
  </section>
  {admin?<section aria-label="上游成本">
   <Space wrap style={{margin:'16px 0'}}><h3 style={{margin:0}}>商品上游成本</h3>{canManage?<Button disabled={busy} onClick={()=>openRecords('cost')}>全部成本明细</Button>:null}</Space>
   <p>全部用户已知估算成本合计：{costText(data.costTotal?.estimated_cny)}；待核价请求：{data.costTotal?.unpriced||0}</p>
   <p>仅管理员可见。估算包含失败和重试；待核实不代表免费，也不等于平台实际总扣费。{canManage?'可更正已完成请求的估算金额，原记录保留。':''}</p>
   <Table size="small" rowKey={row=>`${row.account_id}:${row.task_id}`} dataSource={scoped(data.costs)}  scroll={{x:canManage?830:700}} columns={[userColumn,{title:'商品',dataIndex:'product',width:250,ellipsis:true},{title:'请求次数',dataIndex:'requests',width:100},{title:'已知估算成本',dataIndex:'estimated_cny',width:150,render:costText},{title:'待核价请求',dataIndex:'unpriced',width:110},...(canManage?[{title:'操作',width:120,render:(_,row)=><Button size="small" disabled={busy} onClick={()=>openRecords('cost',row)}>管理明细</Button>}]:[])]}/>
  </section>:null}

  <Modal open={Boolean(records)} centered width="min(1120px, calc(100vw - 32px))" title={`${records?.type==='cost'?'成本明细':'收支明细'}${records?.product?` · ${records.product}`:''}${records?.username?` · ${records.username}`:''}`} onCancel={()=>{if(!busy)setRecords(null);}} footer={<Button disabled={busy} onClick={()=>setRecords(null)}>关闭</Button>} destroyOnHidden>
   {notice?.type==='warning'?<Alert type="warning" showIcon title={notice.text} style={{marginBottom:12}}/>:null}
   {recordError?<Alert type="error" showIcon title={recordError} style={{marginBottom:12}}/>:null}
   <Space wrap style={{marginBottom:16}}>{canManage?<><Switch aria-label="查看已删除" checked={records?.deleted||false} disabled={busy} onChange={deleted=>{setRecordData(null);setRecords(value=>({...value,deleted,page:1}));}}/><span>查看已删除</span></>:null}<Button disabled={busy} loading={recordLoading} aria-label="刷新明细" onClick={()=>{setNotice(null);void loadRecords(records).catch(()=>{});}}>刷新明细</Button></Space>
   {records?.type==='cost'?<p>进行中的请求完成后才可更正。删除仅移出当前成本汇总，可在已删除记录中恢复。</p>:canManage?<p>修改、删除和恢复会按金额同步调整用户余额；每次操作都保留原因和历史。</p>:null}
   <Table size="small" rowKey="id" loading={recordLoading} dataSource={recordData?.items||[]} columns={records?.type==='cost'?costColumns:entryColumns} scroll={{x:records?.type==='cost'?1150:1000}} pagination={{current:records?.page||1,pageSize:records?.pageSize||5,total:recordData?.total||0,disabled:busy,onChange:(page,pageSize)=>{setRecordData(null);setRecords(value=>({...value,page,pageSize}));}}}/>
  </Modal>

  <Modal open={Boolean(editor)} centered width="min(560px, calc(100vw - 32px))" title={`${actionName[action]||''} · ${editor?.username||''}`} onCancel={()=>{if(!busy)setEditor(null);}} maskClosable={false} closable={!busy} destroyOnHidden footer={<Space><Button disabled={busy} onClick={()=>setEditor(null)}>取消</Button><Button aria-label="确认保存" type="primary" danger={action.startsWith('delete_')||action==='clear_price'} disabled={!canSave} loading={busy} onClick={()=>void save()}>确认保存</Button></Space>}>
   {editor?<>
    {saveError?<Alert type="error" showIcon title={saveError} style={{marginBottom:16}}/>:null}
    {saveUncertain?<Alert type="warning" showIcon title="本次提交可能已经保存" description="重试会核对同一次操作。开始新操作前，请先关闭弹窗并刷新核对费用记录。" style={{marginBottom:16}}/>:null}
    {action==='clear_price'?<Alert type="warning" showIcon title={`清除当前单价 ${yuan(editor.row.sku_price_cents)}`} description="后续新任务需重新设置单价才能预留费用；已有任务的固定单价和预留保持原记录。" style={{marginBottom:16}}/>:null}
    {isCost?<p>原估算成本：{costText(editor.row.estimated_cost_cny)}；当前：{costText(editor.row.effective_cost_cny)}。本操作只更正成本记录，用户余额按收费账本计算。</p>:null}
    {isEntry?<p>{editor.row.product||'钱包记录'}{editor.row.sku?` · SKU ${editor.row.sku}`:''} · {kindName[editor.row.kind]||editor.row.kind} · 当前记录 {yuan(editor.row.amount_cents)}</p>:null}
    {isCost&&action==='edit_cost'?<Checkbox checked={editor.unknown} disabled={busy} onChange={event=>changeEditor({unknown:event.target.checked})}>金额待核实</Checkbox>:null}
    {hasAmount?<div style={{margin:'12px 0 16px'}}>
     <label htmlFor="billing-edit-amount" style={{display:'block',marginBottom:6}}>{action==='price'?'每 SKU 单价（元）':action==='topup'?'充值金额（元）':action==='balance'?'调整后余额（元）':isCost?'估算成本（元）':'记录金额（元）'}</label>
     <Space.Compact style={{width:'100%'}}><Input id="billing-edit-amount" value={editor.amount} inputMode="decimal" disabled={busy||(isCost&&editor.unknown)} onChange={event=>changeEditor({amount:event.target.value})}/>{action==='balance'?<Button disabled={busy||BigInt(editor.wallet.reserved_cents||0)>0n} onClick={()=>changeEditor({amount:'0.00'})}>设为 0</Button>:null}</Space.Compact>
     {hasAmount&&editor.amount&&!amountValid?<p style={{color:'#cf1322',marginBottom:0}}>{positive?'请输入大于 0 的金额，最多 2 位小数。':`请输入${isEntry?'':'不小于 0 的'}金额，最多 ${isCost?6:2} 位小数。`}</p>:null}
     {action==='edit_entry'&&editor.row.kind==='SKU_CHARGE'?<p>生图收费填写不小于 0 的金额，账本按支出记录。</p>:null}
    </div>:null}
    {action==='price'?<p>当前单价：{editor.row.sku_price_cents==null?'未设置':yuan(editor.row.sku_price_cents)}；新单价：{parsed?yuan(parsed.units):'待填写'}。仅用于后续首次预留的任务。</p>:null}
    {delta!==null?<Alert type={tooLow?'error':'info'} showIcon title={`余额 ${yuan(editor.wallet.balance_cents)} → ${yuan(BigInt(editor.wallet.balance_cents||0)+delta)}；${delta>=0n?'增加':'减少'} ${yuan(delta<0n?-delta:delta)}`} description={`当前预留 ${yuan(editor.wallet.reserved_cents)}。${tooLow?'调整后余额不能少于预留；任务完成或取消后会自动结算、释放预留。':'预留由实际任务结算，余额更正不能清除正在使用的预留。'}`} style={{marginBottom:16}}/>:null}
    {action==='topup'?<p>请核对已实际收到的人民币金额后确认入账。</p>:null}
    <label htmlFor="billing-edit-reason" style={{display:'block',marginBottom:6}}>{requiresReason?'修改原因（必填）':'备注（选填）'}</label>
    <Input.TextArea id="billing-edit-reason" aria-label="修改原因" rows={3} value={editor.reason} disabled={busy} onChange={event=>changeEditor({reason:event.target.value})} placeholder="填写核对依据，便于后续追溯"/>
   </>:null}
  </Modal>

  <Modal open={historyOpen&&canManage} centered width="min(1120px, calc(100vw - 32px))" title="修改历史" onCancel={()=>setHistoryOpen(false)} footer={<Button onClick={()=>setHistoryOpen(false)}>关闭</Button>}>
   <p>最近修改记录；金额更正和删除操作均保留原始记录。</p>
   <Table size="small" rowKey={row=>row.id||`${row.created_at}:${row.action}:${row.account_id}`} dataSource={scoped(data?.history)}  scroll={{x:1100}} columns={[{title:'时间',dataIndex:'created_at',width:180,render:dateText},userColumn,{title:'操作',dataIndex:'action',width:140,render:value=>actionName[value]||value},{title:'操作人',key:'actor',width:140,render:(_,row)=>row.actor_username||row.actor_id},{title:'原因',dataIndex:'reason',width:180,render:value=>value||'—'},{title:'修改前',dataIndex:'before',width:240,render:historyValue},{title:'修改后',dataIndex:'after',width:240,render:historyValue}]}/>
  </Modal>
 </Card>;
}
