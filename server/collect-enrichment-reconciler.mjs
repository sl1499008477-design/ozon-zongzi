import {getPostgresPool} from './db/connection.mjs';
import {saveCollectItemEnrichmentV4} from './listing-pipeline.mjs';
import {createPostgresCollectorOzonEnrichmentRepository} from './collector-ozon-enrichment-repository.mjs';
import {mergeSkuEnrichment,skuEnrichmentSummary} from './collect-enrichment-recovery.mjs';

// Bounded keyset pages include completed drafts: old SUCCESS jobs may predate collection.
export async function reconcileCollectEnrichment({accountId=null,afterId='',limit=100,enqueueMissing=false}={}) {
 const pool=await getPostgresPool();
 const rows=(await pool.query(`SELECT c.id,c.account_id,c.source_sku,c.status,c.summary,d.data,d.version
 FROM collect_items c JOIN product_drafts d ON d.id=c.current_draft_id
 WHERE c.deleted_at IS NULL AND c.id>$1 AND ($2::text IS NULL OR c.account_id=$2)
 ORDER BY c.id LIMIT $3`,[afterId,accountId,limit])).rows;
 if(!rows.length)return {scanned:0,repaired:0,enqueued:0,afterId:''};
 const accounts=[...new Set(rows.map(r=>r.account_id))];
 const skus=[...new Set(rows.flatMap(r=>[r.source_sku,...(r.data.variants||[]).map(v=>v.sku)].filter(Boolean).map(String)))];
 const jobs=(await pool.query(`SELECT DISTINCT ON(account_id,sku) account_id,sku,collect_item_id,status,result_json,attempt_count,next_attempt_at,last_error_json,error_json
 FROM collector_ozon_enrichment_jobs WHERE account_id=ANY($1::text[]) AND sku=ANY($2::text[])
 ORDER BY account_id,sku,(status='SUCCESS') DESC,updated_at DESC`,[accounts,skus])).rows;
 const bySku=new Map(jobs.map(j=>[`${j.account_id}:${j.sku}`,j]));
 const repository=createPostgresCollectorOzonEnrichmentRepository({pool});
 let repaired=0,enqueued=0;
 for(const row of rows){
  let draft=row.data;
  const ownSkus=[row.source_sku,...(draft.variants||[]).map(v=>v.sku)].filter(Boolean).map(String);
  if (!ownSkus.some(sku=>bySku.get(`${row.account_id}:${sku}`)?.status==='SUCCESS')) continue;
  for(const sku of new Set([row.source_sku,...(draft.variants||[]).map(v=>v.sku)].filter(Boolean).map(String))){
   const job=bySku.get(`${row.account_id}:${sku}`);
   if(job?.status==='SUCCESS')draft=mergeSkuEnrichment({...draft,sku:draft.sku||row.source_sku},job.result_json);
  }
  const summary=skuEnrichmentSummary({...draft,sku:draft.sku||row.source_sku});
  const outstanding = ownSkus.filter(sku => {
   const job = bySku.get(`${row.account_id}:${sku}`);
   return job?.collect_item_id === row.id && job.status !== 'SUCCESS';
  });
  summary.missingSkus = [...new Set([...summary.missingSkus,...outstanding])];
  if (summary.missingSkus.length && summary.status === 'COMPLETE') summary.status = 'PENDING_ENRICHMENT';
  const old=row.summary?.enrichment||{};
  // Completeness recovery must not erase the executor's failure or retry state.
  if(summary.status!=='COMPLETE' && ['RETRYING','WAITING_FOR_SELLER','NEEDS_ATTENTION'].includes(old.status)) summary.status=old.status;
  if(summary.status!=='COMPLETE') {
   const incompleteJobs=summary.missingSkus.map(sku=>bySku.get(`${row.account_id}:${sku}`)).filter(j=>j?.collect_item_id===row.id);
   const job=incompleteJobs.find(j=>j.status==='FAILED') || incompleteJobs.find(j=>j.status==='PENDING' && Number(j.attempt_count)>0);
   if(job){
    summary.status=job.status==='FAILED'?'NEEDS_ATTENTION':'RETRYING';
    summary.attemptCount=Number(job.attempt_count)||0;
    summary.nextAttemptAt=job.next_attempt_at?new Date(job.next_attempt_at).toISOString():'';
    summary.lastErrorCode=job.last_error_json?.code||job.error_json?.code||'';
    if(['SELLER_CONTEXT_REQUIRED','SELLER_CONTEXT_CHANGED'].includes(summary.lastErrorCode)&&job.status!=='FAILED')summary.status='WAITING_FOR_SELLER';
   }
  }

  const changed=JSON.stringify(draft)!==JSON.stringify(row.data);
  const statusChanged=summary.status!==old.status || summary.attemptCount!==undefined && summary.attemptCount!==old.attemptCount || JSON.stringify(summary.missingFields)!==JSON.stringify(old.missingFields)||JSON.stringify(summary.missingSkus)!==JSON.stringify(old.missingSkus||[]);
  if(changed||statusChanged){
   try{
    await saveCollectItemEnrichmentV4({collectItemId:row.id,accountId:row.account_id,expectedVersion:row.version,
      listingDraft:draft,status:['COMPLETE','PENDING_ENRICHMENT','RETRYING'].includes(row.status)?summary.status:row.status,
      enrichment:{...old,attemptCount:old.attemptCount||0,...summary}});
    repaired++;
   }catch(e){if(e.code==='DRAFT_VERSION_CONFLICT')continue;throw e;}
  }
  if(enqueueMissing)for(const sku of summary.missingSkus){
   if(!sku)continue;
   const previous=bySku.get(`${row.account_id}:${sku}`);
   if(previous && (previous.status==='SUCCESS'||previous.collect_item_id===row.id))continue;
   await repository.enqueueForCollect({accountId:row.account_id,collectItemId:row.id,sku,
     requestId:`enrichment-repair:${row.id}:${sku}`,refreshBundle:true,now:new Date()});
   bySku.set(`${row.account_id}:${sku}`,{status:'PENDING',collect_item_id:row.id});enqueued++;
  }
 }
 return {scanned:rows.length,repaired,enqueued,afterId:rows.at(-1).id};
}
