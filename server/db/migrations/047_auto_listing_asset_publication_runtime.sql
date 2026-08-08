-- Runtime evidence for a version-frozen public policy, durable ambiguous-write
-- cleanup and account-scoped DIRECT readiness. Existing V1 publications are
-- backfilled from their deterministic URL/key without changing their meaning.

ALTER TABLE auto_listing_asset_publications
  ADD COLUMN IF NOT EXISTS public_base_url TEXT,
  ADD COLUMN IF NOT EXISTS public_prefix TEXT;

UPDATE auto_listing_asset_publications
SET public_base_url = LEFT(public_url, CHAR_LENGTH(public_url) - CHAR_LENGTH(public_object_key)),
    public_prefix = REGEXP_REPLACE(
      public_object_key,
      '/[a-f0-9]{2}/[a-f0-9]{64}\.(png|jpg|webp)$',
      ''
    )
WHERE public_base_url IS NULL OR public_prefix IS NULL;

ALTER TABLE auto_listing_asset_publications
  ALTER COLUMN public_base_url SET NOT NULL,
  ALTER COLUMN public_prefix SET NOT NULL;

ALTER TABLE auto_listing_asset_publications
  ADD CONSTRAINT auto_listing_asset_publication_base_url_check
    CHECK (public_base_url ~ '^https://[^?#]+/$'),
  ADD CONSTRAINT auto_listing_asset_publication_prefix_check
    CHECK (public_prefix ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$'
      AND public_prefix !~ '//' AND RIGHT(public_prefix, 1) <> '/'),
  ADD CONSTRAINT auto_listing_asset_publication_policy_binding_check
    CHECK (public_url = public_base_url || public_object_key
      AND public_object_key LIKE public_prefix || '/%');

CREATE TABLE IF NOT EXISTS auto_listing_asset_publication_cleanup (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  public_object_key TEXT NOT NULL CHECK (NULLIF(BTRIM(public_object_key), '') IS NOT NULL),
  publication_version TEXT NOT NULL CHECK (publication_version ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  public_base_url TEXT NOT NULL CHECK (public_base_url ~ '^https://[^?#]+/$'),
  public_prefix TEXT NOT NULL CHECK (
    public_prefix ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$'
    AND public_prefix !~ '//' AND RIGHT(public_prefix, 1) <> '/'
  ),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'RECORD_UNCERTAIN','RECORD_REJECTED','RECORD_EVIDENCE_INVALID'
  )),
  status TEXT NOT NULL CHECK (status IN ('PENDING','DELETING','CLEANED','REFERENCED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,asset_id,content_hash,publication_version,public_object_key),
  UNIQUE (account_id,id),
  FOREIGN KEY (account_id,job_id,item_id,plan_id,asset_id)
    REFERENCES ai_generation_assets(account_id,job_id,item_id,plan_id,id) ON DELETE RESTRICT,
  CHECK (public_object_key LIKE public_prefix || '/%'),
  CHECK (
    (status = 'DELETING' AND NULLIF(BTRIM(lease_token), '') IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'DELETING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS auto_listing_asset_publication_cleanup_pending_idx
  ON auto_listing_asset_publication_cleanup(status,updated_at,created_at)
  WHERE status IN ('PENDING','DELETING');

CREATE OR REPLACE FUNCTION auto_listing_protect_asset_publication_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset publication cleanup is durable audit evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.public_object_key IS DISTINCT FROM OLD.public_object_key
    OR NEW.publication_version IS DISTINCT FROM OLD.publication_version
    OR NEW.public_base_url IS DISTINCT FROM OLD.public_base_url
    OR NEW.public_prefix IS DISTINCT FROM OLD.public_prefix
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count
    OR NOT (
      NEW.status = OLD.status
      OR (OLD.status = 'PENDING' AND NEW.status IN ('DELETING','REFERENCED'))
      OR (OLD.status = 'DELETING' AND NEW.status IN ('PENDING','CLEANED','REFERENCED'))
    )
  THEN
    RAISE EXCEPTION 'invalid asset publication cleanup mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_asset_publication_cleanup_protected
BEFORE UPDATE OR DELETE ON auto_listing_asset_publication_cleanup
FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_asset_publication_cleanup();

CREATE TABLE IF NOT EXISTS auto_listing_asset_publication_health_evidence (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  publication_version TEXT NOT NULL CHECK (publication_version ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  public_base_url TEXT NOT NULL CHECK (public_base_url ~ '^https://[^?#]+/$'),
  public_prefix TEXT NOT NULL CHECK (
    public_prefix ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$'
    AND public_prefix !~ '//' AND RIGHT(public_prefix, 1) <> '/'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('PASSED','FAILED')),
  evidence JSONB NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND evidence ?& ARRAY['probeKind','httpStatus','contentTypeMatched','bytesMatched']
    AND (evidence - 'probeKind' - 'httpStatus' - 'contentTypeMatched' - 'bytesMatched') = '{}'::JSONB
    AND evidence->>'probeKind' = 'PUBLIC_READBACK'
    AND jsonb_typeof(evidence->'httpStatus') = 'number'
    AND (evidence->>'httpStatus')::INTEGER BETWEEN 100 AND 599
    AND jsonb_typeof(evidence->'contentTypeMatched') = 'boolean'
    AND jsonb_typeof(evidence->'bytesMatched') = 'boolean'
  ),
  checked_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  checked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,id),
  CHECK (checked_by_account_id = account_id),
  CHECK (expires_at > checked_at)
);

CREATE INDEX IF NOT EXISTS auto_listing_asset_publication_health_ready_idx
  ON auto_listing_asset_publication_health_evidence(
    account_id,publication_version,public_base_url,public_prefix,expires_at DESC
  ) WHERE outcome = 'PASSED';

CREATE OR REPLACE FUNCTION auto_listing_reject_asset_publication_health_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'asset publication health evidence is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER auto_listing_asset_publication_health_append_only
BEFORE UPDATE OR DELETE ON auto_listing_asset_publication_health_evidence
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_asset_publication_health_mutation();

CREATE OR REPLACE FUNCTION auto_listing_validate_asset_publication_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The cleanup worker and publication writer share this transaction lock, so
  -- a public object cannot become referenced between reference-check and delete.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.public_object_key || ':' || NEW.publication_version,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM auto_listing_asset_publication_cleanup AS cleanup
    WHERE cleanup.public_object_key = NEW.public_object_key
      AND cleanup.publication_version = NEW.publication_version
      AND cleanup.status = 'DELETING'
  ) THEN
    RAISE EXCEPTION 'asset publication object is being cleaned' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM auto_listing_job_items AS item
  WHERE item.account_id = NEW.account_id
    AND item.job_id = NEW.job_id
    AND item.id = NEW.item_id
    AND item.active_content_plan_id = NEW.plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset publication plan is not current' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM ai_generation_assets AS asset
  WHERE asset.account_id = NEW.account_id
    AND asset.job_id = NEW.job_id
    AND asset.item_id = NEW.item_id
    AND asset.plan_id = NEW.plan_id
    AND asset.id = NEW.asset_id
    AND asset.status = 'ACCEPTED'
    AND asset.object_key_version = 'ATTEMPT_V2'
    AND NEW.visual_group_key = asset.visual_group_key
    AND NEW.slot_key = asset.slot_key
    AND NEW.role = asset.role
    AND NEW.content_hash = asset.content_hash
    AND NEW.content_type = asset.content_type
    AND NEW.size_bytes = asset.size_bytes
    AND NEW.width = asset.width
    AND NEW.height = asset.height
    AND NEW.private_object_key = asset.object_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset publication evidence does not match accepted asset' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
