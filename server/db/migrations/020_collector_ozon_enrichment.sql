CREATE TABLE collector_ozon_enrichment_cache (
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  sku TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  status TEXT CHECK (status IN ('COMPLETE', 'ERROR')),
  result_json JSONB,
  error_json JSONB,
  response_hash TEXT,
  last_executor_session_id TEXT,
  captured_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, source, sku, contract_version),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (last_executor_session_id) REFERENCES collector_sessions(id) ON DELETE SET NULL,
  CHECK (source = 'ozon'),
  CHECK (
    status IS NULL
    OR (status = 'COMPLETE' AND result_json IS NOT NULL AND error_json IS NULL)
    OR (status = 'ERROR' AND result_json IS NULL AND error_json IS NOT NULL)
  )
);

CREATE INDEX collector_ozon_enrichment_cache_expires_at_idx
  ON collector_ozon_enrichment_cache(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX collector_ozon_enrichment_cache_account_idx
  ON collector_ozon_enrichment_cache(account_id, updated_at DESC);

CREATE TABLE collector_ozon_enrichment_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED')),
  refresh_bundle JSONB NOT NULL,
  preferred_session_id TEXT,
  claimed_session_id TEXT,
  claim_expires_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ NOT NULL,
  result_json JSONB,
  error_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, request_id, sku),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (preferred_session_id) REFERENCES collector_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (claimed_session_id) REFERENCES collector_sessions(id) ON DELETE SET NULL,
  CHECK (
    (status IN ('PENDING', 'PROCESSING') AND result_json IS NULL AND error_json IS NULL AND completed_at IS NULL)
    OR (status = 'SUCCESS' AND result_json IS NOT NULL AND error_json IS NULL AND completed_at IS NOT NULL)
    OR (status = 'FAILED' AND result_json IS NULL AND error_json IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX collector_ozon_enrichment_jobs_pending_idx
  ON collector_ozon_enrichment_jobs(account_id, created_at, id)
  WHERE status = 'PENDING';

CREATE INDEX collector_ozon_enrichment_jobs_account_idx
  ON collector_ozon_enrichment_jobs(account_id, status, claim_expires_at);
