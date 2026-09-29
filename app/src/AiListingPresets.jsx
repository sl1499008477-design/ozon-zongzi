import React,{useEffect,useState,useRef} from 'react';
import {Alert,Button,Form,Input,Modal,Popconfirm,Select,Space,message} from 'antd';
import {createLatestRequestGate} from './latest-request-gate.js';
import {serializeAiListingConfig} from './ai-listing-page-state.js';
const minorAmount=value=>{const n=BigInt(value??0);const absolute=n<0n?-n:n;return `${n<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;};
export default function AiListingPresets({form,request,onChange,onManualEditRef,children}){
 const [prompts,setPrompts]=useState([]),[configs,setConfigs]=useState([]),[selected,setSelected]=useState(null);
 const [dialog,setDialog]=useState(null),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [saveError,setSaveError]=useState(''),[invalidField,setInvalidField]=useState(null);
 const applyGate=useRef(createLatestRequestGate());
 useEffect(()=>{const invalidate=()=>applyGate.current.invalidate();if(onManualEditRef)onManualEditRef.current=invalidate;return()=>{invalidate();if(onManualEditRef)onManualEditRef.current=null;};},[onManualEditRef]);
 const promptId=Form.useWatch('promptId',form);
 const load=async()=>{try{const [p,c]=await Promise.all([request('/ai-listing/presets/prompts'),request('/ai-listing/presets/configs')]);setPrompts(p.items||[]);setConfigs(c.items||[]);setError('');return p.items||[];}catch(e){setError(e.message);return null;}};
 useEffect(()=>{void load();},[request]);
 const apply=async id=>{applyGate.current.invalidate();setSelected(id||null);if(!id)return;try{
  await applyGate.current.run({request:async()=>{const [detail,p,c]=await Promise.all([request(`/ai-listing/presets/configs/${id}`),request('/ai-listing/presets/prompts'),request('/ai-listing/presets/configs')]);return {item:detail.item,prompts:p.items||[],configs:c.items||[]};},apply:({item,prompts:latest,configs:versions})=>{
   const {priceAdjustmentKopecks,...values}=item.config;const exists=latest.some(p=>p.id===values.promptId);
   setPrompts(latest);setConfigs(versions);setError('');
   form.setFieldsValue({autoSwitchStores:false,fallbackStores:[],salePricingId:undefined,salePricingUpdatedAt:undefined,realPricingId:undefined,realPricingUpdatedAt:undefined,...values,generationMode:values.generationMode||"SINGLE",priceAdjustmentAmount:minorAmount(priceAdjustmentKopecks),promptId:exists?values.promptId:undefined});onChange();
   if(!exists)message.warning('此版本引用的提示词已删除，请重新选择');else if(!values.salePricingId)message.info('已应用旧版本，请选择售价配置后保存；已有任务仍沿用原公式');else message.success('已应用上架配置');
  }});
 }catch(e){message.error(e.message);}};
 const open=mode=>{setSaveError('');setInvalidField(null);setDialog(mode);setName(mode==='update'?configs.find(c=>c.id===selected)?.name||'':'');};
 const save=async()=>{if(busy)return;applyGate.current.invalidate();setBusy(true);setSaveError('');setInvalidField(null);try{
  if(!name.trim())throw new Error('请输入版本名称');
  const values=await form.validateFields();const p=prompts.find(p=>p.id===values.promptId);if(!p)throw new Error('请选择已保存的提示词');
  const config={...serializeAiListingConfig({...values,prompt:p.content}),promptId:p.id};delete config.prompt;
  const {item}=await request(`/ai-listing/presets/configs${dialog==='update'?`/${selected}`:''}`,{method:dialog==='update'?'PUT':'POST',body:{name,config}});
  setSelected(item.id);setDialog(null);await load();message.success('上架配置已保存');
 }catch(e){setSaveError(e.errorFields?.flatMap(field=>field.errors||[]).join('；')||e.message||'保存未完成，请检查配置后重试');setInvalidField(e.errorFields?.[0]?.name||null);}finally{setBusy(false);}};
 const remove=async()=>{applyGate.current.invalidate();try{await request(`/ai-listing/presets/configs/${selected}`,{method:'DELETE'});setSelected(null);await load();message.success('配置版本已删除，当前表单值保留');}catch(e){message.error(e.message);}};
 return <>
  {error&&<Alert type="error" showIcon message={error}/>}
  <div style={{marginBottom:24}}>
   <div style={{marginBottom:8}}>上架配置版本</div>
   <p>配置和提示词用于之后创建的任务。已有任务默认沿用原配置；重试时可勾选“使用当前售价配置”，仅更新未提交 SKU 的售价计算。</p>
   <Select aria-label="上架配置版本" showSearch optionFilterProp="label" allowClear placeholder="选择已保存的配置" value={selected} onChange={apply} options={configs.map(c=>({value:c.id,label:c.name}))} style={{width:'100%',marginBottom:12}}/>
   <Space wrap><Button onClick={()=>open('new')}>另存为新版本</Button><Button disabled={!selected} onClick={()=>open('update')}>更新当前版本</Button><Popconfirm title="删除当前配置版本？" description="已有任务不受影响。" onConfirm={remove} okText="删除" cancelText="取消"><Button danger disabled={!selected}>删除版本</Button></Popconfirm><Button type="text" onClick={load}>刷新版本</Button></Space>
  </div>
  {children}
  <Form.Item label="提示词版本" name="promptId" rules={[{required:true,message:'请选择已保存的提示词'}]}>
   <Select showSearch optionFilterProp="label" placeholder="选择提示词版本" options={prompts.map(p=>({value:p.id,label:p.name}))}/>
  </Form.Item>
  {prompts.find(p=>p.id===promptId)?<details style={{marginBottom:20}}><summary>查看提示词内容</summary><p style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{prompts.find(p=>p.id===promptId).content}</p></details>:<Alert style={{marginBottom:20}} type="info" message="请先在左侧「提示词管理」中保存提示词，再返回选择。"/>}
  <Modal title={dialog==='update'?'更新当前配置版本':'另存为配置版本'} open={dialog!==null} onCancel={()=>{if(!busy)setDialog(null);}} cancelButtonProps={{disabled:busy}} closable={!busy} onOk={save} confirmLoading={busy} okText="保存" cancelText="取消">{saveError&&<Alert style={{marginBottom:16}} type="error" showIcon message="配置尚未保存" description={<>{saveError}{invalidField&&<div><Button type="link" onClick={()=>{setDialog(null);form.scrollToField(invalidField,{block:'center',focus:true});}}>返回修改</Button></div>}</>}/>}<label>版本名称<Input aria-label="配置版本名称" value={name} onChange={e=>setName(e.target.value)} maxLength={80} placeholder="例如：俄语高质量 · 测试店"/></label><p>保存当前店铺、仓库、价格、图片设置及提示词选择。</p></Modal>
 </>;
}
