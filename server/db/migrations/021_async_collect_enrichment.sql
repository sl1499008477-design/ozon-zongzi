ALTER TABLE collector_ozon_enrichment_jobs
  ADD COLUMN IF NOT EXISTS collect_item_id TEXT REFERENCES collect_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error_json JSONB,
  ADD COLUMN IF NOT EXISTS capture_context_json JSONB;

ALTER TABLE collector_ozon_enrichment_cache
  ADD COLUMN IF NOT EXISTS capture_context_json JSONB;

DROP INDEX IF EXISTS collector_ozon_enrichment_jobs_pending_idx;

CREATE INDEX collector_ozon_enrichment_jobs_pending_idx
  ON collector_ozon_enrichment_jobs(account_id, next_attempt_at, created_at, id)
  WHERE status = 'PENDING';
