import {withoutListedSkus} from './collection-sku-rules.mjs';
import {legacyCollectStatus,projectCollectItemEnrichment} from './collect-enrichment-summary.mjs';
import {publicCategoryResolutionSummary} from './collection-public-shape.mjs';
import {createAccountSharedOzonCategoryService} from './account-shared-ozon-category-service.mjs';
import {createPostgresAccountSharedOzonCategoryRepository} from './account-shared-ozon-category-repository.mjs';

const array=value=>`CASE WHEN jsonb_typeof(${value})='array' AND ${value}<>'[]'::jsonb THEN ${value} END`;
const firstImage=value=>`COALESCE(NULLIF(${value}->>'image',''),NULLIF(${value}->>'primaryImage',''),NULLIF(${value}->>'coverImage',''),${value}#>>'{images,0,url}',${value}#>>'{images,0}','')`;
const amount=value=>`COALESCE(${value}#>>'{price,price}',CASE WHEN jsonb_typeof(${value}->'price')<>'object' THEN ${value}->>'price' END,${value}->>'priceText',${value}->>'marketingPrice',${value}->>'marketing_price',${value}->>'sellPrice','')`;
const currency=value=>`COALESCE(NULLIF(${value}->>'currencyCode',''),NULLIF(${value}->>'currency_code',''),NULLIF(${value}->>'priceCurrency',''),NULLIF(${value}->>'price_currency',''),NULLIF(${value}->>'currency',''),${value}#>>'{price,currency_code}',${value}#>>'{price,currencyCode}',${value}#>>'{price,currency}','')`;
const variantSku=value=>`COALESCE(${value}->>'sku',${value}->>'variant_id',${value}->>'product_id',${value}->>'productId','')`;
const pendingStates=new Set(['COLLECTION_FAILED','PENDING_ENRICHMENT','WAITING_FOR_SELLER','RETRYING','NEEDS_ATTENTION','COMPLETE']);
const workflowStatus=item=>item.enrichment?.status==='COLLECTION_FAILED'?'失败':!item.status||pendingStates.has(String(item.status).toUpperCase())?'待处理':legacyCollectStatus(item.status);
const variantFields=['sku','name','image','aspectValues','price','currency'];
const variantSummary=value=>Object.fromEntries(variantFields.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));

