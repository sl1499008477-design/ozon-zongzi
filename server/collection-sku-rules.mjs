const listedSkuSql = parameter => `((t.status='COMPLETED' AND t.body->'source'->'items' @> ${parameter}::jsonb)
 OR t.body->'submissionResults' @> jsonb_build_array(jsonb_build_object('sku',(${parameter}::jsonb->0->>'sku'),'importStatus','SUCCEEDED')))`;
export async function findCollectedSku(client,accountId,sku,capturedSkus=[sku]) {
 const skus=[...new Set([String(sku),...capturedSkus.map(String)])];
 // A collected/listed anchor does not prove that its newly captured siblings exist.
 // Check the whole incoming group in one query before skipping the upload.
 if(skus.length>1){
  const missing=(await client.query(`WITH requested AS (
   SELECT value->>'sku' AS sku,jsonb_build_array(value) AS item FROM jsonb_array_elements($2::jsonb)
  ) SELECT r.sku FROM requested r
  WHERE NOT EXISTS(SELECT 1 FROM collect_items c LEFT JOIN product_drafts d ON d.id=c.current_draft_id
   WHERE c.account_id=$1 AND c.source='ozon' AND c.deleted_at IS NULL
    AND (c.source_sku=r.sku OR d.data->'variants' @> r.item))
   AND NOT EXISTS(SELECT 1 FROM ai_image_listing_tasks t WHERE t.account_id=$1 AND ${listedSkuSql('r.item')})
  LIMIT 1`,[accountId,JSON.stringify(skus.map(sku=>({sku})))] )).rows[0];
  if(missing)return null;
 }
 const row=(await client.query(`SELECT c.id,c.status,c.source_sku,c.deleted_at,d.data AS draft,
 c.summary,raw.payload, EXISTS(SELECT 1 FROM ai_image_listing_tasks t WHERE t.account_id=c.account_id AND ${listedSkuSql('$3')}) AS listed FROM collect_items c LEFT JOIN product_drafts d ON d.id=c.current_draft_id
 LEFT JOIN LATERAL(SELECT payload FROM collect_raw_payloads WHERE collect_item_id=c.id AND account_id=c.account_id ORDER BY created_at DESC LIMIT 1)raw ON TRUE
 WHERE c.account_id=$1 AND (c.deleted_at IS NULL OR EXISTS(SELECT 1 FROM ai_image_listing_tasks t WHERE t.account_id=c.account_id AND ${listedSkuSql('$3')})) AND (c.source_sku=$2 OR d.data->'variants' @> $3::jsonb)
 ORDER BY (c.source_sku=$2) DESC,c.created_at ASC LIMIT 1`,[accountId,String(sku),JSON.stringify([{sku:String(sku)}])])).rows[0];
 if(!row){
  const listed=(await client.query(`SELECT t.id FROM ai_image_listing_tasks t WHERE t.account_id=$1 AND ${listedSkuSql('$2')} LIMIT 1`,[accountId,JSON.stringify([{sku:String(sku)}])])).rows[0];
  return listed?{id:`listed:${sku}`,sku:String(sku),status:'COMPLETED',collectionState:'LISTED'}:null;
 }
 return {...row.payload?.normalized,id:row.id,sku:row.source_sku,status:row.status,listingDraft:row.draft,
 enrichment:row.summary?.enrichment,previouslyDeleted:!!row.deleted_at,collectionState:row.listed?"LISTED":"COLLECTED"};
}
export function withoutListedSkus(items,completedTasks) {
 const done=new Set(completedTasks.flatMap(t=>t.status&&t.status!=='COMPLETED'
  ?(t.submissionResults||[]).filter(row=>row.importStatus==='SUCCEEDED').map(row=>String(row.sku))
  :t.source?.items?.map(i=>String(i.sku))||[]));
 return items.flatMap(item=>{
  const variants=item.listingDraft?.variants?.length?item.listingDraft.variants:item.variants||[];
  if(variants.length>0){
   const remaining=variants.filter(v=>!done.has(String(v.sku)));
   if(!remaining.length)return [];
   if(remaining.length===variants.length)return [item];
   // The collect-box UI also merges source arrays; filter that read projection
   // while preserving the complete stored capture and its listing history.
   const projectSource=source=>{
    const projected={...source};
    for(const key of ['variants','skuList','sku_list']){
     if(Array.isArray(source?.[key]))projected[key]=source[key].filter(v=>!done.has(String(v.sku)));
    }
    for(const key of ['variantData','variant_data']){
     if(Array.isArray(source?.[key]?.variants))projected[key]={...source[key],variants:source[key].variants.filter(v=>!done.has(String(v.sku)))};
    }
    return projected;
   };
   return [{...projectSource(item),...(item.raw?{raw:projectSource(item.raw)}:{}),variants:remaining,listingDraft:{...item.listingDraft,variants:remaining}}];
  }
  return done.has(String(item.sku))?[]:[item];
 });
}

// Active draft ownership, including legacy independent SKU drafts. Never infer a
// source from the entry SKU when another existing draft owns the sibling's edits.
export async function findOzonCollectedSkuSources(client, accountId, values) {
 const skus=[...new Set(values.map(String))];
 if(!skus.length)return new Map();
 const json=skus.flatMap(sku=>[JSON.stringify([{sku}]),...(/^\d+$/.test(sku)&&Number.isSafeInteger(Number(sku))?[JSON.stringify([{sku:Number(sku)}])]:[])]);
 const {rows}=await client.query(`SELECT c.id,c.source_sku,d.data FROM collect_items c
  LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
  WHERE c.account_id=$1 AND c.source IN ('ozon','AUTO_LISTING_EXCEL_SKU') AND c.deleted_at IS NULL
    AND (c.source_sku=ANY($2::text[]) OR d.data->'variants' @> ANY($3::jsonb[]))
  ORDER BY c.created_at,c.id`,[accountId,skus,json]);
 const requested=new Set(skus),sources=new Map();
 for(const row of rows) {
  const members=row.data?.variants?.length?row.data.variants.map(v=>String(v.sku)): [String(row.source_sku)];
  for(const sku of members)if(requested.has(sku)&&(!sources.has(sku)||row.source_sku===sku))sources.set(sku,row.id);
 }
 return sources;
}
