import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Popover,Radio,Spin} from 'antd';
import {GlobalOutlined} from '@ant-design/icons';
import {apiRequest} from './client-transport.js';

export default function OzonRouteSwitch({accountId,request=apiRequest}){
  const [value,setValue]=useState(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [entry]=useState(()=>{
    const params=new URLSearchParams(typeof window==='undefined'?'':window.location.search);
    return {open:params.get('ozonRoute')==='1',accountId:params.get('accountId')||''};
  });
  const accountMismatch=Boolean(entry.open&&entry.accountId&&entry.accountId!==String(accountId));
  const sequence=useRef(0),saving=useRef(false);
  async function read(){
    if(saving.current)return;
    const ticket=++sequence.current;
    try{const next=await request('/account/ozon-route');if(ticket===sequence.current){setValue(next);setError('');}}
    catch(e){if(ticket===sequence.current)setError(e.message||'线路设置读取失败，请重试');}
  }
  useEffect(()=>{
    saving.current=false;setValue(null);setOpen(entry.open);setError('');setBusy(false);void read();
    const onFocus=()=>{if(!document.hidden)void read();};
    window.addEventListener('focus',onFocus);
    return()=>{sequence.current++;window.removeEventListener('focus',onFocus);};
  },[accountId,request]);
  async function save(route){
    if(accountMismatch||saving.current||!value||route===value.route)return;
    const ticket=++sequence.current;saving.current=true;setBusy(true);setError('');
    try{
      const next=await request('/account/ozon-route',{method:'PUT',body:{route,revision:value.revision}});
      if(ticket===sequence.current){setValue(next);setBusy(false);}
    }catch(e){
      if(ticket!==sequence.current)return;
      if(e.status===409){
        try{const latest=await request('/account/ozon-route');if(ticket===sequence.current)setValue(latest);}catch{}
      }
      if(ticket===sequence.current){setBusy(false);setError(e.message||'线路保存失败，请重试');}
    }finally{if(ticket===sequence.current)saving.current=false;}
  }
  const label=value?.route==='CN'?'中国线路':value?.route==='RU'?'俄罗斯线路':'未同步';
  return <div className="ozon-route-control">
    <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={next=>{setOpen(next);if(next&&!busy)void read();}}
      content={<div className="ozon-route-popover" role="dialog" aria-label="Ozon 访问线路设置">
        <strong>Ozon 访问线路</strong>
        <p>仅作用于当前账号，Web、扩展和采集助手共用。</p>
        {accountMismatch&&<Alert type="warning" showIcon title="当前 Web 登录账号与采集助手账号不一致。请切换至采集助手使用的账号后再修改线路。"/>}
        {error&&<Alert type="error" showIcon title={error}/>}
        <Radio.Group aria-label="Ozon 访问线路" value={value?.route} disabled={accountMismatch||busy||!value} onChange={event=>void save(event.target.value)}>
          <Radio value="CN">中国线路（推荐）<small>seller.ozonru.cn</small></Radio>
          <Radio value="RU">俄罗斯线路<small>seller.ozon.ru</small></Radio>
        </Radio.Group>
        <p>扩展和采集助手会自动同步。正在进行的任务沿用启动时的线路，空闲后生效；所选线路未登录时需要登录 Seller。</p>
        {busy?<span role="status"><Spin size="small"/> 正在保存…</span>:<Button size="small" onClick={()=>void read()}>刷新状态</Button>}
      </div>}>
      <button className="qh-header-action tone-blue" type="button" aria-label={`Ozon 访问线路：${label}`} aria-haspopup="dialog" aria-expanded={open}>
        <span><GlobalOutlined/></span><div><strong>Ozon 线路</strong><em>{busy?'正在保存':label}</em></div>
      </button>
    </Popover>
  </div>;
}
