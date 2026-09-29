// Pre-collection history only: import into collect-box must keep its existing rules.
// The caller owns account authorization and any SKU claim transaction/locks.
export async function findCollectorSkuHistory(client, accountId, skus) {
  const requested = [...new Set(skus.map(sku => String(sku ?? '').trim()).filter(Boolean))];
  if (!requested.length) return new Map();
  // Historical JSON variants may store a numeric SKU; do not round or drop leading zeroes.
  const matchSkus = requested.flatMap(sku => [sku,
    ...(/^(0|[1-9]\d*)$/.test(sku) && Number.isSafeInteger(Number(sku)) ? [Number(sku)] : []),
  ]);
  const { rows } = await client.query(`
    WITH collected AS (
      SELECT c.id,c.source_sku,d.data
      FROM collect_items c
      LEFT JOIN product_drafts d ON d.id=c.current_draft_id AND d.collect_item_id=c.id
      -- AUTO_LISTING_EXCEL_SKU is the existing Ozon-only Excel collector's persisted marker.
      WHERE c.account_id=$1 AND c.source IN ('ozon','AUTO_LISTING_EXCEL_SKU') AND c.deleted_at IS NULL
        AND c.source_sku=ANY($2::text[])
      UNION ALL
      SELECT c.id,c.source_sku,d.data
      FROM product_drafts d
      JOIN collect_items c ON c.current_draft_id=d.id AND c.id=d.collect_item_id
      WHERE c.account_id=$1 AND c.source IN ('ozon','AUTO_LISTING_EXCEL_SKU') AND c.deleted_at IS NULL
        AND d.data->'variants' @> ANY($3::jsonb[]) AND NOT(c.source_sku=ANY($2::text[]))
    ), desktop AS (
      SELECT i.source_sku AS sku,i.id AS collector_item_id,c.id AS collect_item_id,
             i.task_id,i.run_id,t.name AS task_name
      FROM collector_task_items i
      JOIN collector_tasks t ON t.id=i.task_id AND t.account_id=i.account_id
      LEFT JOIN collected c ON c.id=i.collect_item_id
      WHERE i.account_id=$1 AND i.source='ozon' AND i.status='QUALIFIED'
        AND i.source_sku=ANY($2::text[]) AND i.dedup_released_at IS NULL
        -- A legacy NULL link can mean an old user deletion. Payloads do not settle that ambiguity.
        AND (i.dedup_saved_at IS NOT NULL OR c.id IS NOT NULL)
    ), ai AS (
      SELECT t.id,t.status,t.body,
             CASE WHEN c.deleted_at IS NULL THEN c.id END AS collect_item_id
      FROM ai_image_listing_tasks t
      LEFT JOIN collect_items c ON c.id=COALESCE(NULLIF(t.body#>>'{source,collectItemId}',''),t.body->>'sourceId')
        AND c.account_id=t.account_id
      WHERE t.account_id=$1
        AND t.body#>'{source,items}' @> ANY($3::jsonb[])
        AND (t.status='COMPLETED' OR t.body->'submissionResults' @> ANY($4::jsonb[]))
        AND lower(COALESCE(NULLIF(t.body#>>'{source,sourceSnapshot,source}',''),c.source)) IN ('ozon','auto_listing_excel_sku')
    ), candidates AS (
      SELECT sku,'COLLECTED'::text AS state,collect_item_id,collector_item_id,task_id,run_id,task_name,
             NULL::text AS listing_task_id,NULL::text AS submission_job_id,1 AS priority
      FROM desktop
      UNION ALL
      SELECT c.source_sku,'COLLECTED',c.id,NULL,NULL,NULL,NULL,NULL,NULL,2
      FROM collected c WHERE c.source_sku=ANY($2::text[])
      UNION ALL
      SELECT v->>'sku','COLLECTED',c.id,NULL,NULL,NULL,NULL,NULL,NULL,2
      FROM collected c CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(c.data->'variants')='array' THEN c.data->'variants' ELSE '[]'::jsonb END) v
      WHERE v->>'sku'=ANY($2::text[])
      UNION ALL
      SELECT item->>'sku','LISTED',a.collect_item_id,NULL,NULL,NULL,NULL,a.id,NULL,0
      FROM ai a CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.body#>'{source,items}')='array' THEN a.body#>'{source,items}' ELSE '[]'::jsonb END) item
      WHERE item->>'sku'=ANY($2::text[]) AND (
        EXISTS(SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.body->'submissionResults')='array' THEN a.body->'submissionResults' ELSE '[]'::jsonb END) result
          WHERE result->>'sku'=item->>'sku' AND result->>'importStatus'='SUCCEEDED')
        OR (a.status='COMPLETED' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(a.body->'submissionResults')='array' THEN a.body->'submissionResults' ELSE '[]'::jsonb END) result
          WHERE result->>'sku'=item->>'sku'))
      )
      UNION ALL
      SELECT i.sku,'LISTED',c.id,NULL,NULL,NULL,NULL,NULL,j.id,0
      FROM submission_items i
      JOIN submission_jobs j ON j.id=i.job_id
      JOIN submission_snapshots s ON s.id=i.snapshot_id AND s.id=j.snapshot_id AND s.account_id=j.account_id
      LEFT JOIN collect_items c ON c.id=j.collect_item_id AND c.account_id=j.account_id
      WHERE j.account_id=$1 AND i.status='SUCCEEDED' AND i.sku<>'' AND i.sku=ANY($2::text[])
        -- Old normalized snapshots may lack source identity: never infer it from offer_id/product_id.
        AND lower(COALESCE(NULLIF(to_jsonb(i)->>'source',''),c.source)) IN ('ozon','auto_listing_excel_sku')
    ), best AS (
      SELECT DISTINCT ON (sku) * FROM candidates
      ORDER BY sku,priority,task_id,collect_item_id,collector_item_id,listing_task_id,submission_job_id
    ), desktop_origin AS (
      SELECT DISTINCT ON (sku) * FROM desktop ORDER BY sku,collector_item_id
    )
    SELECT b.sku,b.state,COALESCE(b.collect_item_id,d.collect_item_id) AS collect_item_id,
           COALESCE(b.collector_item_id,d.collector_item_id) AS collector_item_id,
           COALESCE(b.task_id,d.task_id) AS task_id,COALESCE(b.run_id,d.run_id) AS run_id,
           COALESCE(b.task_name,d.task_name) AS task_name,b.listing_task_id,b.submission_job_id
    FROM best b LEFT JOIN desktop_origin d ON d.sku=b.sku ORDER BY b.sku
  `, [accountId, requested, matchSkus.map(sku => JSON.stringify([{ sku }])),
    matchSkus.map(sku => JSON.stringify([{ sku, importStatus: 'SUCCEEDED' }]))]);
  return new Map(rows.map(row => {
    const entry = { sku: row.sku, state: row.state };
    for (const [key, column] of Object.entries({ collectItemId: 'collect_item_id', collectorItemId: 'collector_item_id',
      taskId: 'task_id', runId: 'run_id', taskName: 'task_name', listingTaskId: 'listing_task_id', submissionJobId: 'submission_job_id' })) {
      if (row[column]) entry[key] = row[column];
    }
    return [row.sku, entry];
  }));
}
