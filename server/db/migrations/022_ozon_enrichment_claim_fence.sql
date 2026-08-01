ALTER TABLE collector_ozon_enrichment_jobs
  ADD COLUMN IF NOT EXISTS claim_fence TEXT;

WITH ranked_active_linked_jobs AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, collect_item_id, sku
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_rank
  FROM collector_ozon_enrichment_jobs
  WHERE collect_item_id IS NOT NULL
    AND status IN ('PENDING', 'PROCESSING')
)
UPDATE collector_ozon_enrichment_jobs AS duplicate
SET
  status = 'FAILED',
  result_json = NULL,
  error_json = jsonb_build_object(
    'code', 'OZON_ENRICHMENT_DUPLICATE_SUPERSEDED',
    'status', 409
  ),
  last_error_json = jsonb_build_object(
    'code', 'OZON_ENRICHMENT_DUPLICATE_SUPERSEDED',
    'status', 409
  ),
  claimed_session_id = NULL,
  claim_expires_at = NULL,
  claim_fence = NULL,
  completed_at = NOW(),
  updated_at = NOW()
FROM ranked_active_linked_jobs AS ranked
WHERE duplicate.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS collector_ozon_enrichment_jobs_active_linked_key
  ON collector_ozon_enrichment_jobs (account_id, collect_item_id, sku)
  WHERE collect_item_id IS NOT NULL
    AND status IN ('PENDING', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_collector_ozon_enrichment_jobs_claim_fence
  ON collector_ozon_enrichment_jobs (account_id, id, claim_fence)
  WHERE status = 'PROCESSING';
