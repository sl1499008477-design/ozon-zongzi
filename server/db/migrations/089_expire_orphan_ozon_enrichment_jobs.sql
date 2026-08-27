UPDATE collector_ozon_enrichment_jobs
SET
  status = 'FAILED',
  result_json = NULL,
  error_json = jsonb_build_object(
    'code', 'OZON_ENRICHMENT_ORPHAN_EXPIRED',
    'status', 410
  ),
  last_error_json = jsonb_build_object(
    'code', 'OZON_ENRICHMENT_ORPHAN_EXPIRED',
    'status', 410
  ),
  preferred_session_id = NULL,
  claimed_session_id = NULL,
  claim_expires_at = NULL,
  claim_fence = NULL,
  capture_context_json = NULL,
  completed_at = NOW(),
  updated_at = NOW()
WHERE collect_item_id IS NULL
  AND status IN ('PENDING', 'PROCESSING')
  AND deadline_at <= NOW();
