import {randomUUID} from 'node:crypto';
import {pinOzonCredential} from './account-ozon-route.mjs';
import {readStoreCredentialV3} from './listing-pipeline.mjs';
import {reserveOzonWriteCapacity} from './ozon-write-rate-limit.mjs';
import {createStockOzon} from './stock-ozon.mjs';

const active=['QUEUED','RUNNING','UNCERTAIN'];
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code:'STOCK_'+code});
const dto=row=>({...row.body,id:row.id,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,nextRunAt:row.next_run_at});
const validQuantity=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647;
function normalize(input){
  if(!/^[a-f0-9-]{36}$/i.test(input?.id||'')||!/^\d+$/.test(String(input?.productId||''))||!Array.isArray(input.items)||input.items.length<1||input.items.length>100)throw fail(400,'INPUT_INVALID','请指定商品、请求编号和 1～100 个仓库');
  const seen=new Set();
  const items=input.items.map(item=>{
    const warehouseId=String(item.warehouseId||'');
    if(!/^\d+$/.test(warehouseId)||!Number.isSafeInteger(Number(warehouseId))||seen.has(warehouseId)||!validQuantity(item.targetStock)||(item.expectedStock!==null&&!validQuantity(item.expectedStock)))throw fail(400,'INPUT_INVALID','仓库不能重复，库存必须为非负整数');
    seen.add(warehouseId);return {warehouseId,expectedStock:item.expectedStock,targetStock:item.targetStock};
  }).sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId));
  return {id:input.id,productId:String(input.productId),items};
}
function outcome(items){
  if(items.some(x=>['SENDING','UNCERTAIN'].includes(x.status)))return 'UNCERTAIN';
  const good=items.filter(x=>x.status==='SUCCEEDED').length;
  return good===items.length?'COMPLETED':good?'PARTIAL':'FAILED';
}
function failureMessage(error){
  if(String(error?.code||'').startsWith('STOCK_'))return error.message;
  return `平台库存请求失败${error?.status?`（${Number(error.status)}）`:''}，请刷新库存后查看结果`;
}
export function createStockService({pool,ozon=createStockOzon(),readCredential=readStoreCredentialV3,clock=Date.now}={}){
  // Waiting HTTP retries stay outside the pool. Keep capacity for credentials,
  // journal queries and the shared limiter while one stock control lock is held.
  let controlTail=Promise.resolve(),controlWaiters=0;
  async function assertStore(scope){
    const result=await pool.query(`SELECT s.id FROM stores s JOIN accounts a ON a.id=s.owner_account_id WHERE s.id=$1 AND s.owner_account_id=$2 AND s.status<>'disabled' AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>NOW())`,[scope.storeId,scope.accountId]);
    if(!result.rowCount)throw fail(403,'STORE_FORBIDDEN','当前账号无法操作此店铺');
  }
  async function credential(scope){await assertStore(scope);const value=await readCredential(scope.storeId,scope.accountId);if(!value)throw fail(409,'CREDENTIAL_MISSING','请先配置店铺 API 凭据');return value;}
  async function productRow(scope,productId){
    await assertStore(scope);
    const row=(await pool.query('SELECT product_id,offer_id,sku,name,is_archived FROM products WHERE store_id=$1 AND product_id=$2',[scope.storeId,productId])).rows[0];
    if(!row)throw fail(404,'PRODUCT_NOT_FOUND','当前店铺没有此商品，请先刷新商品');
    return {productId:row.product_id,offerId:row.offer_id,sku:row.sku,name:row.name,archived:row.is_archived};
  }
  async function record(scope,id){
    const row=(await pool.query('SELECT * FROM ozon_stock_changes WHERE id=$1 AND account_id=$2 AND store_id=$3',[id,scope.accountId,scope.storeId])).rows[0];
    if(!row)throw fail(404,'CHANGE_NOT_FOUND','库存修改记录不存在');return row;
  }
  async function locked(scope,productId,work,wait=true){
    if(!wait&&controlWaiters)return null;
    controlWaiters++;const previous=controlTail;let releaseTurn;
    controlTail=new Promise(resolve=>{releaseTurn=resolve;});await previous;
    let client,acquired=false;const key=`stock-edit:${scope.accountId}:${scope.storeId}:${productId}`;
    try{
      client=await pool.connect();
      if(wait){await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);acquired=true;}
      else acquired=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
      return acquired?await work():null;
    }finally{
      try{if(acquired)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
      finally{client?.release();controlWaiters--;releaseTurn();}
    }
  }
  async function changes(scope,productId){
    await assertStore(scope);
    const rows=(await pool.query('SELECT * FROM ozon_stock_changes WHERE account_id=$1 AND store_id=$2 AND product_id=$3 ORDER BY created_at DESC LIMIT 20',[scope.accountId,scope.storeId,String(productId)])).rows;
    return {records:rows.map(dto)};
  }
  async function product(scope,productId){
    const p=await productRow(scope,String(productId));
    if(!p.offerId)throw fail(409,'OFFER_MISSING','商品缺少货号，请先刷新商品');
    const warehouses=await ozon.read(await credential(scope),p);
    return {product:p,warehouses:warehouses.map(w=>p.archived?{...w,writable:false,reason:'已归档商品不能修改'}:w),...(await changes(scope,productId))};
  }
  function validateFresh(p,items,warehouses){
    if(p.archived||!p.offerId)throw fail(409,'PRODUCT_UNAVAILABLE','商品已归档或货号缺失，请刷新后重新选择');
    for(const item of items){
      const w=warehouses.find(w=>w.warehouseId===item.warehouseId);
      if(!w?.writable)throw fail(409,'WAREHOUSE_UNAVAILABLE','所选仓库已停用或不支持卖家修改');
      if(w.currentStock!==item.expectedStock)throw fail(409,'CHANGED','可售库存已变化，请刷新后重新填写目标数量');
    }
  }
  async function submit(scope,input,prepared=null,operationCredential=null){
    await assertStore(scope);const request=normalize(input);
    return locked(scope,request.productId,async()=>{
      const existing=(await pool.query('SELECT * FROM ozon_stock_changes WHERE id=$1',[request.id])).rows[0];
      if(existing){
        if(existing.account_id!==scope.accountId||existing.store_id!==scope.storeId||JSON.stringify(normalize(existing.request))!==JSON.stringify(request))throw fail(409,'REQUEST_CONFLICT','请求编号已使用，请刷新记录后重试');
        return dto(existing);
      }
      const pending=(await pool.query('SELECT id FROM ozon_stock_changes WHERE account_id=$1 AND store_id=$2 AND product_id=$3 AND status=ANY($4::text[])',[scope.accountId,scope.storeId,request.productId,active])).rows[0];
      if(pending)throw fail(409,'PENDING','此商品仍有待执行或待核对的修改，请先处理记录');
      const p=await productRow(scope,request.productId);
      if(prepared&&prepared.product.offerId!==p.offerId)throw fail(409,'PRODUCT_CHANGED','商品货号已变化，请刷新后重新提交');
      const c=operationCredential||await credential(scope);
      const warehouses=prepared?.warehouses??await ozon.read(c,p);
      validateFresh(p,request.items,warehouses);
      const items=request.items.filter(x=>x.expectedStock!==x.targetStock).map(item=>({...item,warehouseName:warehouses.find(w=>w.warehouseId===item.warehouseId).name,status:'QUEUED',message:'等待执行'}));
      if(!items.length)throw fail(400,'NO_CHANGES','填写的目标数量与当前可售库存相同');
      const body={product:p,items,checks:0,...(c.ozonRoute?{ozonRoute:c.ozonRoute}:{})};
      const row=(await pool.query("INSERT INTO ozon_stock_changes(id,account_id,store_id,product_id,request,body,status,next_run_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'QUEUED',$7,$7,$7) RETURNING *",[request.id,scope.accountId,scope.storeId,p.productId,request,body,new Date(clock())])).rows[0];
      return dto(row);
    });
  }
  async function batchPreview(scope,input,operationCredential=null){
    await assertStore(scope);
    const ids=input?.productIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!/^\d+$/.test(String(id)))||new Set(ids.map(String)).size!==ids.length)throw fail(400,'BATCH_INVALID','每次请选择 1～100 个不同商品');
    const rows=(await pool.query('SELECT product_id,offer_id,sku,name,is_archived FROM products WHERE store_id=$1 AND product_id=ANY($2::text[])',[scope.storeId,ids.map(String)])).rows;
    if(rows.length!==ids.length)throw fail(404,'PRODUCT_NOT_FOUND','所选商品已变化或不属于当前店铺，请刷新');
    const products=rows.map(p=>({productId:p.product_id,offerId:p.offer_id,sku:p.sku,name:p.name,archived:p.is_archived}));
    const ready=products.filter(p=>!p.archived&&p.offerId),excluded=products.filter(p=>p.archived||!p.offerId).map(product=>({product,warehouses:[],reason:product.archived?'已归档商品不能修改':'商品缺少货号'}));
    const items=ready.length?await ozon.readMany(operationCredential||await credential(scope),ready):[];
    return {items:[...items,...excluded]};
  }
  async function batchStatus(scope,ids){
    await assertStore(scope);
    if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))throw fail(400,'BATCH_INVALID','请求编号无效');
    return {records:(await pool.query('SELECT * FROM ozon_stock_changes WHERE account_id=$1 AND store_id=$2 AND id=ANY($3::text[]) ORDER BY created_at DESC',[scope.accountId,scope.storeId,ids])).rows.map(dto)};
  }
  async function batchSubmit(scope,input){
    if(!Array.isArray(input?.requests)||!input.requests.length||input.requests.length>100)throw fail(400,'BATCH_INVALID','每次最多修改 100 个商品');
    const requests=input.requests.map(normalize),c=await credential(scope),preview=await batchPreview(scope,{productIds:requests.map(r=>r.productId)},c),results=[];
    for(const request of requests){
      try{const prepared=preview.items.find(item=>item.product.productId===request.productId);results.push({productId:request.productId,record:await submit(scope,request,prepared,c)});}
      catch(e){results.push({productId:request.productId,error:failureMessage(e),code:e.code||'STOCK_REQUEST_FAILED'});}
    }
    return {results};
  }
  async function save(row,status,nextAt=null){
    const result=await pool.query('UPDATE ozon_stock_changes SET body=$2,status=$3,next_run_at=$4,updated_at=$5 WHERE id=$1 AND account_id=$6 AND store_id=$7 RETURNING *',[row.id,row.body,status,nextAt===null?null:new Date(nextAt),new Date(clock()),row.account_id,row.store_id]);
    return result.rows[0];
  }
  async function check(row,c){
    try{
      const warehouses=await ozon.read(c,row.body.product);row.body.readError='';row.body.checkedAt=new Date(clock()).toISOString();
      for(const item of row.body.items){
        const w=warehouses.find(w=>w.warehouseId===item.warehouseId);
        item.observedStock=w?.currentStock??null;
        if(['UNCERTAIN','SENDING'].includes(item.status)){
          if(item.observedStock!==null&&item.observedStock===item.targetStock)Object.assign(item,{status:'SUCCEEDED',proof:'READBACK',message:'当前可售库存与目标一致（查询核对）'});
          else Object.assign(item,{status:'UNCERTAIN',message:'未能确认修改结果，请核对平台库存；系统不会自动重发'});
        }
      }
    }catch{row.body.readError='暂时无法读取平台库存，请稍后核对';for(const item of row.body.items)if(item.status==='SENDING')item.status='UNCERTAIN';}
    row.body.checks=(row.body.checks||0)+1;
    const status=outcome(row.body.items);
    return save(row,status,status==='UNCERTAIN'&&row.body.checks<3?clock()+[5000,20000,60000][row.body.checks-1]:null);
  }
  async function reconcile(scope,id){
    await assertStore(scope);const first=await record(scope,id);
    return locked(scope,first.product_id,async()=>{
      const row=await record(scope,id);if(row.status==='CLOSED')return dto(row);
      if(!['UNCERTAIN','RUNNING','COMPLETED','PARTIAL'].includes(row.status))throw fail(409,'NOT_SENT','此记录尚未发送或已明确失败');
      return dto(await check(row,pinOzonCredential(await credential(scope),row.body)));
    });
  }
  async function close(scope,id){
    await assertStore(scope);const first=await record(scope,id);
    return locked(scope,first.product_id,async()=>{
      const row=await record(scope,id);if(row.status!=='UNCERTAIN')throw fail(409,'NOT_UNCERTAIN','只有待核对记录可以结束核对');
      row.body.closedAt=new Date(clock()).toISOString();return dto(await save(row,'CLOSED'));
    });
  }
  async function execute(row){
    const scope={accountId:row.account_id,storeId:row.store_id};let c;
    try{c=pinOzonCredential(await credential(scope),row.body);}catch(e){
      if(row.status==='QUEUED'){for(const item of row.body.items)Object.assign(item,{status:'FAILED',message:failureMessage(e)});await save(row,'FAILED');}
      else{row.body.readError='店铺不可用，暂时无法核对';for(const item of row.body.items)if(item.status==='SENDING')item.status='UNCERTAIN';await save(row,outcome(row.body.items));}
      return;
    }
    // Persisted RUNNING means a write might already have happened before a crash.
    if(row.status!=='QUEUED'){await check(row,c);return;}
    try{
      const p=await productRow(scope,row.product_id);
      if(p.offerId!==row.body.product.offerId)throw fail(409,'PRODUCT_CHANGED','商品货号已变化，请重新提交');
      validateFresh(p,row.body.items,await ozon.read(c,p));
      const capacity=await reserveOzonWriteCapacity({pool,sellerId:c.clientId,operation:'stock',requestKey:randomUUID(),pairKeys:row.body.items.map(i=>`${p.offerId}:${i.warehouseId}`),limit:80,clock});
      if(!capacity.allowed){for(const item of row.body.items)item.message='等待平台更新间隔';await save(row,'QUEUED',clock()+capacity.retryAfterMs);return;}
    }catch(e){for(const item of row.body.items)Object.assign(item,{status:'FAILED',message:failureMessage(e)});await save(row,'FAILED');return;}
    for(const item of row.body.items)Object.assign(item,{status:'SENDING',message:'已提交平台，等待结果'});
    row.body.sentAt=new Date(clock()).toISOString();await save(row,'RUNNING',clock());
    try{
      const results=await ozon.write(c,row.body.product,row.body.items);
      row.body.items=row.body.items.map((item,index)=>({...item,...(results[index]||{status:'UNCERTAIN',message:'平台未返回此仓库结果'})}));
    }catch(e){
      const rejected=e.status>=400&&e.status<500&&![408,499].includes(e.status);
      for(const item of row.body.items)Object.assign(item,{status:rejected?'FAILED':'UNCERTAIN',message:rejected?failureMessage(e):'平台响应中断，待查询核对；系统不会自动重发'});
    }
    // Save acknowledgements before attempting an independent read-back.
    row=await save(row,outcome(row.body.items),clock());
    await check(row,c);
  }
  async function processNext(){
    const due=(await pool.query('SELECT * FROM ozon_stock_changes WHERE next_run_at<=$1 ORDER BY next_run_at,created_at LIMIT 10',[new Date(clock())])).rows;
    for(const candidate of due){
      const handled=await locked({accountId:candidate.account_id,storeId:candidate.store_id},candidate.product_id,async()=>{
        const row=(await pool.query('SELECT * FROM ozon_stock_changes WHERE id=$1 AND next_run_at<=$2',[candidate.id,new Date(clock())])).rows[0];
        if(!row)return false;await execute(row);return true;
      },false);
      if(handled)return true;
    }
    return false;
  }
  return {product,changes,submit,batchPreview,batchSubmit,batchStatus,reconcile,close,processNext};
}
