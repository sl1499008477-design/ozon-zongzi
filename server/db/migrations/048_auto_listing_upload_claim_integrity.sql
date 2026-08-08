ALTER TABLE auto_listing_upload_policy_versions
  ADD COLUMN IF NOT EXISTS publication_origin TEXT,
  ADD COLUMN IF NOT EXISTS publication_base_url TEXT,
  ADD COLUMN IF NOT EXISTS publication_prefix TEXT,
  ADD COLUMN IF NOT EXISTS publication_version TEXT,
  ADD COLUMN IF NOT EXISTS publication_policy_hash TEXT;

ALTER TABLE auto_listing_submission_links
  ADD COLUMN IF NOT EXISTS publication_origin TEXT,
  ADD COLUMN IF NOT EXISTS publication_base_url TEXT,
  ADD COLUMN IF NOT EXISTS publication_prefix TEXT,
  ADD COLUMN IF NOT EXISTS publication_version TEXT,
  ADD COLUMN IF NOT EXISTS publication_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS media_evidence_hash TEXT,
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE auto_listing_upload_policy_versions
  ADD CONSTRAINT auto_listing_upload_policy_versions_publication_evidence_check CHECK (
    (publication_origin IS NULL AND publication_base_url IS NULL AND publication_prefix IS NULL
      AND publication_version IS NULL AND publication_policy_hash IS NULL)
    OR (publication_origin ~ '^https://[^/?#]+$'
      AND publication_base_url ~ '^https://[^?#]+/$'
      AND publication_prefix ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$'
      AND publication_version ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
      AND publication_policy_hash ~ '^[a-f0-9]{64}$')
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auto_listing_submission_links
    GROUP BY account_id,auto_listing_item_id HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'historical auto-listing item has multiple submission links';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_submission_links_one_item_key
  ON auto_listing_submission_links(account_id,auto_listing_item_id);

ALTER TABLE auto_listing_submission_links
  ADD CONSTRAINT auto_listing_submission_links_attempt_generation_check CHECK (attempt_generation > 0),
  ADD CONSTRAINT auto_listing_submission_links_publication_evidence_check CHECK (
    (publication_origin IS NULL AND publication_base_url IS NULL AND publication_prefix IS NULL
      AND publication_version IS NULL AND publication_policy_hash IS NULL AND media_evidence_hash IS NULL)
    OR (publication_origin ~ '^https://[^/?#]+$'
      AND publication_base_url ~ '^https://[^?#]+/$'
      AND publication_prefix ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$'
      AND publication_version ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
      AND publication_policy_hash ~ '^[a-f0-9]{64}$'
      AND media_evidence_hash ~ '^[a-f0-9]{64}$')
  );

CREATE OR REPLACE FUNCTION auto_listing_require_admin_upload_policy_publisher()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM NEW.account_id
    OR (NEW.enabled AND (
      NEW.published_by IS DISTINCT FROM NEW.account_id
      OR NOT EXISTS (SELECT 1 FROM accounts WHERE id=NEW.published_by AND role='admin')
      OR NEW.publication_origin IS NULL OR NEW.publication_origin !~ '^https://[^/?#]+$'
      OR NEW.publication_base_url IS NULL OR NEW.publication_base_url !~ '^https://[^?#]+/$'
      OR NEW.publication_prefix IS NULL OR NEW.publication_prefix !~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$'
      OR NEW.publication_version IS NULL OR NEW.publication_version !~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
      OR NEW.publication_policy_hash IS NULL OR NEW.publication_policy_hash !~ '^[a-f0-9]{64}$'
    )) THEN
    RAISE EXCEPTION 'upload policy publisher and publication evidence must be account-scoped' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_protect_submission_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'auto-listing submission links are durable audit evidence' USING ERRCODE='23514';
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
    OR NEW.publication_origin IS DISTINCT FROM OLD.publication_origin
    OR NEW.publication_base_url IS DISTINCT FROM OLD.publication_base_url
    OR NEW.publication_prefix IS DISTINCT FROM OLD.publication_prefix
    OR NEW.publication_version IS DISTINCT FROM OLD.publication_version
    OR NEW.publication_policy_hash IS DISTINCT FROM OLD.publication_policy_hash
    OR NEW.media_evidence_hash IS DISTINCT FROM OLD.media_evidence_hash
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.submission_snapshot_id IS NOT NULL AND NEW.submission_snapshot_id IS DISTINCT FROM OLD.submission_snapshot_id)
    OR (OLD.submission_job_id IS NOT NULL AND NEW.submission_job_id IS DISTINCT FROM OLD.submission_job_id)
    OR NEW.attempt_generation < OLD.attempt_generation
    OR NEW.attempt_generation > OLD.attempt_generation + 1
    OR NOT (NEW.status=OLD.status
      OR (OLD.status='RESERVED' AND NEW.status IN ('SUBMITTED','FAILED','BLOCKED'))
      OR (OLD.status='SUBMITTED' AND NEW.status IN ('RECONCILING','SUCCEEDED','FAILED','BLOCKED'))
      OR (OLD.status='RECONCILING' AND NEW.status IN ('SUCCEEDED','FAILED','BLOCKED')))
    OR (NEW.status='RESERVED' AND (NULLIF(BTRIM(NEW.claim_token),'') IS NULL OR NEW.claim_expires_at IS NULL))
    OR (NEW.status<>'RESERVED' AND (NEW.claim_token IS NOT NULL OR NEW.claim_expires_at IS NOT NULL))
  THEN
    RAISE EXCEPTION 'invalid auto-listing submission link mutation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
