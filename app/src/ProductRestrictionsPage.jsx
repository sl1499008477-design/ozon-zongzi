import React,{useEffect,useState} from 'react';
import {Alert,Button,Card,Form,Input,InputNumber,Modal,Select,Space,Switch,Tag,message} from 'antd';
import Table from "./PagedTable.jsx";
import {PlusOutlined,ReloadOutlined} from '@ant-design/icons';
import {apiRequest} from './client-transport.js';
const targets=r=>Array.isArray(r?.categories)?r.categories:(r?.categoryId||r?.typeId?[{categoryId:r.categoryId,typeId:r.typeId,label:r.categoryLabel}]:[]);
const targetLabel=c=>c.label||`类目 ${c.categoryId||'不限'} · 类型 ${c.typeId||'不限'}`;
const official='https://global-help.ozon.com/zh/policies/product-rules-and-documents/product-rules/special-categories';
export default function ProductRestrictionsPage({account}){
 const [data,setData]=useState({items:[],events:[]}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[edit,setEdit]=useState(null),[search,setSearch]=useState(''),[categories,setCategories]=useState([]),[form]=Form.useForm();
 const load=async()=>{try{setData(await apiRequest('/admin/product-restrictions'));setError('');}catch(e){setError(e.message||'读取失败');}};
 useEffect(()=>{if(account?.role==='admin')void load();},[account?.id]);
 if(account?.role!=='admin')return <Alert type="error" title="仅管理员可管理平台禁售类目"/>;
 const open=row=>{setEdit(row||{});form.resetFields();form.setFieldsValue(row?{...row,keywords:row.keywords.join('\n'),selectedCategories:targets(row).map(c=>({value:`${c.categoryId||0}:${c.typeId||0}`,label:targetLabel(c)}))}:{enabled:true,action:'BLOCK',origin:'custom',selectedCategories:[],keywords:'',verifiedAt:new Date().toISOString().slice(0,10)});};
 const save=async()=>{try{const v=await form.validateFields();setBusy(true);await apiRequest('/admin/product-restrictions'+(edit.id?'/'+edit.id:''),{method:edit.id?'PUT':'POST',body:{...v,categories:(v.selectedCategories||[]).map(c=>({categoryId:Number(c.value.split(':')[0])||null,typeId:Number(c.value.split(':')[1])||null,label:c.label})),keywords:(v.keywords||'').split('\n').filter(Boolean)}});setEdit(null);await load();message.success('规则已生效');}catch(e){if(!e.errorFields)message.error(e.message||'保存失败');}finally{setBusy(false);}};
 const loadCategories=async()=>{try{setBusy(true);const r=await apiRequest('/ozon/categories/tree?language=ZH_HANS');const list=[];const walk=(nodes,path=[],parent=0)=>{for(const n of nodes||[]){const id=n.description_category_id||parent;const names=[...path,n.category_name||n.type_name].filter(Boolean);if(n.type_id)list.push({value:`${id}:${n.type_id}`,label:names.join(' / '),categoryId:id,typeId:n.type_id});walk(n.children,names,id);}};walk(r.items||r.data);setCategories(list);message.success('已加载当前店铺类目');}catch(e){message.error(e.message||'类目读取失败，请确认当前店铺');}finally{setBusy(false);}};
 return <div className="source-page">
  <div className="ai-listing-page-head"><div><span className="workspace-eyebrow">OZON SELLER WORKSPACE</span><h1>禁售类目配置</h1><p>管理采集与 AI 上架限制，查看拦截原因和规则依据。</p></div><Button icon={<ReloadOutlined/>} onClick={load}>刷新</Button></div>
  {error&&<Alert type="error" title={error} showIcon/>}
  <Card title="禁售与限制规则" extra={<Button type="primary" icon={<PlusOutlined/>} onClick={()=>open()}>新增规则</Button>}>
   <Alert type="info" showIcon title="确定禁售：拒绝采集并停止上架。待核实：可以保存采集资料，确认规则或补齐资料后才能继续上架。" description={<span>初始配置为 3 条明确类型禁售及 5 条疑似规则，非完整禁售清单；依据当前中国跨境卖家规则。规则未命中不代表平台已批准销售。关键词只作疑似提示；仓库限制单独设置。<a href={official} target="_blank" rel="noreferrer">查看 Ozon 官方依据</a></span>}/>
   <Input.Search allowClear placeholder="搜索规则、类目或原因" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:420,margin:'20px 0'}}/>
   <Table rowKey="id" dataSource={data.items.filter(r=>(r.name+r.categoryLabel+r.reason).toLowerCase().includes(search.toLowerCase()))}  scroll={{x:850}} columns={[
    {title:'规则',dataIndex:'name',render:(v,r)=><><strong>{v}</strong><div style={{color:'#64748b',fontSize:12}}>{targets(r).length?`已选 ${targets(r).length} 个类目类型：${targets(r).map(targetLabel).join('；')}`:'未限定类目类型'}</div></>},
    {title:'处理',render:(_,r)=><Tag color={!r.enabled?'default':r.action==='BLOCK'?'red':'gold'}>{!r.enabled?'已停用':r.action==='BLOCK'?'确定禁售':'待核实'}</Tag>},
    {title:'范围',render:(_,r)=><span>{r.storeId?`店铺 ${r.storeId}`:'全部店铺'}<br/>{r.warehouseId?`仓库 ${r.warehouseId}`:'全部仓库'}</span>},
    {title:'原因与依据',render:(_,r)=><><div>{r.reason}</div>{r.sourceUrl&&<a href={r.sourceUrl} target="_blank" rel="noreferrer">{r.origin==='official'?'官方依据':'参考依据'}</a>}<div>{r.verifiedAt||'待核实日期'}</div></>},
    {title:'操作',render:(_,r)=><Button onClick={()=>open(r)}>编辑</Button>}
   ]}/>
  </Card>
  <Card title="最近 100 条拦截与待核实记录" style={{marginTop:24}}><Table rowKey="id" dataSource={data.events}  scroll={{x:750}} columns={[
   {title:'时间',dataIndex:'created_at',render:v=>new Date(v).toLocaleString()}, {title:'账号',dataIndex:'account_id',ellipsis:true},{title:'SKU',dataIndex:'sku'},
   {title:'阶段',dataIndex:'stage',render:v=>({collect:'采集',generate:'生图前',submit:'提交前'}[v]||v)},
   {title:'结果',dataIndex:'decision',render:v=>v==='BLOCK'?'禁售拦截':'待核实'},
   {title:'原因',dataIndex:'matches',render:v=>v.map((m,i)=><div key={i}>{m.name}：{m.reason}</div>)}
  ]}/></Card>
  <Modal centered title={edit?.id?'编辑规则':'新增规则'} open={!!edit} onCancel={()=>setEdit(null)} onOk={save} confirmLoading={busy} width={700} styles={{body:{maxHeight:'65vh',overflowY:'auto',paddingRight:8}}} okText="保存生效" destroyOnHidden>
   <Form form={form} layout="vertical">
    <Form.Item name="name" label="规则名称" rules={[{required:true}]}><Input maxLength={120}/></Form.Item>
    <Space wrap><Form.Item name="action" label="处理方式"><Select style={{width:180}} options={[{value:'BLOCK',label:'确定禁售'},{value:'REVIEW',label:'暂停上架，待核实'}]}/></Form.Item><Form.Item name="enabled" label="生效" valuePropName="checked"><Switch/></Form.Item></Space>
    <Form.Item label="选择类目 / 商品类型（可多选）" extra="选中任意一个类目类型即可匹配；其他条件仍共同生效。">
     <Space.Compact style={{width:'100%'}}><Form.Item name="selectedCategories" noStyle><Select mode="multiple" labelInValue allowClear showSearch optionFilterProp="label" placeholder="加载类目后，可连续搜索并选择多个" style={{flex:1,minWidth:0}} maxTagCount="responsive" options={categories}/></Form.Item><Button onClick={loadCategories} loading={busy}>加载类目</Button></Space.Compact>
    </Form.Item>
    <Form.Item name="keywords" label="疑似关键词（每行一个，仅用于待核实）"><Input.TextArea rows={2}/></Form.Item>
    <Space wrap><Form.Item name="storeId" label="限定店铺 ID（留空为全部）"><Input/></Form.Item><Form.Item name="warehouseId" label="限定仓库 ID（留空为全部）"><Input/></Form.Item></Space>
    <Space wrap><Form.Item name="attributeId" label="条件属性 ID（可选）"><InputNumber min={1} precision={0}/></Form.Item><Form.Item name="attributeValue" label="属性等于（缺失则待核实）"><Input/></Form.Item></Space>
    <Form.Item name="reason" label="拦截原因 / 待确认条件" rules={[{required:true}]}><Input.TextArea rows={2} maxLength={1000}/></Form.Item>
    <Space wrap><Form.Item name="origin" label="依据类型"><Select style={{width:150}} options={[{value:'official',label:'官方规则'},{value:'custom',label:'管理员规则'}]}/></Form.Item><Form.Item name="verifiedAt" label="核实日期"><Input type="date"/></Form.Item></Space>
    <Form.Item name="sourceUrl" label="依据链接"><Input placeholder="https://…"/></Form.Item>
   </Form>
  </Modal>
 </div>;
}