// Only list fields cross the PostgreSQL connection. Full draft/raw/image galleries
// remain behind the existing owned detail endpoint; filtering precedes pagination.
export async function readCollectSummaryPage({pool,accountId,limit=20,offset=0,status='',source='',variant='',readCategories}={}){
  accountId=String(accountId||'').trim();
  if(!accountId)throw Object.assign(new Error('采集列表必须指定账号范围'),{status:401,code:'COLLECT_ACCOUNT_REQUIRED'});
  limit=Math.max(1,Math.min(100,Math.floor(Number(limit)||20)));offset=Math.max(0,Math.floor(Number(offset)||0));
  const [collected,listed,webJobs]=await Promise.all([
    pool.query(`SELECT c.id,COALESCE(NULLIF(c.source,''),n.value->>'source',n.value->>'sourceId','') AS source,
      COALESCE(NULLIF(c.source_sku,''),n.value->>'sku','') AS sku,
      COALESCE(NULLIF(c.source_url,''),n.value->>'productUrl',n.value->>'url','') AS "productUrl",c.created_at AS "createdAt",c.updated_at AS "updatedAt",c.status,
      COALESCE(NULLIF(c.summary->>'name',''),NULLIF(n.value->>'name',''),n.value->>'title',d.data->>'title','') AS name,
      COALESCE(NULLIF(c.summary->>'image',''),NULLIF(${firstImage('n.value')},''),${firstImage('d.data')}) AS image,
      ${amount('n.value')} AS price,${currency('n.value')} AS currency,
      COALESCE(NULLIF(c.summary->'enrichment','null'::jsonb),n.value->'enrichment') AS enrichment,
      CASE WHEN n.value#>>'{raw,error}'='scrape_failed' AND ${firstImage('n.value')}='' THEN TRUE ELSE FALSE END AS scrape_failed,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'sku',${variantSku('v.value')},
        'name',COALESCE(v.value->>'name',v.value->>'title',v.value->>'productName',v.value->>'product_name',''),
        'image',COALESCE(NULLIF(${firstImage('v.value')},''),${firstImage('captured.value')}),
        'aspectValues',COALESCE(captured.value->'aspectValues',captured.value->'aspect_values',captured.value->'aspects',v.value->'aspectValues','{}'::jsonb),
        'price',CASE WHEN captured.value IS NOT NULL THEN ${amount('captured.value')} ELSE ${amount('v.value')} END,
        'currency',CASE WHEN captured.value IS NOT NULL THEN ${currency('captured.value')} ELSE ${currency('v.value')} END) ORDER BY v.position)
        FROM jsonb_array_elements(COALESCE(${array("d.data->'variants'")},source_variants.value)) WITH ORDINALITY AS v(value,position)
        LEFT JOIN LATERAL(SELECT source.value FROM jsonb_array_elements(source_variants.value) WITH ORDINALITY AS source(value,position)
          WHERE ${variantSku('source.value')}=${variantSku('v.value')} ORDER BY source.position LIMIT 1) captured ON TRUE),'[]'::jsonb) AS variants
      FROM collect_items c
      LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
      LEFT JOIN LATERAL(SELECT r.payload->'normalized' AS value FROM collect_raw_payloads r
        WHERE r.collect_item_id=c.id AND r.account_id=c.account_id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) n ON TRUE
      LEFT JOIN LATERAL(SELECT COALESCE(${array("n.value->'variants'")},${array("n.value#>'{variantData,variants}'")},
        ${array("n.value#>'{variant_data,variants}'")},${array("n.value#>'{raw,variants}'")},
        ${array("n.value->'skuList'")},${array("n.value->'sku_list'")},'[]'::jsonb) AS value) source_variants ON TRUE
      WHERE c.account_id=$1 AND c.deleted_at IS NULL ORDER BY c.updated_at DESC,c.id DESC`,[accountId]),
    pool.query(`SELECT DISTINCT item->>'sku' AS sku FROM ai_image_listing_tasks t
      CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN t.status='COMPLETED' THEN CASE WHEN jsonb_typeof(t.body#>'{source,items}')='array' THEN t.body#>'{source,items}' ELSE '[]'::jsonb END
        ELSE CASE WHEN jsonb_typeof(t.body->'submissionResults')='array' THEN t.body->'submissionResults' ELSE '[]'::jsonb END END) item
      WHERE t.account_id=$1 AND (t.status='COMPLETED' OR t.body->'submissionResults' @> '[{"importStatus":"SUCCEEDED"}]'::jsonb)
        AND (t.status='COMPLETED' OR item->>'importStatus'='SUCCEEDED') AND item->>'sku' IS NOT NULL`,[accountId]),
    pool.query(`SELECT j.id,j.sku,j.scope,j.status,j.message,j.error_code AS "errorCode",j.result,
      j.created_at AS "createdAt",j.updated_at AS "updatedAt"
      FROM ozon_web_collection_jobs j WHERE j.account_id=$1 AND (j.status<>'COMPLETED'
        OR (j.result->>'duplicate'='true' AND NOT EXISTS(SELECT 1 FROM collect_items c
          WHERE c.account_id=j.account_id AND c.id=j.result->>'collectItemId' AND c.deleted_at IS NULL)))
      ORDER BY j.created_at DESC,j.id DESC`,[accountId]),
  ]);
  const captured=collected.rows.map(row=>({...row,variants:(row.variants||[]).map(variantSummary),
    enrichment:row.enrichment|| (row.scrape_failed?{status:'COLLECTION_FAILED',lastErrorCode:'ZONGZI_SKU_SCRAPE_EMPTY'}:null)}));
  const rows=withoutListedSkus(captured,
    [{status:'COMPLETED',source:{items:listed.rows}}]).map(({listingDraft:_projection,scrape_failed:_failed,...item})=>({
      ...item,status:workflowStatus(item),variantCount:item.variants.length||1,
    }));
  const remainingIds=new Set(rows.map(item=>item.id));
  const listedRows=captured.filter(item=>!remainingIds.has(item.id)).map(({scrape_failed:_failed,...item})=>({
    ...item,status:'已上架',selectable:false,variantCount:item.variants.length||1,
  }));
  // A completed queue entry is replaced by its product row. Do not revive a
  // deleted product from old task receipts or duplicate it after publication.
  const capturedIds=new Set(captured.map(item=>item.id)),listedSkus=new Set(listed.rows.map(item=>String(item.sku)));
  for(const receipt of webJobs.rows){
    if(receipt.status==='COMPLETED'&&(!receipt.result?.duplicate||capturedIds.has(receipt.result.collectItemId)))continue;
    const job={...receipt,alreadyListed:listedSkus.has(String(receipt.sku))||String(receipt.result?.collectItemId||'').startsWith('listed:')};
    rows.push({id:job.id,sku:job.sku,name:`SKU ${job.sku}`,source:'ozon',
      productUrl:`https://www.ozon.ru/product/${job.sku}/`,createdAt:job.createdAt,updatedAt:job.updatedAt,
      status:['FAILED','WAITING'].includes(job.status)?'失败':['CANCELLED','COMPLETED'].includes(job.status)?'已跳过':'待处理',
      variants:[],variantCount:null,selectable:false,webCollectionJob:job});
  }
  rows.sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt)||0)-(Date.parse(a.updatedAt||a.createdAt)||0));
  const counts={'全部':rows.length,'待处理':0,'已上架':0,'已跳过':0,'失败':0};
  for(const item of rows)counts[item.status]=(counts[item.status]||0)+1;
  counts['已上架']+=listedRows.length;
  const sources=[...new Set([...rows,...listedRows].map(item=>item.source).filter(Boolean))].sort();
  const visible=(status==='已上架'?[...rows.filter(item=>item.status==='已上架'),...listedRows]:rows)
    .filter(item=>(!status||status==='全部'||item.status===status)&&(!source||item.source===source)
    &&(!variant||(item.webCollectionJob?variant==='单 SKU'&&item.webCollectionJob.scope==='CURRENT':variant==='多变体'?item.variantCount>1:item.variantCount<=1)));
  const items=visible.slice(offset,offset+limit);
  const products=items.filter(item=>!item.webCollectionJob);
  if(products.length){
    const ids=products.map(item=>item.id);
    const categoryReader=readCategories||createAccountSharedOzonCategoryService({repository:createPostgresAccountSharedOzonCategoryRepository({pool})}).readForItems;
    const [jobs,categories]=await Promise.all([
      pool.query(`SELECT DISTINCT ON (collect_item_id,sku) collect_item_id,sku,status,attempt_count,next_attempt_at,claim_expires_at,
        jsonb_build_object('code',last_error_json->'code','message',last_error_json->'message','diagnostic',last_error_json->'diagnostic') AS last_error_json,
        jsonb_build_object('code',error_json->'code','message',error_json->'message','diagnostic',error_json->'diagnostic') AS error_json
        FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND collect_item_id=ANY($2::text[])
        ORDER BY collect_item_id,sku,created_at DESC,id DESC`,[accountId,ids]),
      categoryReader({accountId,collectItemIds:ids}).catch(error=>{
        console.warn('collect category summary read failed',{accountId,code:/^[A-Z][A-Z0-9_]{0,119}$/.test(error?.code||'')?error.code:'CATEGORY_RESOLUTION_SUMMARY_READ_FAILED'});return [];
      }),
    ]);
    const grouped=new Map();for(const job of jobs.rows){const group=grouped.get(job.collect_item_id)||[];group.push(job);grouped.set(job.collect_item_id,group);}
    const resolutions=new Map((categories||[]).map(entry=>[entry.collectItemId,publicCategoryResolutionSummary(entry.categoryResolution)]));
    for(const item of products){item.enrichment=projectCollectItemEnrichment(item.enrichment,grouped.get(item.id));item.categoryResolution=resolutions.get(item.id)||null;}
  }
  return {items,total:visible.length,counts,sources,hasActiveWebJobs:webJobs.rows.some(job=>['QUEUED','PROCESSING','WAITING'].includes(job.status))};
}
