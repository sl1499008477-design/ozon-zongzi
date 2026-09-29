import React from 'react';
import {Input, Select} from 'antd';

export function channelWebsite(baseUrl) {
  try {
    const url=new URL(baseUrl);
    return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?`${url.origin}/`:null;
  } catch {return null;}
}

export function ChannelPricingEditor({value,onChange}) {
  const update=patch=>onChange({...value,...patch});
  return <div className="ai-channel-pricing-editor">
    <label>计价方式<Select aria-label="计价方式" value={value?.mode||''} onChange={mode=>onChange(mode?{mode,currency:value?.currency||'CNY'}:null)} options={[
      {value:'',label:'未配置'}, {value:'REQUEST',label:'按次'}, {value:'TOKEN',label:'按量（token）'},
    ]}/></label>
    {value?.mode&&<>
      <label>货币<Select aria-label="货币" value={value.currency} onChange={currency=>update({currency})} options={[{value:'CNY',label:'人民币（CNY）'},{value:'USD',label:'美元（USD）'}]}/></label>
      {value.mode==='REQUEST'?<label>每次请求价格<Input aria-label="每次请求价格" inputMode="decimal" placeholder="例如 0.2" value={value.requestPrice??''} onChange={e=>update({requestPrice:e.target.value})}/></label>:<>
        <label>输入价格 / 1M tokens<Input aria-label="输入价格 / 1M tokens" inputMode="decimal" value={value.inputPrice??''} onChange={e=>update({inputPrice:e.target.value})}/></label>
        <label>补全价格 / 1M tokens<Input aria-label="补全价格 / 1M tokens" inputMode="decimal" value={value.outputPrice??''} onChange={e=>update({outputPrice:e.target.value})}/></label>
      </>}
    </>}
    <p>按网关报价填写，最多6位小数。未配置时，有历史核价样本的通道会按样本估算。</p>
    {value?.mode==='TOKEN'&&<p>适用于统一按输入、补全 token 计费的通道；另收图片、缓存或工具费用时，须以网关账单核对。</p>}
  </div>;
}

export function ChannelPrice({pricing}) {
  if(!pricing)return <span className="ai-channel-muted">未配置</span>;
  return <div className="ai-channel-money">
    {pricing.mode==='REQUEST'?<><span>按次</span><span>{pricing.requestPrice} / 次请求</span></>:<>
      <span>按量 · 每 1M tokens</span><span>输入 {pricing.inputPrice}</span><span>补全 {pricing.outputPrice}</span>
    </>}
    {pricing.source==='PRICE_SAMPLE'&&<small title={pricing.checkedAt?`核价时间：${new Date(pricing.checkedAt).toLocaleString()}`:undefined}>历史核价样本</small>}
  </div>;
}

const amountText=value=>String(value).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
export function ChannelSpending({spending}) {
  if(!spending)return <span className="ai-channel-muted">—</span>;
  const {totals,requestCount,unpricedCount,pendingCount,failedCount}=spending;
  return <div className="ai-channel-money">
    {totals.map(total=><span key={total.currency}>{total.currency==='CNY'?'¥':'$'}{amountText(total.amount)} <small>{total.currency} · 估算</small></span>)}
    {!totals.length&&<span>{requestCount?'待核实':'暂无请求'}</span>}
    {!!unpricedCount&&<small>{unpricedCount} 次费用待核实{failedCount?`（含 ${failedCount} 次失败）`:''}</small>}
    {!!pendingCount&&<small>{pendingCount} 次请求处理中</small>}
    {!!totals.length&&<small>已计价 {totals.reduce((n,t)=>n+t.requests,0)} / {requestCount} 次</small>}
  </div>;
}
