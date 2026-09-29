CREATE TABLE IF NOT EXISTS collector_media_uploads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES collector_task_runs(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  lease_hash TEXT NOT NULL,
  identity_hash TEXT NOT NULL UNIQUE,
  source_sku TEXT NOT NULL,
  purpose TEXT NOT NULL,
  media_index INTEGER NOT NULL CHECK (media_index >= 0),
  source_url TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'staging/collector/%'),
  expected_size BIGINT NOT NULL CHECK (expected_size BETWEEN 1 AND 2147483648),
  expected_type TEXT NOT NULL,
  expected_md5 TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_object JSONB,
  collector_item_id TEXT,
  collect_item_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS collector_media_uploads_account_item_idx
  ON collector_media_uploads(account_id, collector_item_id);
