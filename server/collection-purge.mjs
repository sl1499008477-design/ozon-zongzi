// Caller owns transaction. Business snapshots retain provenance IDs independently.
export async function purgeCollectedItems(client, accountId, ids) {
 // Serialize the final deletion with task controls so a concurrent stop cannot
 // recreate an item-level tombstone after the product has been purged.
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[accountId]);
 const rows=(await client.query(`SELECT c.id,c.source,c.source_sku,
  ARRAY(SELECT v->>'sku' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'variants')='array' THEN d.data->'variants' ELSE '[]'::jsonb END) v) AS variant_skus
  FROM collect_items c LEFT JOIN product_drafts d ON d.id=c.current_draft_id WHERE c.account_id=$1 AND c.id=ANY($2::text[]) FOR UPDATE OF c`,[accountId,ids])).rows;
 const removed=rows.map(r=>r.id);if(!removed.length)return 0;
 const rowSkus=r=>[r.source_sku,...(r.variant_skus||[])].filter(Boolean).map(String);
 const skus=[...new Set(rows.flatMap(rowSkus))];
 // Do not invalidate another retained product's SKU evidence.
 const retained=(await client.query(`SELECT c.source,c.source_sku,
  ARRAY(SELECT v->>'sku' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'variants')='array' THEN d.data->'variants' ELSE '[]'::jsonb END) v) AS variant_skus
  FROM collect_items c LEFT JOIN product_drafts d ON d.id=c.current_draft_id WHERE c.account_id=$1 AND NOT(c.id=ANY($2::text[])) AND c.deleted_at IS NULL`,[accountId,removed])).rows;
 const kept=new Set(retained.flatMap(rowSkus));
 const obsolete=skus.filter(s=>!kept.has(s));
 const isOzon=r=>['ozon','auto_listing_excel_sku'].includes(String(r.source).toLowerCase());
 const ozonRows=rows.filter(isOzon),ozonKept=new Set(retained.filter(isOzon).flatMap(rowSkus));
 const releasedSkus=[...new Set(ozonRows.flatMap(rowSkus))].filter(s=>!ozonKept.has(s));
 // Mark the user's deletion before the collect-item FK becomes NULL. Keep every historical payload.
 await client.query(`UPDATE collector_task_items SET dedup_released_at=NOW()
  WHERE account_id=$1 AND source='ozon' AND status='QUALIFIED' AND dedup_released_at IS NULL
   AND (source_sku=ANY($2::text[]) OR (collect_item_id=ANY($3::text[]) AND NOT(source_sku=ANY($4::text[]))))`,
  [accountId,releasedSkus,ozonRows.map(r=>r.id),[...ozonKept]]);
 await client.query('DELETE FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND (collect_item_id=ANY($2::text[]) OR sku=ANY($3::text[]))',[accountId,removed,obsolete]);
 await client.query(`DELETE FROM collector_ozon_enrichment_task_controls AS control
  WHERE control.account_id=$1 AND control.task_group_key=ANY($2::text[])
   AND NOT EXISTS (SELECT 1 FROM collector_ozon_enrichment_jobs AS job
    WHERE job.account_id=control.account_id AND job.task_group_key=control.task_group_key)`,
  [accountId,removed.map(id=>`collect:${id}`)]);
 await client.query('DELETE FROM collector_ozon_enrichment_cache WHERE account_id=$1 AND sku=ANY($2::text[])',[accountId,obsolete]);
 await client.query('DELETE FROM collect_requests WHERE account_id=$1 AND (collect_item_id=ANY($2::text[]) OR source_sku=ANY($3::text[]))',[accountId,removed,obsolete]);
 await client.query('DELETE FROM collect_items WHERE account_id=$1 AND id=ANY($2::text[])',[accountId,removed]);
 await client.query('DELETE FROM collect_raw_payloads WHERE account_id=$1 AND (collect_item_id=ANY($2::text[]) OR source_sku=ANY($3::text[]))',[accountId,removed,obsolete]);
 // Keep invalidating hydrated snapshots via the version even when the legacy
 // mirror has no matching entry. Reuse its unchanged JSON instead of rewriting it.
 await client.query(`UPDATE local_state SET version=version+1,updated_at=NOW(),state=CASE WHEN EXISTS(
  SELECT 1 FROM jsonb_array_elements(COALESCE(state->'caches'->'collectBox','[]')) x
  WHERE COALESCE(x->>'accountId',state->>'currentAccountId')=$1 AND (x->>'id'=ANY($2::text[]) OR x->>'sku'=ANY($3::text[])))
  THEN jsonb_set(state,'{caches,collectBox}',COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(COALESCE(state->'caches'->'collectBox','[]')) x WHERE NOT(COALESCE(x->>'accountId',state->>'currentAccountId')=$1 AND (x->>'id'=ANY($2::text[]) OR x->>'sku'=ANY($3::text[])))),'[]'::jsonb))
  ELSE state END`,[accountId,removed,obsolete]);
 return removed.length;
}
