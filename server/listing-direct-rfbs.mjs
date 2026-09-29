import {createAutoListingRfbsWarehouseVerifier} from './auto-listing-rfbs-warehouse-verifier.mjs';

const blocked=(message='RFBS 仓库身份与上架快照不匹配')=>Object.assign(new Error(message),{status:422,code:'LISTING_RFBS_PHASE_SCOPE_INVALID'});
const ids=stocks=>[...new Set((stocks||[]).map(stock=>String(stock.warehouse_id)))];
async function targets(pool,accountId,storeId,stocks){
 const requested=ids(stocks);if(!requested.length)return [];
 const result=await pool.query(`SELECT w.*,s.owner_account_id AS account_id FROM warehouses w JOIN stores s ON s.id=w.store_id
  WHERE s.owner_account_id=$1 AND w.store_id=$2 AND w.warehouse_id=ANY($3::text[])`,[accountId,storeId,requested]);
 if(result.rows.length!==requested.length)throw blocked();
 return result.rows;
}
export async function verifyDirectRfbsTargets({pool,accountId,storeId,stocks,readCredential,callOzonSellerApi,correlationId,createVerifier=createAutoListingRfbsWarehouseVerifier}){
 const warehouses=await targets(pool,accountId,storeId,stocks);
 const verifier=createVerifier({loadTarget:async({targetWarehouseId})=>warehouses.find(w=>w.id===targetWarehouseId)||null,
  readCredential:({accountId,targetStoreId})=>readCredential(targetStoreId,accountId),callOzonSellerApi});
 const evidence=[];
 for(const warehouse of warehouses){
  if(String(warehouse.warehouse_type).toUpperCase()!=='RFBS')continue;
  evidence.push(await verifier.verifyRfbsWarehouse({accountId,actorAccountId:accountId,targetStoreId:storeId,targetWarehouseId:warehouse.id,correlationId}));
 }
 return evidence;
}
export async function authorizeDirectRfbsPhase(work,phase,{pool,readCredential,callOzonSellerApi,stocks,createVerifier=createAutoListingRfbsWarehouseVerifier}){
 if(!['PRE_IMPORT','PRE_STOCK'].includes(phase))throw blocked();
 const result=await pool.query(`SELECT j.id,j.account_id,j.store_id,j.snapshot_id,j.status,s.stocks,s.direct_rfbs_evidence
  FROM submission_jobs j JOIN submission_snapshots s ON s.id=j.snapshot_id AND s.account_id=j.account_id AND s.store_id=j.store_id
  WHERE j.id=$1 AND j.account_id=$2 AND j.store_id=$3 AND j.snapshot_id=$4 AND j.type<>'AUTO_LISTING'`,
  [work.id,work.account_id,work.store_id,work.snapshot_id]);
 const frozen=result.rows[0];
 if(!frozen||!(phase==='PRE_IMPORT'?['VALIDATING']:['CHECKING','RECONCILING']).includes(frozen.status))throw blocked();
 const phaseStocks=phase==='PRE_STOCK'?stocks:frozen.stocks;
 if(!Array.isArray(phaseStocks)||phaseStocks.some(stock=>!frozen.stocks.some(original=>
  original.offer_id===stock.offer_id&&String(original.warehouse_id)===String(stock.warehouse_id)&&original.stock===stock.stock)))throw blocked();
 const warehouses=await targets(pool,frozen.account_id,frozen.store_id,phaseStocks);
 const requested=ids(phaseStocks);
 const evidence=(Array.isArray(frozen.direct_rfbs_evidence)?frozen.direct_rfbs_evidence:[])
  .filter(e=>requested.includes(e.platformWarehouseId));
 for(const warehouse of warehouses){
  const matches=evidence.filter(e=>e.platformWarehouseId===String(warehouse.warehouse_id));
  if(String(warehouse.warehouse_type).toUpperCase()==='RFBS'){
   if(matches.length!==1||matches[0].warehouseRecordId!==warehouse.id||matches[0].accountId!==frozen.account_id||matches[0].storeId!==frozen.store_id)throw blocked();
  }else if(matches.length||String(warehouse.warehouse_type).toUpperCase()!=='FBS')throw blocked();
 }
 if(!evidence.length)return {required:false,phase};
 let fresh;
 try{fresh=await verifyDirectRfbsTargets({pool,accountId:frozen.account_id,storeId:frozen.store_id,stocks:phaseStocks,
  readCredential,callOzonSellerApi,createVerifier,correlationId:`direct-rfbs-${work.id}-${phase}`});}
 catch{throw Object.assign(new Error('RFBS 官方仓库核验暂不可用，稍后重试'),{status:503,code:'LISTING_RFBS_PHASE_VALIDATION_REQUIRED',retryable:true});}
 // Official verification must still cover the frozen platform identities exactly.
 if(fresh.length!==evidence.length||fresh.some(e=>!evidence.some(old=>old.warehouseRecordId===e.warehouseRecordId&&old.platformWarehouseId===e.platformWarehouseId&&old.accountId===e.accountId&&old.storeId===e.storeId)))throw blocked();
 const recorded=await pool.query(`INSERT INTO submission_events(job_id,from_status,to_status,event_type,actor_type,actor_id,payload)
  SELECT id,status,status,'submission.direct_rfbs_verified','worker',$5,$6::jsonb FROM submission_jobs
  WHERE id=$1 AND account_id=$2 AND store_id=$3 AND snapshot_id=$4 AND status=$7 RETURNING id`,
  [frozen.id,frozen.account_id,frozen.store_id,frozen.snapshot_id,'direct-rfbs',JSON.stringify({phase,snapshotId:frozen.snapshot_id,warehouseEvidence:fresh}),frozen.status]);
 if(recorded.rowCount!==1)throw blocked();
 return {required:true,phase};
}
