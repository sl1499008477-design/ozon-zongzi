(function () {
  'use strict';
  if (!/\/(product|category|search|search-by-image|seller|brand|highlight)\b/.test(location.pathname)) return;
  let scope='',origin='',items=[],error='正在读取默认竞品真实售价计算配置',generation=0;
  const listeners=new Set();
  const emit=()=>listeners.forEach(fn=>fn());
  async function refresh(){
    const token=++generation;
    try{
      const response=await new Promise((resolve,reject)=>chrome.runtime.sendMessage({action:'getSalePricingProfiles'},value=>{
        if(chrome.runtime.lastError)reject(new Error('请刷新页面并重新连接采集账号'));else resolve(value);
      }));
      if(token!==generation)return;
      if(!response?.ok||!response.data?.accountId)throw new Error(response?.error||'请先连接粽子采集账号');
      scope=`${response.data.backendOrigin}:${response.data.accountId}`;origin=response.data.backendOrigin;items=response.data.items||[];error='';emit();
    }catch(e){if(token!==generation)return;scope='';origin='';items=[];error=e.message;emit();}
  }
  function current(currency){return items.find(item=>item.isDefault&&item.currency===currency);}
  function calculate(black,green,currency){
    const profile=current(currency);if(!profile)throw new Error(error||'默认竞品真实售价计算配置与当前币种不匹配，请在售价配置页调整');
    return globalThis.SalePricing.calculateRealPrice(profile,{currency,
      blackKopecks:globalThis.SalePricing.amountToSaleMinor(black),
      greenKopecks:green==null||green===''?null:globalThis.SalePricing.amountToSaleMinor(green)});
  }
  function renderSelector(host,currency){
    const signature=JSON.stringify([scope,currency,error,items]);
    if(host.dataset.salePricingSignature===signature)return;
    host.dataset.salePricingSignature=signature;host.replaceChildren();
    host.style.cssText='display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px';
    const label=document.createElement('span');label.setAttribute('aria-label','默认竞品真实售价计算配置');
    const profile=current(currency);label.textContent=profile?`默认：${profile.name}（${currency}）`:error||'默认竞品真实售价计算配置与当前币种不匹配';
    const button=document.createElement('button');button.type='button';button.textContent='刷新配置';button.onclick=refresh;button.style.cssText='border:0;background:transparent;color:inherit;cursor:pointer';
    host.append(label,button);
    if(/^https?:\/\//.test(origin)){
      const link=document.createElement('a');link.textContent='管理配置';link.href=origin+'/ozon/tools/sale-pricing';link.target='_blank';link.rel='noreferrer';link.style.color='inherit';host.append(link);
    }
  }
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local')return;
    if(['sonliCollectorSession','sonliCollectorAuthGeneration','sonliCollectorAuthIncarnation'].some(key=>changes[key])){
      ++generation;scope='';origin='';items=[];error='正在重新读取账号配置';emit();void refresh();
    }
  });
  window.addEventListener('focus',()=>void refresh());
  window.JzSalePricing={refresh,current,calculate,renderSelector,onChange:fn=>listeners.add(fn)};
  void refresh();
})();
