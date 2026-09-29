import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Tag, message } from "antd";
import Table from "./PagedTable.jsx";
import { apiRequest } from "./client-transport.js";
import AiChannelCapabilityModal, { capabilityProgressLabel, capabilityResultLabel } from "./AiChannelCapabilityModal.jsx";

import {ChannelPrice,ChannelPricingEditor,ChannelSpending,channelWebsite} from "./AiChannelPricing.jsx";
import "./ai-user-channels.css";

const activeTest = channel => {
  const check = ["QUEUED","RUNNING"].includes(channel.capability_check?.status) ? channel.capability_check : null;
  const active = channel.active_test;
  if (!check) return active;
  if (!active || (check.id && active.id && check.id !== active.id)) return check;
  return { ...check, ...active, startedAt: check.startedAt || active.startedAt };
};

export default function AiUserChannelsPage({ account }) {
  const [data,setData]=useState({users:[],channels:[],requests:[]});
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [form]=Form.useForm();
  const imageProtocol=Form.useWatch("imageProtocol",form);
  const [testing,setTesting]=useState(null);
  const testLock=useRef(false);
  const [testChannelId,setTestChannelId]=useState(null);
  const [requestSearch,setRequestSearch]=useState("");
  const [now,setNow]=useState(Date.now);
  const [progressError,setProgressError]=useState(false);
  const [editing,setEditing]=useState(null);
  const [editingError,setEditingError]=useState("");
  const [intent,setIntent]=useState(()=>crypto.randomUUID());
  const reload=async()=>{const result=await apiRequest("/admin/ai-user-channels");setData(result);};
  useEffect(()=>{if(account?.role==="admin") reload().catch(()=>setError("通道读取失败，请刷新"));},[account?.id,account?.role]);
  useEffect(()=>{
    if(account?.role!=="admin")return;
    const timer=setInterval(()=>{void reload().catch(()=>{});},30_000);
    return()=>clearInterval(timer);
  },[account?.id,account?.role]);
  const watching=Boolean(testing)||data.channels.some(c=>activeTest(c));
  useEffect(()=>{
    if(!watching||account?.role!=="admin")return;
    let stopped=false;
    const tick=setInterval(()=>setNow(Date.now()),1000);
    let timer;
    const poll=async()=>{
      try{const result=await apiRequest("/admin/ai-user-channels");if(!stopped){setData(result);setProgressError(false);}}
      catch{if(!stopped)setProgressError(true);}
      finally{if(!stopped)timer=setTimeout(poll,2000);}
    };
    void poll();return()=>{stopped=true;clearInterval(tick);clearTimeout(timer);};
  },[watching,account?.id,account?.role]);
  const progressLabel=progress=>capabilityProgressLabel(progress,now);
  const testChannel=data.channels.find(c=>c.id===testChannelId);
  if(account?.role!=="admin") return <Alert type="error" title="仅管理员可管理用户通道" />;
  const userName=id=>data.users.find(user=>user.id===id)?.username||id;
  const create=async values=>{
    setBusy(true);setError("");
    try {await apiRequest("/admin/ai-user-channels",{method:"POST",body:{...values,id:intent}});
      form.setFieldValue("apiKey","");setIntent(crypto.randomUUID());await reload();message.success("专属通道已分配");
    }catch(e){setError(e.message||"保存失败");}finally{setBusy(false);}
  };
  const check=async row=>{setBusy(true);try{await apiRequest(`/admin/ai-user-channels/${encodeURIComponent(row.id)}/check`,{method:"POST",body:{}});await reload();}catch(e){setError(e.message||"检查失败");}finally{setBusy(false);}};
  const edit=row=>{setEditingError("");setEditing({...row,models:[...new Set([row.text_model,row.image_model,...(row.connection_check?.models||[])].filter(Boolean))]});};
  const saveEdit=async()=>{setEditingError("");setBusy(true);try{await apiRequest(`/admin/ai-user-channels/${encodeURIComponent(editing.id)}/models`,{method:"POST",body:{textModel:editing.text_model,imageModel:editing.image_model,billingAccount:editing.billing_account,pricing:editing.pricing??null}});setEditing(null);await reload();message.success("通道配置已保存");}catch(e){setEditingError(e.message||"保存失败");}finally{setBusy(false);}};
  const startTest=async row=>{
    if(testLock.current||activeTest(row)||!data.testSample?.available||!row.enabled||row.connection_check?.status==="MODEL_MISSING")return;
    testLock.current=true;
    const id=crypto.randomUUID();
    setNow(Date.now());setTesting({id,channelId:row.id,name:row.name,stage:"queued",startedAt:new Date().toISOString()});setError("");
    try{
      const result=await apiRequest(`/admin/ai-user-channels/${encodeURIComponent(row.id)}/test`,{method:"POST",body:{confirmed:true,id}});
      if(result?.type==="GRID_SAMPLE_V1")setData(current=>({...current,channels:current.channels.map(c=>c.id===row.id?{...c,capability_check:result,active_test:["QUEUED","RUNNING"].includes(result.status)?result:null}:c)}));
      await reload();
    }catch(e){const detail=`${e.message||"测试请求连接中断"}。请先刷新核对进度和最新结果，避免重复付费测试。`;setError(detail);throw new Error(detail);}
    finally{testLock.current=false;setTesting(null);}
  };
  const reviewTest=async(row,body)=>{
    const result=await apiRequest(`/admin/ai-user-channels/${encodeURIComponent(row.id)}/test-review`,{method:"POST",body});
    if(result?.type==="GRID_SAMPLE_V1")setData(current=>({...current,channels:current.channels.map(c=>c.id===row.id?{...c,capability_check:result}:c)}));
    await reload();
  };
  const remove=row=>Modal.confirm({title:`删除通道「${row.name}」？`,content:"删除后不再展示此通道，历史请求记录保留。",okText:"删除",cancelText:"取消",okButtonProps:{danger:true},onOk:async()=>{setBusy(true);try{await apiRequest(`/admin/ai-user-channels/${encodeURIComponent(row.id)}`,{method:"DELETE"});await reload();}catch(e){setError(e.message||"删除失败");}finally{setBusy(false);}}});
  const toggle=async row=>{setBusy(true);try{await apiRequest(`/admin/ai-user-channels/${encodeURIComponent(row.id)}/status`,{method:"POST",body:{enabled:!row.enabled}});await reload();}catch(e){setError(e.message||"操作失败");}finally{setBusy(false);}};
  return <div className="source-page">
    <div className="ai-listing-page-head">
      <div><span className="workspace-eyebrow">OZON SELLER WORKSPACE</span><h1>AI 通道配置</h1><p>为用户分配专属通道。AI 上架使用该用户获配的通道，多个通道按可用状态轮换。</p></div>
      <Button onClick={()=>reload().catch(()=>setError("刷新失败"))}>刷新</Button>
    </div>
    {watching?<Alert type="info" showIcon title="能力测试进行中" style={{marginBottom:16}} description={<div aria-live="polite">
      {data.channels.filter(c=>activeTest(c)||c.id===testing?.channelId).map(c=><div key={c.id}>{c.name}：{progressLabel(activeTest(c)||testing)}</div>)}
      <div>{progressError?"进度暂时无法更新，后台请求不会因此停止。":"页面会自动更新进度，无需重复点击测试。"}</div>
    </div>}/>:null}
    {error?<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>:null}
    <Card title="分配新通道" extra={<Button href="http://127.0.0.1:8080/" target="_blank" rel="noopener noreferrer">打开 sub2API</Button>} style={{marginBottom:20}}>
      <Form form={form} layout="vertical" onFinish={create} initialValues={{imageProtocol:"SUB2API_RESPONSES_IMAGE_TOOL",baseUrl:"http://127.0.0.1:8080/v1",textModel:"gpt-5.6-luna",imageModel:"gpt-image-2"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,420px),1fr))",gap:"0 20px"}}>
        <Form.Item name="accountId" label="注册用户" rules={[{required:true}]}><Select showSearch optionFilterProp="label" options={data.users.map(user=>({value:user.id,label:user.username}))}/></Form.Item>
        <Form.Item name="name" label="通道名称" rules={[{required:true}]}><Input placeholder="例如：用户A 图片通道1"/></Form.Item>
        <Form.Item name="billingAccount" label="网关计费账户标识" rules={[{required:true}]}><Input placeholder="填写网关中的独立账户名称，便于对账"/></Form.Item>
        <Form.Item name="baseUrl" label="API 地址" rules={[{required:true}]}><Input/></Form.Item>
        <Form.Item name="apiKey" label="独立 API Key" rules={[{required:true}]}><Input.Password autoComplete="new-password"/></Form.Item>
        <Form.Item name="imageProtocol" label="图片调用方式"><Select options={[{value:"SUB2API_OPENAI_IMAGES",label:"直接图片编辑（无需文字模型）"},{value:"SUB2API_RESPONSES_IMAGE_TOOL",label:"文字模型调用图片工具"}]}/></Form.Item>
        {imageProtocol!=="SUB2API_OPENAI_IMAGES"?<Form.Item name="textModel" label="文字模型" rules={[{required:true}]}><Input/></Form.Item>:null}
        <Form.Item name="imageModel" label="图片模型" rules={[{required:true}]}><Input/></Form.Item>
        </div>
        <Form.Item name="pricing" label="价格配置（可选）"><ChannelPricingEditor/></Form.Item>
        <p>保存会检查连接与模型目录，不调用生图。不同用户应使用不同的网关计费账户；多个 Key 共用余额账户不等于独立余额。</p>
        <Button type="primary" htmlType="submit" loading={busy}>保存并分配</Button>
      </Form>
    </Card>
    <Card title="已分配通道" style={{marginBottom:20}}><p>总花费汇总本系统通过该通道的全部请求（含能力测试），按请求当时的价格估算。失败请求和缺少价格、用量的记录列为待核实，实际扣费以网关账单为准。</p><Table className="ai-user-channel-table" rowKey="id" dataSource={data.channels} scroll={{x:1710}} columns={[
      {title:"用户",dataIndex:"account_id",width:80,render:userName},{title:"通道",dataIndex:"name",width:155,render:(name,row)=>{
        const url=channelWebsite(row.base_url);return url?<a className="ai-user-channel-name" href={url} target="_blank" rel="noopener noreferrer" title="打开通道网站">{name}</a>:name;
      }},
      {title:"网关计费账户",dataIndex:"billing_account",width:130},{title:"模型",width:160,render:(_,r)=>r.image_protocol==="SUB2API_OPENAI_IMAGES"?r.image_model:`${r.text_model} / ${r.image_model}`},
      {title:"价格",width:175,render:(_,r)=><ChannelPrice pricing={r.effective_pricing}/>},
      {title:"货币",width:110,render:(_,r)=>({CNY:"人民币（CNY）",USD:"美元（USD）"})[r.effective_pricing?.currency]||"待确认"},
      {title:"总花费",width:185,render:(_,r)=><ChannelSpending spending={r.spending}/>},
      {title:"状态",width:120,render:(_,r)=><Space direction="vertical"><Tag color={!r.enabled?"default":r.needs_attention?"error":r.failure_count?"warning":"green"}>{!r.enabled?"停用":r.needs_attention?(Date.parse(r.cooldown_until)>now?"冷却15分钟后需人工处理":"需人工处理"):r.failure_count?"等待恢复验证":"启用"}</Tag>{r.failure_count?<span>连续失败 {r.failure_count} 次</span>:null}{r.last_error_code?<small>{r.last_error_code}</small>:null}</Space>},
      {title:"连接与模型",width:120,render:(_,r)=><span>{({AVAILABLE:"连接正常",MODEL_MISSING:"模型不在网关目录中",UNAVAILABLE:"连接不可用"})[r.connection_check?.status]||"尚未检查"}</span>},
      {title:"能力测试",width:180,render:(_,r)=>{
        const progress=activeTest(r)||(r.id===testing?.channelId?testing:null);
        return <Space direction="vertical"><span>{progress?progressLabel(progress):capabilityResultLabel(r.capability_check)}</span>{!progress&&r.capability_check?.checkedAt?<small>{new Date(r.capability_check.checkedAt).toLocaleString()}</small>:null}{!progress&&r.capability_check?.errorCode?<small>{r.capability_check.errorCode}</small>:null}</Space>;
      }},
      {title:"操作",width:205,render:(_,r)=><div className="ai-user-channel-actions">
        <Button disabled={busy} onClick={()=>check(r)}>检查连接</Button>
        <Button onClick={()=>setTestChannelId(r.id)}>能力测试</Button>
        <Button disabled={busy} onClick={()=>edit(r)}>修改配置</Button>
        <Button danger={Boolean(r.enabled)} disabled={busy} onClick={()=>toggle(r)}>{r.enabled?"停用":"启用"}</Button>
        {!r.enabled?<Button danger disabled={busy||Boolean(activeTest(r))} onClick={()=>remove(r)}>删除</Button>:null}
      </div>},
    ]}/></Card>
    <Card title="每日价格核实" style={{marginBottom:20}} extra={<Button onClick={()=>reload().catch(()=>setError("核价记录读取失败"))}>刷新记录</Button>}>
      <p>生图完成后延迟约 1～2 分钟查询近期消费；同时保留每天北京时间 09:00 后的检查。服务启动后自动恢复检查，不调用 AI。仅支持 AIArtMirror；记录不代表全天完整账单，价格按实际消费样本核实。</p>
      <Table rowKey={r=>`${r.channel_id}:${r.day}`} dataSource={data.priceChecks||[]}  scroll={{x:900}} columns={[
        {title:"用户",dataIndex:"account_id",render:userName},
        {title:"通道",dataIndex:"channel_name"},
        {title:"核实时间",render:(_,r)=>new Date(r.report.checkedAt).toLocaleString()},
        {title:"状态",render:(_,r)=>{
          const p=r.report;const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
          const stale=p.status==='VERIFIED'&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(p.checkedAt))!==today;
          return <Space direction="vertical"><Tag color={p.status==='FAILED'?'error':p.changed?'warning':p.status==='VERIFIED'&&!stale?'green':'default'}>{stale?'历史核实':({VERIFIED:'今日已核实',NO_RECENT_USAGE:'今日无消费，未核实',CHECKING:'核实中',FAILED:'查询失败',WAITING_LOGS:'新消费日志尚未更新'})[p.status]}</Tag>{p.changed?<span>价格变化，请核对</span>:null}{p.errorCode==='UNSUPPORTED_BILLING_FORMAT'?<small>币种换算规则变化</small>:null}</Space>;
        }},
        {title:"最新样本价格",render:(_,r)=>r.report.latestQuota==null?'—':`¥${(r.report.latestQuota/r.report.quotaPerYuan).toFixed(5).replace(/0+$/,'').replace(/\.$/,'')} / 次`},
        {title:"样本",render:(_,r)=><Space direction="vertical"><span>{r.report.sampleCount??0} 条 · 今日 {r.report.todayCount??0} 条</span>{r.report.latestAt?<small>最新消费：{new Date(r.report.latestAt).toLocaleString()}</small>:null}{r.report.mixedPrices?<small>含不同价格：{Object.entries(r.report.distribution).map(([q,n])=>`¥${Number(q)/r.report.quotaPerYuan} × ${n}`).join('；')}</small>:null}</Space>},
      ]}/>
    </Card>
    <Card title="最近100条请求记录"><p>请求记录用于定位和对账，不代表实际扣费。金额与余额以对应网关账户账单为准；失败请求也可能收费。</p>
      <Input.Search aria-label="搜索请求记录" placeholder="搜索用户名、用户 ID 或任务唯一 ID" allowClear value={requestSearch} onChange={e=>setRequestSearch(e.target.value)} style={{width:"100%",maxWidth:480,marginBottom:16}}/>
      <Table rowKey="id" dataSource={data.requests.filter(row=>[userName(row.account_id),row.account_id,row.task_id].some(value=>String(value||"").toLowerCase().includes(requestSearch.trim().toLowerCase())))} scroll={{x:900}} columns={[
        {title:"用户",dataIndex:"account_id",render:userName},{title:"通道",dataIndex:"channel_id",render:(id,row)=>row.channel_name||data.channels.find(c=>c.id===id)?.name||id},
        {title:"任务",dataIndex:"task_id",ellipsis:true},{title:"状态",dataIndex:"status",render:s=>({STARTED:"结果待确认",SUCCEEDED:"成功",FAILED:"失败"}[s]||s)},
        {title:"错误码",dataIndex:"error_code"},{title:"网关请求ID",dataIndex:"gateway_request_id",ellipsis:true},
        {title:"时间",dataIndex:"created_at",render:s=>new Date(s).toLocaleString()},
      ]}/></Card>
    {testChannel?<AiChannelCapabilityModal key={testChannel.id} channel={testChannel} testSample={data.testSample} progress={activeTest(testChannel)||(testing?.channelId===testChannel.id?testing:null)} now={now} progressError={progressError} submitting={Boolean(testing)} busy={busy} onStart={()=>startTest(testChannel)} onReview={body=>reviewTest(testChannel,body)} onRefresh={reload} onClose={()=>setTestChannelId(null)}/>:null}
    <Modal title="修改通道配置" open={Boolean(editing)} onCancel={()=>setEditing(null)} onOk={saveEdit} confirmLoading={busy} okText="保存" cancelText="取消">
      {editingError?<Alert type="error" showIcon title={editingError} style={{marginBottom:16}}/>:null}
      {editing?<Form layout="vertical">
        <Form.Item label="网关计费账户标识"><Input value={editing.billing_account} onChange={e=>setEditing({...editing,billing_account:e.target.value})}/></Form.Item>
        {editing.image_protocol!=="SUB2API_OPENAI_IMAGES"?<Form.Item label="文字模型"><Select showSearch value={editing.text_model} options={editing.models.map(value=>({value,label:value}))} onChange={value=>setEditing({...editing,text_model:value})}/></Form.Item>:<p>直接图片编辑 · 无需文字模型</p>}
        <Form.Item label="图片模型"><Select showSearch value={editing.image_model} options={editing.models.map(value=>({value,label:value}))} onChange={value=>setEditing({...editing,image_model:value})}/></Form.Item>
        <Form.Item label="价格配置"><ChannelPricingEditor value={editing.pricing} onChange={pricing=>setEditing({...editing,pricing})}/></Form.Item>
        <p>价格修改只影响之后的请求，历史估算保留当时价格。</p>
        <p>新任务使用保存后的模型。需要刷新模型列表时，请先检查连接。更换 Key 请分配新通道，再停用旧通道。</p>
      </Form>:null}
    </Modal>
  </div>;
}
