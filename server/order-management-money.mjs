import {parseMinorUnits,formatMinorUnits} from '../shared/order-money.mjs';

const text=value=>value==null?'':String(value).trim();
const currency=value=>/^[A-Z]{3}$/.test(text(value).toUpperCase())?text(value).toUpperCase():null;
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const array=value=>Array.isArray(value)?value:[];
const quantity=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;

function money(value,code=null){
  const object=value&&typeof value==='object';
  const minor=parseMinorUnits(object?value.amount:value);
  return minor===null?null:{amount:formatMinorUnits(minor),currency:currency(object?value.currency:code)};
}
function times(value,count){return value&&count!==null?{...value,amount:formatMinorUnits(parseMinorUnits(value.amount)*BigInt(count))}:null;}
function total(values){
  if(!values.length||values.some(v=>!v))return null;
  if(values.length>1&&(!values[0].currency||values.some(v=>v.currency!==values[0].currency)))return null;
  return {amount:formatMinorUnits(values.reduce((sum,v)=>sum+parseMinorUnits(v.amount),0n)),currency:values[0].currency};
}
export const ORDER_STATUS_GROUPS=Object.freeze({
  awaiting_packaging:['awaiting_registration','awaiting_approve','awaiting_packaging'],
  awaiting_deliver:['awaiting_deliver','acceptance_in_progress','not_accepted'],
  delivering:['delivering','driver_pickup','sent_by_seller'],
  disputed:['arbitration','client_arbitration','disputed'],delivered:['delivered'],cancelled:['cancelled'],
});
export function orderStatusGroup(status){
  return Object.entries(ORDER_STATUS_GROUPS).find(([,values])=>values.includes(status))?.[0]||'other';
}

// The list APIs identify financial products by SKU (product_id is NOT the catalog product_id).
// Prices are per unit. Commission and payout are already line totals, as confirmed by
// retained multi-quantity platform rows. Preserve their sign and never multiply them again.
export function normalizeOrderPosting(raw={},scheme='FBS'){
  const financial=new Map();
  for(const item of array(raw.financial_data?.products)){
    const sku=text(item.product_id);if(!sku)continue;
    financial.set(sku,financial.has(sku)?null:item); // An ambiguous match cannot justify a margin.
  }
  const products=array(raw.products).map(p=>{
    const sku=text(p.sku),f=financial.get(sku),count=quantity(p.quantity);
    const unitSale=money(p.price,p.currency_code||p.currencyCode||raw.currency_code);
    const priceCurrency=currency(f?.currency_code)||unitSale?.currency||null;
    const sale=times(money(f?.price,priceCurrency)||unitSale,count);
    const commission=money(f?.commission??f?.commission_amount,f?.commissions_currency_code);
    // Current financial_data.payout has no documented currency. Never use the seller
    // currency or the commission currency as an implicit payout currency.
    const payout=money(f?.payout);
    return {productId:null,sku,offerId:text(p.offer_id||p.offerId),name:text(p.name||p.product_name),
      imageUrl:null,quantity:count,sale,commission,payout};
  });
  const flow=text(raw.integration_type_flow||raw.tpl_integration_type);
  const explicit=text(raw.delivery_schema||raw.shipment_type||raw.shipmentType||raw.scheme||scheme).toUpperCase();
  const actualScheme=explicit==='FBO'?'FBO':explicit==='RFBS'||/non_integrated|3pl_tracking|aggregator/.test(flow)?'rFBS':'FBS';
  const status=text(raw.status);
  return {orderId:text(raw.order_id),postingNumber:text(raw.posting_number||raw.postingNumber),orderNumber:text(raw.order_number||raw.orderNumber),scheme:actualScheme,
    status,statusGroup:orderStatusGroup(status),substatus:text(raw.substatus),
    inProcessAt:date(raw.in_process_at||raw.inProcessAt||raw.created_at),createdAt:date(raw.created_at),
    shipmentDate:date(raw.shipment_date),deliveringDate:date(raw.delivering_date),trackingNumber:text(raw.tracking_number),
    deliveryMethod:text(raw.delivery_method?.name),cancellation:raw.cancellation?{
      reason:text(raw.cancellation.cancel_reason),reasonId:text(raw.cancellation.cancel_reason_id),type:text(raw.cancellation.cancellation_type),
    }:null,products,sale:total(products.map(p=>p.sale)),commission:total(products.map(p=>p.commission)),payout:total(products.map(p=>p.payout))};
}

export function orderPostingView(base,costs={}){
  const products=base.products.map(p=>{
    const cost=costs[p.sku],unitCostCny=cost?.unitCostCny??null;
    return {...p,unitCostCny,costSource:cost?.costSource??null,
      lineCostCny:unitCostCny!==null&&p.quantity!==null?formatMinorUnits(parseMinorUnits(unitCostCny)*BigInt(p.quantity)):null};
  });
  const purchaseCostCny=products.length&&products.every(p=>p.lineCostCny!==null)
    ?formatMinorUnits(products.reduce((sum,p)=>sum+parseMinorUnits(p.lineCostCny),0n)):null;
  const matched=products.filter(p=>p.commission?.currency).length;
  const commissionMatch=products.length&&matched===products.length?'MATCHED':products.some(p=>p.commission)?'PARTIAL':'MISSING';
  let profitUnavailableReason=null;
  if(base.statusGroup==='cancelled')profitUnavailableReason='取消订单不计利润';
  else if(!products.length||products.some(p=>!p.sale))profitUnavailableReason='缺少完整成交金额';
  else if(products.some(p=>!p.commission))profitUnavailableReason='缺少平台佣金';
  else if(products.some(p=>p.sale.currency!=='CNY'||p.commission.currency!=='CNY'))profitUnavailableReason='成交金额或佣金币种未明确为人民币，且没有真实成交汇率';
  else if(purchaseCostCny===null)profitUnavailableReason='采购成本未填写完整';
  const grossProfitCny=profitUnavailableReason?null:formatMinorUnits(products.reduce((sum,p)=>{
    const fee=parseMinorUnits(p.commission.amount);
    return sum+parseMinorUnits(p.sale.amount)-(fee<0n?-fee:fee)-parseMinorUnits(p.lineCostCny);
  },0n));
  return {...base,products,commissionMatch,purchaseCostCny,grossProfitCny,profitUnavailableReason};
}
