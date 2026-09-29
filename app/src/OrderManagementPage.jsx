import React,{useEffect,useState} from 'react';
import {Alert,App,Button,Card,Descriptions,Empty,Form,Image,Input,InputNumber,Modal,Space,Spin,Tag,Tooltip} from 'antd';
import Table from "./PagedTable.jsx";
import {EditOutlined,PictureOutlined,ReloadOutlined,SyncOutlined} from '@ant-design/icons';
import {SourceSectionTitle} from './SourceTable.jsx';
import {apiRequest} from './client-transport.js';
import './order-management.css';

const statuses=[['all','所有'],['pending','待处理'],['awaiting_packaging','等待备货'],['awaiting_deliver','等待发运'],['delivering','运输中'],['disputed','有争议'],['delivered','已签收'],['cancelled','已取消'],['other','其他']];
const statusFromSearch=search=>{const status=new URLSearchParams(search).get('status');return statuses.some(([key])=>key===status)?status:'all';};
const statusNames=Object.fromEntries(statuses),syncNames={IDLE:'尚未同步',QUEUED:'等待同步',RUNNING:'正在同步',COMPLETED:'同步完成',FAILED:'同步未完成'};
const dateText=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const money=value=>value?.amount!=null?`${value.amount} ${value.currency||'（币种未确认）'}`:'—';
const cny=value=>value==null?'待补充':`¥ ${value}`;
const activeSync=value=>['QUEUED','RUNNING'].includes(value?.status);
const localDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
const defaultDates=()=>({since:localDate(new Date(Date.now()-29*86400000)),to:localDate(new Date())});
const dateRange=dates=>({since:new Date(`${dates.since}T00:00:00+08:00`).toISOString(),to:new Date(`${dates.to}T23:59:59.999+08:00`).toISOString()});
const statusTag=row=><Tag color={row.statusGroup==='delivered'?'success':row.statusGroup==='cancelled'?'default':row.statusGroup==='disputed'?'error':'blue'} title={`${row.status}${row.substatus?' / '+row.substatus:''}`}>{statusNames[row.statusGroup]||'其他'}</Tag>;
const commissionTag=row=><Tag color={row.commissionMatch==='MATCHED'?'success':row.commissionMatch==='PARTIAL'?'warning':'default'}>{row.commissionMatch==='MATCHED'?'已匹配':row.commissionMatch==='PARTIAL'?'部分匹配':'未提供'}</Tag>;
export function ProductIdentity({product}){
 const [failed,setFailed]=useState(false);
 return <div className="order-product">{product.imageUrl&&!failed?<Image src={product.imageUrl} alt={product.name} width={44} height={56} loading="lazy" onError={()=>setFailed(true)}/>:<div className="order-image-empty"><PictureOutlined/></div>}<div className="order-identity"><strong title={product.name}>{product.name||'商品名称未提供'}</strong><span>SKU {product.sku||'—'} · 数量 {product.quantity??'—'}</span>{product.offerId?<span className="order-offer" title={product.offerId}>货号 {product.offerId}</span>:null}</div></div>;
}
function OrderCostEditor({posting,storeId,onClose,onSaved}){
 const {message}=App.useApp();const [values,setValues]=useState(()=>Object.fromEntries(posting.products.map(p=>[p.sku,p.unitCostCny]))),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const changed=posting.products.filter(p=>(values[p.sku]??null)!==(p.unitCostCny??null));
 async function save(){if(busy||!changed.length)return;setBusy(true);setError('');try{const data=await apiRequest(`/ozon/order-management/postings/${encodeURIComponent(posting.postingNumber)}/costs?${new URLSearchParams({storeId,scheme:posting.scheme})}`,{method:'PUT',body:{items:changed.map(p=>({sku:p.sku,unitCostCny:values[p.sku]===null?null:String(values[p.sku])}))}});onSaved(data.posting);message.success('订单采购成本已保存');onClose();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal rootClassName="prototype-overlay" title={`订单采购成本 · ${posting.postingNumber}`} width={720} open onCancel={onClose} onOk={save} okText="保存成本" cancelText="取消" confirmLoading={busy} okButtonProps={{disabled:!changed.length}}>
  <div className="order-dialog-body"><Alert type="info" showIcon message="填写每件采购成本（人民币），系统按订单件数计算采购总额。" description="本次只修改此包裹的成本，不影响商品默认成本和其他订单。留空表示未设置；已手动清空的成本不会自动回填。"/>{error?<Alert type="error" message={error}/>:null}
   <Form layout="vertical">{posting.products.map(p=><Form.Item key={p.sku} label={<span>{p.name||p.sku} · {p.quantity??'—'} 件</span>}><InputNumber aria-label={`SKU ${p.sku} 每件采购成本`} min={0} precision={2} stringMode value={values[p.sku]} onChange={value=>setValues(previous=>({...previous,[p.sku]:value}))} addonAfter="CNY / 件" style={{width:'100%'}} disabled={busy}/></Form.Item>)}</Form>
  </div>
 </Modal>;
}
export function OrderDetail({identity,storeId,onClose,onEdit,request=apiRequest}){
 const [posting,setPosting]=useState(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setPosting(null);setError('');request(`/ozon/order-management/postings/${encodeURIComponent(identity.postingNumber)}?${new URLSearchParams({storeId,scheme:identity.scheme})}`,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setPosting(data.posting);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[storeId,identity.postingNumber,identity.scheme,request]);
 return <Modal rootClassName="prototype-overlay" title="订单详情" width={1020} open onCancel={onClose} footer={<Space><Button onClick={onClose}>关闭</Button>{onEdit&&<Button type="primary" disabled={!posting} onClick={()=>onEdit(posting)}>编辑采购成本</Button>}</Space>}>
  {error?<Alert type="error" message={error}/>:!posting?<Spin/>:<div className="order-dialog-body">
   <Descriptions size="small" column={{xs:1,sm:2,md:3}} items={[
    {key:'posting',label:'包裹编号',children:posting.postingNumber},{key:'order',label:'订单编号',children:posting.orderNumber||'—'},{key:'status',label:'履约状态',children:statusTag(posting)},
    {key:'scheme',label:'配送方式',children:posting.scheme},{key:'created',label:'订单时间（北京）',children:dateText(posting.inProcessAt||posting.createdAt)},{key:'shipment',label:'计划发运时间（北京）',children:dateText(posting.shipmentDate)},
    {key:'tracking',label:'运单编号',children:posting.trackingNumber||'未提供'},{key:'delivery',label:'物流方式',children:posting.deliveryMethod||'未提供'},
    {key:'sale',label:'成交金额',children:money(posting.sale)},{key:'commission',label:'佣金',children:<Space>{money(posting.commission)}{commissionTag(posting)}</Space>},{key:'cost',label:'采购总额',children:cny(posting.purchaseCostCny)},{key:'profit',label:'扣佣后利润',children:cny(posting.grossProfitCny)},
   ]}/>
   {posting.statusGroup==='cancelled'?<Alert type="warning" showIcon message="此订单已取消" description={posting.cancellation?.reason||'平台未提供取消原因'}/>:null}
   <p className="order-note">扣佣后利润 = 成交金额 − 佣金 − 采购成本；未计运费、退款及其他费用，不代表最终结算利润。{posting.profitUnavailableReason?` ${posting.profitUnavailableReason}`:''}</p>
   <Table rowKey="sku" dataSource={posting.products}  size="small" scroll={{x:870}} columns={[
    {title:'商品',width:330,render:(_,p)=><ProductIdentity product={p}/>},{title:'成交金额',width:125,render:(_,p)=>money(p.sale)},
    {title:'佣金',width:125,render:(_,p)=>money(p.commission)},{title:'每件采购成本',width:150,render:(_,p)=><div className="order-identity"><span>{cny(p.unitCostCny)}</span><span>{p.costSource==='MANUAL'?'手动设置':p.costSource==='PRODUCT_AUTO'?'商品自动应用':'未设置'}</span></div>},{title:'采购总额',width:125,render:(_,p)=>cny(p.lineCostCny)},
   ]}/>
  </div>}
 </Modal>;
}
export default function OrderManagementPage({binding,localData,locationSearch=''}){
 const storeId=binding?.id||localData?.currentStoreId;
 if(!storeId)return <div className="source-page"><SourceSectionTitle title="订单列表" subtitle="跟踪订单履约状态与单笔利润"/><Card><Empty description="请先选择或绑定店铺"/></Card></div>;
 return <StoreOrders key={storeId} storeId={storeId} locationSearch={locationSearch} storeName={binding?.storeName||binding?.label||binding?.displayName||'当前店铺'}/>;
}
function StoreOrders({storeId,storeName,locationSearch}){
 const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[nonce,setNonce]=useState(0),[syncBusy,setSyncBusy]=useState(false);
 const [status,setStatus]=useState(()=>statusFromSearch(locationSearch)),[search,setSearch]=useState(''),[q,setQ]=useState(''),[dates,setDates]=useState(defaultDates),[dateDraft,setDateDraft]=useState(defaultDates),[dateOpen,setDateOpen]=useState(false),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(5),[detail,setDetail]=useState(null),[cost,setCost]=useState(null);
 useEffect(()=>{setStatus(statusFromSearch(locationSearch));setPage(1);setSearch('');setQ('');setDates(defaultDates());setDetail(null);setCost(null);setData(null);},[locationSearch]);
 const range=dateRange(dates),query=new URLSearchParams({storeId,q,status,...range,page:String(page),pageSize:String(pageSize)}).toString();
 useEffect(()=>{const controller=new AbortController();let timer;setLoading(true);setError('');
  apiRequest(`/ozon/order-management/overview?${query}`,{signal:controller.signal}).then(result=>{if(controller.signal.aborted)return;setData(result);if(result.total>0&&!result.items.length&&page>1)setPage(1);if(activeSync(result.sync))timer=setTimeout(()=>setNonce(n=>n+1),2500);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>{controller.abort();clearTimeout(timer);};
 },[query,nonce]);
 async function sync(){if(syncBusy)return;setSyncBusy(true);setError('');try{await apiRequest(`/ozon/order-management/sync?storeId=${encodeURIComponent(storeId)}`,{method:'POST',body:range});setNonce(n=>n+1);}catch(e){setError(e.message);}finally{setSyncBusy(false);}}
 const counts=data?.statusCounts||{},running=activeSync(data?.sync),refresh=()=>setNonce(n=>n+1);
 const columns=[
  {title:'订单 / 商品',width:320,render:(_,row)=><div className="order-row-info"><Button type="link" className="order-posting-button" onClick={()=>setDetail(row)}>{row.postingNumber}</Button>{row.qualityInspection?.matched&&<Space size={4}><Tag color="purple" title={`按自定义编号规则识别：${row.qualityInspection.prefix}`}>质检单</Tag>{!row.qualityInspection.readAt&&<Tag color="blue">未读</Tag>}</Space>}<span className="order-note">订单 {row.orderNumber||'—'} · {row.scheme}</span>{row.products.slice(0,2).map((p,i)=><ProductIdentity key={`${p.sku}:${i}`} product={p}/>)}{row.products.length>2?<Button type="link" size="small" onClick={()=>setDetail(row)}>查看全部 {row.products.length} 种商品</Button>:null}</div>},
  {title:'状态',width:105,render:(_,row)=>statusTag(row)},
  {title:'成交金额',width:135,render:(_,row)=>money(row.sale)},
  {title:'采购总额',width:132,render:(_,row)=><Button type="text" className="order-cost-button" icon={<EditOutlined/>} onClick={()=>setCost(row)}>{cny(row.purchaseCostCny)}</Button>},
  {title:'佣金匹配',width:130,render:(_,row)=><div className="order-identity">{commissionTag(row)}<span>{money(row.commission)}</span></div>},
  {title:'扣佣后利润',width:145,render:(_,row)=><Tooltip title={row.profitUnavailableReason||'未计运费、退款及其他费用'}><span className={row.grossProfitCny==null?'order-note':String(row.grossProfitCny).startsWith('-')?'order-negative':'order-positive'}>{row.grossProfitCny==null?'待补充依据':`¥ ${row.grossProfitCny}`}</span></Tooltip>},
  {title:'订单时间 · 北京',width:158,render:(_,row)=><span className="order-date">{dateText(row.inProcessAt||row.createdAt)}</span>},
  {title:'操作',width:76,fixed:'right',render:(_,row)=><Button type="link" onClick={()=>setDetail(row)}>查看</Button>},
 ];
 return <div className="source-page order-management-page">
  <SourceSectionTitle title="订单列表" subtitle="跟踪订单履约状态与单笔利润" actions={[<Button key="refresh" icon={<ReloadOutlined/>} onClick={refresh} loading={loading&&!running}>刷新</Button>,<Button key="sync" type="primary" icon={<SyncOutlined/>} onClick={sync} loading={syncBusy||running}>同步订单</Button>]}/>
  {error?<Alert type="error" showIcon message={error} action={<Button onClick={refresh}>重试</Button>}/>:null}
  <div className="order-summary">
   <Card><span className="order-note">{storeName} · 当前筛选范围</span><strong>{counts.all??0}</strong><span className="order-note">订单包裹</span></Card>
   <Card><span className="order-note">待处理包裹</span><strong>{(counts.awaiting_packaging||0)+(counts.awaiting_deliver||0)}</strong><span className="order-note">等待备货 / 等待发运</span></Card>
   <Card><span className="order-note">平台同步</span><strong className="order-sync-label">{syncNames[data?.sync?.status]||'正在读取'}</strong><span className="order-note">{running?`已读取 ${data?.sync?.processed||0} 个包裹`:data?.sync?.completedAt?dateText(data.sync.completedAt):'同步当前日期范围的 FBS / rFBS / FBO 订单'}</span></Card>
  </div>
  {data?.sync?.lastError?<Alert type="warning" showIcon message="订单同步未完整完成" description={data.sync.lastError} action={<Button onClick={sync} disabled={running}>重新同步</Button>}/>:null}
  <Card className="order-table-card">
   <div className="order-status-tabs" role="group" aria-label="订单状态">{statuses.map(([value,label])=><Button key={value} type={status===value?'primary':'text'} onClick={()=>{setStatus(value);setPage(1);}}>{label} <span>{counts[value]||0}</span></Button>)}</div>
   <div className="order-filter-row"><span className="order-note">{dates.since} 至 {dates.to} · 北京时间</span><Space wrap><Input.Search aria-label="搜索订单" allowClear placeholder="订单号 / 商品名 / SKU / 货号" value={search} onChange={e=>{setSearch(e.target.value);if(!e.target.value){setQ('');setPage(1);}}} onSearch={value=>{setQ(value.trim());setPage(1);}}/><Button onClick={()=>{setDateDraft(dates);setDateOpen(true);}}>日期筛选</Button></Space></div>
   <Table className="order-table" rowKey={row=>`${row.scheme}:${row.postingNumber}`} dataSource={data?.items||[]} columns={columns} loading={loading} scroll={{x:1301}} pagination={{current:page,pageSize,total:data?.total||0,showTotal:total=>`共 ${total} 个包裹`,onChange:(next,size)=>{setPage(size===pageSize?next:1);setPageSize(size);}}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的订单，请调整筛选或同步订单"/>}}/>
   <p className="order-note order-profit-note">佣金使用平台返回的订单明细。成本、币种或成交汇率不足时暂不计算利润；扣佣后利润未计运费、退款和其他费用。</p>
  </Card>
  <Modal rootClassName="prototype-overlay" title="订单日期范围" open={dateOpen} onCancel={()=>setDateOpen(false)} onOk={()=>{setDates(dateDraft);setPage(1);setDateOpen(false);}} okText="应用筛选" cancelText="取消" okButtonProps={{disabled:!dateDraft.since||!dateDraft.to||dateDraft.since>dateDraft.to}}><Form layout="vertical"><Form.Item label="开始日期（北京时间）"><Input aria-label="订单开始日期" type="date" value={dateDraft.since} max={dateDraft.to} onChange={e=>{const value=e.target.value;setDateDraft(previous=>({...previous,since:value}));}}/></Form.Item><Form.Item label="结束日期（北京时间）"><Input aria-label="订单结束日期" type="date" value={dateDraft.to} min={dateDraft.since} onChange={e=>{const value=e.target.value;setDateDraft(previous=>({...previous,to:value}));}}/></Form.Item></Form><p className="order-note">同步订单会读取这个日期范围；每次同步最多一年。</p></Modal>
  {detail?<OrderDetail key={`${detail.scheme}:${detail.postingNumber}`} identity={detail} storeId={storeId} onClose={()=>setDetail(null)} onEdit={row=>{setDetail(null);setCost(row);}}/>:null}
  {cost?<OrderCostEditor key={`${cost.scheme}:${cost.postingNumber}`} posting={cost} storeId={storeId} onClose={()=>setCost(null)} onSaved={refresh}/>:null}
 </div>;
}
