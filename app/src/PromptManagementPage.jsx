import React, {useEffect,useState} from 'react';
import {Button,Card,Empty,Form,Input,Modal,Popconfirm,Space,message} from 'antd';
import Table from "./PagedTable.jsx";
import {apiRequest} from './client-transport.js';
import {AI_LISTING_DEFAULT_PROMPT} from './ai-listing-page-state.js';
export default function PromptManagementPage({request=apiRequest}) {
 const [items,setItems]=useState([]),[loading,setLoading]=useState(false),[query,setQuery]=useState('');
 const [editing,setEditing]=useState(null),[saving,setSaving]=useState(false);const [form]=Form.useForm();
 const load=async()=>{setLoading(true);try{setItems((await request('/ai-listing/presets/prompts')).items||[]);}catch(e){message.error(e.message);}finally{setLoading(false);}};
 useEffect(()=>{void load();},[request]);
 const edit=item=>{setEditing(item||{});form.setFieldsValue(item||{name:'',content:AI_LISTING_DEFAULT_PROMPT});};
 const save=async()=>{try{const values=await form.validateFields();setSaving(true);await request(`/ai-listing/presets/prompts${editing.id?`/${editing.id}`:''}`,{method:editing.id?'PUT':'POST',body:values});setEditing(null);message.success('提示词已保存');await load();}catch(e){if(!e.errorFields)message.error(e.message);}finally{setSaving(false);}};
 const remove=async id=>{try{await request(`/ai-listing/presets/prompts/${id}`,{method:'DELETE'});message.success('提示词已删除');await load();}catch(e){message.error(e.message);}};
 return <div className="ai-listing-page">
  <div className="ai-listing-page__header"><div><h1>提示词管理</h1><p>为自己的提示词命名并保存，在 AI 上架时直接选择。修改和删除不会影响已创建的任务。</p></div></div>
  <Card title="已保存的提示词" extra={<Button type="primary" onClick={()=>edit(null)}>新增提示词</Button>}>
   <Input.Search aria-label="搜索提示词" placeholder="搜索版本名称或提示词内容" allowClear value={query} onChange={e=>setQuery(e.target.value)} style={{maxWidth:400,marginBottom:20}} />
   <Table rowKey="id" loading={loading} dataSource={items.filter(i=>`${i.name}\n${i.content}`.toLowerCase().includes(query.toLowerCase()))} locale={{emptyText:<Empty description="暂无提示词，请先新增"/>}}  columns={[
    {title:'版本名称',dataIndex:'name',width:'22%'},
    {title:'提示词内容',dataIndex:'content',render:value=><div style={{whiteSpace:'pre-wrap',display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',overflow:'hidden'}}>{value}</div>},
    {title:'操作',width:160,render:(_,item)=><Space wrap><Button onClick={()=>edit(item)}>查看 / 编辑</Button><Popconfirm title="删除这条提示词？" description="引用它的配置需要重新选择提示词，已有任务不受影响。" onConfirm={()=>remove(item.id)} okText="删除" cancelText="取消"><Button danger>删除</Button></Popconfirm></Space>},
   ]}/>
  </Card>
  <Modal title={editing?.id?'编辑提示词':'新增提示词'} open={editing!==null} onCancel={()=>setEditing(null)} onOk={save} confirmLoading={saving} okText="保存" cancelText="取消" width={720}>
   <Form form={form} layout="vertical"><Form.Item name="name" label="版本名称" rules={[{required:true,whitespace:true,message:'请输入版本名称'}]}><Input maxLength={80} placeholder="例如：俄语商品图重设计"/></Form.Item><Form.Item name="content" label="提示词内容" rules={[{required:true,whitespace:true,message:'请输入提示词内容'}]}><Input.TextArea rows={12} maxLength={20000} showCount/></Form.Item></Form>
  </Modal>
 </div>;
}
