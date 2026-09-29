CREATE TABLE ozon_web_collection_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('ALL','CURRENT')),
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','PROCESSING','WAITING','COMPLETED','FAILED','CANCELLED')),
  claimed_session_id TEXT REFERENCES collector_sessions(id) ON DELETE SET NULL,
  claim_fence TEXT NOT NULL DEFAULT '',
  claim_expires_at TIMESTAMPTZ,
  message TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, request_id)
);
CREATE UNIQUE INDEX ozon_web_collection_jobs_active_sku_idx
  ON ozon_web_collection_jobs(account_id, sku, scope)
  WHERE status IN ('QUEUED','PROCESSING','WAITING');
CREATE INDEX ozon_web_collection_jobs_queue_idx
  ON ozon_web_collection_jobs(account_id, created_at, id)
  WHERE status IN ('QUEUED','PROCESSING','WAITING');
CREATE INDEX ozon_web_collection_jobs_history_idx
  ON ozon_web_collection_jobs(account_id, created_at DESC, id DESC);
