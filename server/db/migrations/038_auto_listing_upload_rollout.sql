CREATE UNIQUE INDEX IF NOT EXISTS product_drafts_id_collect_item_id_key
  ON product_drafts(id,collect_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_account_job_item_store_key
  ON auto_listing_job_items(account_id,job_id,id,target_store_id);
CREATE UNIQUE INDEX IF NOT EXISTS submission_snapshots_account_id_id_store_id_key
  ON submission_snapshots(account_id,id,store_id);
CREATE UNIQUE INDEX IF NOT EXISTS submission_jobs_account_id_id_snapshot_id_store_id_key
  ON submission_jobs(account_id,id,snapshot_id,store_id);

CREATE TABLE IF NOT EXISTS auto_listing_listing_bases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  collect_item_id TEXT NOT NULL,
  target_store_id TEXT NOT NULL,
  product_draft_id TEXT NOT NULL,
  product_draft_version INTEGER NOT NULL CHECK (product_draft_version > 0),
  product_draft_data_hash TEXT NOT NULL CHECK (product_draft_data_hash ~ '^[a-f0-9]{64}$'),
  ozon_ready_variants JSONB NOT NULL CHECK (jsonb_typeof(ozon_ready_variants) = 'array'),
  pricing_evidence JSONB NOT NULL CHECK (
    jsonb_typeof(pricing_evidence) = 'object'
    AND pricing_evidence->>'currency' = 'RUB'
    AND pricing_evidence->>'evidenceHash' ~ '^[a-f0-9]{64}$'
  ),
  rich_content_attribute_supported BOOLEAN NOT NULL,
  listing_base_version TEXT NOT NULL CHECK (listing_base_version = 'AUTO_LISTING_LISTING_BASE_V1'),
  canonical_hash TEXT NOT NULL CHECK (canonical_hash ~ '^[a-f0-9]{64}$'),
  normalizer_version TEXT NOT NULL,
  category_rule_version TEXT NOT NULL,
  dictionary_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,job_id,item_id,source_snapshot_id),
  UNIQUE (account_id,job_id,item_id,id),
  FOREIGN KEY (account_id,job_id,item_id,source_snapshot_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id,snapshot_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,collect_item_id)
    REFERENCES collect_items(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,target_store_id)
    REFERENCES stores(owner_account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (product_draft_id,collect_item_id)
    REFERENCES product_drafts(id,collect_item_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION auto_listing_reject_listing_base_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing listing bases are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER auto_listing_listing_bases_append_only
BEFORE UPDATE OR DELETE ON auto_listing_listing_bases
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_listing_base_mutation();

CREATE TABLE IF NOT EXISTS auto_listing_upload_policy_versions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('REVIEW','DIRECT')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL CHECK (version > 0),
  publication_reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  published_by TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE (account_id,version),
  UNIQUE (account_id,id),
  CHECK (
    (enabled = FALSE AND published_by IS NULL AND published_at IS NULL)
    OR (enabled = TRUE AND published_by IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION auto_listing_require_admin_upload_policy_publisher()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM NEW.account_id
    OR (NEW.enabled AND (NEW.published_by IS DISTINCT FROM NEW.account_id OR NOT EXISTS (
      SELECT 1 FROM accounts WHERE id = NEW.published_by AND role = 'admin'
    ))) THEN
    RAISE EXCEPTION 'upload policy publisher must be same-account admin' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_upload_policy_versions_admin_publisher
BEFORE INSERT ON auto_listing_upload_policy_versions
FOR EACH ROW EXECUTE FUNCTION auto_listing_require_admin_upload_policy_publisher();

CREATE OR REPLACE FUNCTION auto_listing_reject_upload_policy_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing upload policy versions are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER auto_listing_upload_policy_versions_immutable
BEFORE UPDATE OR DELETE ON auto_listing_upload_policy_versions
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_upload_policy_version_mutation();

ALTER TABLE auto_listing_jobs
  ADD COLUMN IF NOT EXISTS upload_policy_version_id TEXT;

ALTER TABLE auto_listing_jobs
  ADD CONSTRAINT auto_listing_jobs_upload_policy_version_fkey
  FOREIGN KEY (account_id,upload_policy_version_id)
  REFERENCES auto_listing_upload_policy_versions(account_id,id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS auto_listing_jobs_upload_policy_version_idx
  ON auto_listing_jobs(account_id,upload_policy_version_id)
  WHERE upload_policy_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auto_listing_submission_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  auto_listing_item_id TEXT NOT NULL,
  listing_base_id TEXT NOT NULL,
  active_plan_id TEXT NOT NULL,
  target_store_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  config_hash TEXT NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  upload_policy_version_id TEXT NOT NULL,
  submission_snapshot_id TEXT,
  submission_job_id TEXT,
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key), '') IS NOT NULL),
  status TEXT NOT NULL CHECK (status IN ('RESERVED','SUBMITTED','RECONCILING','SUCCEEDED','FAILED','BLOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,auto_listing_item_id,result_hash,target_store_id),
  UNIQUE (account_id,idempotency_key),
  UNIQUE (account_id,id),
  UNIQUE (account_id,job_id,auto_listing_item_id,id),
  UNIQUE (account_id,job_id,auto_listing_item_id,id,target_store_id),
  FOREIGN KEY (account_id,job_id,auto_listing_item_id,target_store_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id,target_store_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,job_id,auto_listing_item_id,listing_base_id)
    REFERENCES auto_listing_listing_bases(account_id,job_id,item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,job_id,auto_listing_item_id,active_plan_id)
    REFERENCES ai_content_plans(account_id,job_id,item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,upload_policy_version_id)
    REFERENCES auto_listing_upload_policy_versions(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,target_store_id)
    REFERENCES stores(owner_account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,submission_snapshot_id,target_store_id)
    REFERENCES submission_snapshots(account_id,id,store_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id,target_store_id)
    REFERENCES submission_jobs(account_id,id,snapshot_id,store_id) ON DELETE RESTRICT,
  CHECK (
    (submission_snapshot_id IS NULL AND submission_job_id IS NULL)
    OR (submission_snapshot_id IS NOT NULL AND submission_job_id IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('SUBMITTED','RECONCILING','SUCCEEDED')
    OR (submission_snapshot_id IS NOT NULL AND submission_job_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION auto_listing_protect_submission_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'auto-listing submission links are durable audit evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.auto_listing_item_id IS DISTINCT FROM OLD.auto_listing_item_id
    OR NEW.listing_base_id IS DISTINCT FROM OLD.listing_base_id
    OR NEW.active_plan_id IS DISTINCT FROM OLD.active_plan_id
    OR NEW.target_store_id IS DISTINCT FROM OLD.target_store_id
    OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
    OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.result_hash IS DISTINCT FROM OLD.result_hash
    OR NEW.upload_policy_version_id IS DISTINCT FROM OLD.upload_policy_version_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'auto-listing submission link identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.submission_snapshot_id IS NOT NULL
      AND NEW.submission_snapshot_id IS DISTINCT FROM OLD.submission_snapshot_id)
    OR (OLD.submission_job_id IS NOT NULL
      AND NEW.submission_job_id IS DISTINCT FROM OLD.submission_job_id)
  THEN
    RAISE EXCEPTION 'auto-listing submission binding cannot be replaced' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'RESERVED' AND NEW.status IN ('SUBMITTED','FAILED','BLOCKED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('RECONCILING','SUCCEEDED','FAILED','BLOCKED'))
    OR (OLD.status = 'RECONCILING' AND NEW.status IN ('SUCCEEDED','FAILED','BLOCKED'))
    OR (OLD.status = 'FAILED' AND NEW.status = 'RESERVED')
  ) THEN
    RAISE EXCEPTION 'invalid auto-listing submission link transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_submission_links_protected
BEFORE UPDATE OR DELETE ON auto_listing_submission_links
FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_submission_link();

CREATE INDEX IF NOT EXISTS auto_listing_submission_links_item_status_idx
  ON auto_listing_submission_links(account_id,auto_listing_item_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS auto_listing_submission_links_submission_job_idx
  ON auto_listing_submission_links(submission_job_id);

CREATE TABLE IF NOT EXISTS auto_listing_upload_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  auto_listing_item_id TEXT NOT NULL,
  submission_link_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('REVIEW_APPROVE','DIRECT_UPLOAD','RECONCILE')),
  expected_item_version INTEGER NOT NULL CHECK (expected_item_version > 0),
  target_store_id TEXT NOT NULL,
  target_warehouse_id TEXT NOT NULL,
  product_draft_hash TEXT NOT NULL CHECK (product_draft_hash ~ '^[a-f0-9]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','UNCERTAIN','BLOCKED')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  error_safe TEXT CHECK (error_safe IS NULL OR OCTET_LENGTH(error_safe) <= 500),
  listing_pipeline_response_summary JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(listing_pipeline_response_summary) = 'object'),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id), '') IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,id),
  FOREIGN KEY (account_id,job_id,auto_listing_item_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,job_id,auto_listing_item_id,submission_link_id,target_store_id)
    REFERENCES auto_listing_submission_links(account_id,job_id,auto_listing_item_id,id,target_store_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,target_store_id)
    REFERENCES stores(owner_account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (target_store_id,target_warehouse_id)
    REFERENCES warehouses(store_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS auto_listing_upload_attempts_item_created_idx
  ON auto_listing_upload_attempts(account_id,auto_listing_item_id,created_at DESC);
CREATE INDEX IF NOT EXISTS auto_listing_upload_attempts_link_created_idx
  ON auto_listing_upload_attempts(account_id,submission_link_id,created_at DESC);

CREATE OR REPLACE FUNCTION auto_listing_reject_upload_attempt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing upload attempts are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER auto_listing_upload_attempts_append_only
BEFORE UPDATE OR DELETE ON auto_listing_upload_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_upload_attempt_mutation();
