import React, {useState} from 'react';
import {Alert, Form, Input, Modal, Select} from 'antd';

export default function AiListingRevisionDialog({task, request, onClose, onSaved}) {
  const original=task.submissionRevisions || [];
  const [rows,setRows]=useState(()=>original.map(row=>({...row,richText:row.richContent?JSON.stringify(row.richContent,null,2):''})));
  const [sku,setSku]=useState(original[0]?.sku),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const row=rows.find(item=>item.sku===sku);
  const change=(key,value)=>setRows(current=>current.map(item=>item.sku===sku?{...item,[key]:value}:item));
  const save=async()=>{
    if(busy)return;setError('');setBusy(true);
    try {
      const revisions=rows.flatMap((item,index)=>{
        const before=original[index],revision={sku:item.sku};
        if(item.name!==before.name){if(!item.name.trim())throw new Error(`SKU ${item.sku} 的名称不能为空`);revision.name=item.name;}
        if(item.description!==before.description)revision.description=item.description;
        if(item.richText!==(before.richContent?JSON.stringify(before.richContent,null,2):'')){
          try{revision.richContent=item.richText.trim()?JSON.parse(item.richText):null;}
          catch{throw new Error(`SKU ${item.sku} 的富内容格式有误，请使用有效 JSON 或留空`);}
          if(revision.richContent!==null&&(!revision.richContent||typeof revision.richContent!=='object'||Array.isArray(revision.richContent)))throw new Error(`SKU ${item.sku} 的富内容必须为 JSON 对象`);
        }
        return Object.keys(revision).length>1?[revision]:[];
      });
      if(!revisions.length)throw new Error('请先修改被拒绝的资料；沿用原资料可返回选择“重试任务”。');
      const result=await request(`/ai-listing/tasks/${encodeURIComponent(task.id)}/revise-and-retry`,{method:'POST',body:{expectedVersion:task.version,revisions},timeoutMs:60000});
      onSaved(result.task);
    } catch(error){setError(error.message||'保存未完成，请刷新任务后核对');}
    finally{setBusy(false);}
  };
  return <Modal open title="修订资料并重试" width={760} okText="保存并重试失败项" cancelText="返回" onOk={save}
    onCancel={()=>{if(!busy)onClose();}} confirmLoading={busy} closable={!busy} maskClosable={!busy} cancelButtonProps={{disabled:busy}}>
    <p>修订本任务已确认失败的商品资料，保存后进入队尾。原货号、已生成图片和成功商品保留。</p>
    {error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}
    <Form layout="vertical">
      <Form.Item label="失败 SKU"><Select aria-label="修订失败 SKU" value={sku} onChange={setSku} options={rows.map(item=>({value:item.sku,label:item.sku}))}/></Form.Item>
      {row&&<>
        <Form.Item label="商品名称"><Input aria-label="修订商品名称" value={row.name} maxLength={1000} onChange={event=>change('name',event.target.value)}/></Form.Item>
        <Form.Item label="商品简介"><Input.TextArea aria-label="修订商品简介" value={row.description} rows={5} maxLength={20000} onChange={event=>change('description',event.target.value)}/></Form.Item>
        <details><summary>富内容（属性 11254）</summary><p>如审核拒绝富内容，可修订其中的文字，或清空后重试。</p>
          <Input.TextArea aria-label="修订富内容 JSON" value={row.richText} rows={10} onChange={event=>change('richText',event.target.value)}/>
        </details>
      </>}
    </Form>
  </Modal>;
}
