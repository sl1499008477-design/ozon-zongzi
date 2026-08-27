WITH exhausted AS (
  UPDATE collector_ozon_enrichment_jobs AS job
     SET status = 'FAILED',
         result_json = NULL,
         error_json = jsonb_build_object(
           'code', 'OZON_ENRICH_RETRY_EXHAUSTED',
           'status', 422
         ),
         last_error_json = jsonb_build_object(
           'code', 'OZON_ENRICH_RETRY_EXHAUSTED',
           'status', 422
         ),
         preferred_session_id = NULL,
         claimed_session_id = NULL,
         claim_expires_at = NULL,
         claim_fence = NULL,
         capture_context_json = NULL,
         completed_at = NOW(),
         updated_at = NOW()
   WHERE job.collect_item_id IS NOT NULL
     AND job.status IN ('PENDING', 'PROCESSING')
     AND job.attempt_count >= 5
     AND NOT EXISTS (
       SELECT 1
         FROM collect_items AS complete_item
        WHERE complete_item.id = job.collect_item_id
          AND complete_item.account_id = job.account_id
          AND complete_item.deleted_at IS NULL
          AND complete_item.summary #>> '{enrichment,status}' = 'COMPLETE'
     )
  RETURNING job.account_id, job.collect_item_id, job.attempt_count
)
UPDATE collect_items AS item
   SET status = 'NEEDS_ATTENTION',
       summary = jsonb_set(
         COALESCE(item.summary, '{}'::jsonb),
         '{enrichment}',
         COALESCE(item.summary->'enrichment', '{}'::jsonb) || jsonb_build_object(
           'status', 'NEEDS_ATTENTION',
           'attemptCount', exhausted.attempt_count,
           'nextAttemptAt', '',
           'lastErrorCode', 'OZON_ENRICH_RETRY_EXHAUSTED'
         ),
         TRUE
       ),
       updated_at = NOW()
  FROM exhausted
 WHERE item.id = exhausted.collect_item_id
   AND item.account_id = exhausted.account_id
   AND item.deleted_at IS NULL;
