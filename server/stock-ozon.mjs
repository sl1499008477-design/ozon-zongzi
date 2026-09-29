import {callOzonSellerApi} from './ozon-client.mjs';

const id=value=>String(value??'');
const quantity=value=>value!==null&&value!==''&&value!==undefined&&Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
function invalid(){return Object.assign(new Error('Ozon 库存响应不完整，请重新读取'),{code:'STOCK_RESPONSE_INVALID',status:502});}
function safeMessage(errors,credential){
  let result=errors.map(e=>`${e.code||'ZONGZI_ERROR'}: ${e.message||'平台拒绝修改'}`).join('；').slice(0,800);
  for(const secret of [credential.apiKey,credential.clientId])if(secret)result=result.replaceAll(String(secret),'[REDACTED]');
  return result;
}
export function createStockOzon({call=callOzonSellerApi}={}){
  async function pages(credential,path,body,field){
    const rows=[],seen=new Set();let cursor;
    for(let page=0;page<100;page++){
      const data=await call(credential,path,{...body,...(cursor?{cursor}:{})});
      if(!Array.isArray(data?.[field]))throw invalid();
      rows.push(...data[field]);
      if(!data.has_next)return rows;
      if(!data.cursor||seen.has(data.cursor))throw invalid();
      cursor=data.cursor;seen.add(cursor);
    }
    throw invalid();
  }
  async function readMany(credential,products){
    // This warehouse API returns seller FBS/rFBS warehouses, not Ozon FBO stock.
    const warehouses=await pages(credential,'/v2/warehouse/list',{limit:200},'warehouses');
    const stocks=await pages(credential,'/v2/product/info/stocks-by-warehouse/fbs',{offer_id:products.map(p=>p.offerId),limit:1000},'products');
    if(stocks.some(stock=>!stock.offer_id&&!stock.product_id))throw invalid();
    return products.map(product=>{
    const byWarehouse=new Map();
    for(const stock of stocks){
      if(stock.offer_id&&id(stock.offer_id)!==product.offerId)continue;
      if(stock.product_id&&id(stock.product_id)!==product.productId)continue;
      const key=id(stock.warehouse_id);if(!key||byWarehouse.has(key))throw invalid();
      byWarehouse.set(key,stock);
    }
    return {product,warehouses:warehouses.map(warehouse=>{
      const warehouseId=id(warehouse.warehouse_id),stock=byWarehouse.get(warehouseId);
      const present=quantity(stock?.present),reserved=quantity(stock?.reserved);
      const currentStock=quantity(stock?.free_stock)??(present!==null&&reserved!==null&&present>=reserved?present-reserved:null);
      const status=String(warehouse.status||'').toLowerCase();
      const writable=status==='created'&&!['fbo','fbp'].includes(String(warehouse.warehouse_type||'').toLowerCase());
      return {warehouseId,name:warehouse.name||warehouseId,scheme:warehouse.is_rfbs?'rFBS':'FBS',status,currentStock,present,reserved,writable,reason:writable?'':'仓库未启用或不支持卖家修改'};
    })};
    });
  }
  async function read(credential,product){return (await readMany(credential,[product]))[0].warehouses;}

  async function write(credential,product,items){
    const data=await call(credential,'/v2/products/stocks',{stocks:items.map(item=>({offer_id:product.offerId,warehouse_id:Number(item.warehouseId),stock:item.targetStock}))});
    return items.map(item=>{
      const matches=(Array.isArray(data?.result)?data.result:[]).filter(row=>id(row.warehouse_id)===item.warehouseId&&(row.offer_id||row.product_id)&&(!row.offer_id||id(row.offer_id)===product.offerId)&&(!row.product_id||id(row.product_id)===product.productId));
      if(matches.length!==1)return {status:'UNCERTAIN',message:'平台未返回唯一的仓库结果，待核对'};
      const row=matches[0],errors=Array.isArray(row.errors)?row.errors:[];
      if(row.updated===true&&Array.isArray(row.errors)&&!errors.length)return {status:'SUCCEEDED',message:'平台已确认修改',proof:'ACKNOWLEDGED'};
      if(row.updated===false&&errors.length)return {status:'FAILED',message:safeMessage(errors,credential)};
      return {status:'UNCERTAIN',message:'平台返回的修改状态不明确，待核对'};
    });
  }
  return {read,readMany,write};
}
