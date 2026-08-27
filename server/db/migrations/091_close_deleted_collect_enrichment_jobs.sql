WITH deleted_collect_jobs AS (
  SELECT job.id
    FROM collector_ozon_enrichment_jobs AS job
    JOIN collect_items AS item
      ON item.id = job.collect_item_id
     AND item.account_id = job.account_id
   WHERE job.status IN ('PENDING', 'PROCESSING')
     AND (item.deleted_at IS NOT NULL OR item.status = 'DELETED')
)
UPDATE collector_ozon_enrichment_jobs AS job
   SET status = 'FAILED',
       result_json = NULL,
       error_json = jsonb_build_object(
         'code', 'OZON_ENRICHMENT_COLLECT_ITEM_DELETED',
         'status', 410
       ),
       last_error_json = jsonb_build_object(
         'code', 'OZON_ENRICHMENT_COLLECT_ITEM_DELETED',
         'status', 410
       ),
       preferred_session_id = NULL,
       claimed_session_id = NULL,
       claim_expires_at = NULL,
       claim_fence = NULL,
       capture_context_json = NULL,
       completed_at = NOW(),
       updated_at = NOW()
  FROM deleted_collect_jobs AS deleted
 WHERE job.id = deleted.id;
