CREATE TABLE collect_category_resolutions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  collect_item_id TEXT NOT NULL REFERENCES collect_items(id) ON DELETE CASCADE,
  taxonomy_scope TEXT NOT NULL,
  source_type_id BIGINT,
  target_description_category_id BIGINT,
  target_type_id BIGINT,
  method TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('WAITING_ENRICHMENT', 'WAITING_STORE', 'QUEUED', 'MATCHING', 'MATCHED', 'NEEDS_REVIEW', 'RETRYABLE_ERROR', 'INVALIDATED')),
  taxonomy_fingerprint TEXT,
  credential_store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  display_path_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_code TEXT,
  failure_detail_safe TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  matched_at TIMESTAMPTZ,
  validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, collect_item_id, taxonomy_scope),
  CHECK (
    (target_description_category_id IS NULL AND target_type_id IS NULL)
    OR (target_description_category_id > 0 AND target_type_id > 0)
  ),
  CHECK (status <> 'MATCHED' OR (
    target_description_category_id IS NOT NULL
    AND target_type_id IS NOT NULL
    AND method IS NOT NULL
  )),
  CHECK (
    (status = 'MATCHING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'MATCHING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX collect_category_resolutions_due_idx
  ON collect_category_resolutions(status, next_attempt_at);

CREATE INDEX collect_category_resolutions_account_item_idx
  ON collect_category_resolutions(account_id, collect_item_id);
