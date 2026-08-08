-- Bind the exact fresh publication-health proof used by a DIRECT upload to
-- durable submission audit evidence. Columns remain nullable so historical
-- rows created before this migration stay readable; every new DIRECT row is
-- closed by the insert guards below.

ALTER TABLE auto_listing_submission_links
  ADD COLUMN IF NOT EXISTS direct_health_evidence_id TEXT;

ALTER TABLE auto_listing_upload_attempts
  ADD COLUMN IF NOT EXISTS direct_health_evidence_id TEXT;

ALTER TABLE auto_listing_submission_links
  ADD CONSTRAINT auto_listing_submission_links_direct_health_fkey
  FOREIGN KEY (account_id,direct_health_evidence_id)
  REFERENCES auto_listing_asset_publication_health_evidence(account_id,id) ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE auto_listing_upload_attempts
  ADD CONSTRAINT auto_listing_upload_attempts_direct_health_fkey
  FOREIGN KEY (account_id,direct_health_evidence_id)
  REFERENCES auto_listing_asset_publication_health_evidence(account_id,id) ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE auto_listing_upload_attempts
  ADD CONSTRAINT auto_listing_upload_attempts_direct_health_shape_check CHECK (
    (action = 'DIRECT_UPLOAD' AND direct_health_evidence_id IS NOT NULL)
    OR (action <> 'DIRECT_UPLOAD' AND direct_health_evidence_id IS NULL)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION auto_listing_validate_submission_link_direct_health()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  policy_mode TEXT;
BEGIN
  SELECT policy.mode INTO policy_mode
  FROM auto_listing_upload_policy_versions AS policy
  WHERE policy.account_id = NEW.account_id
    AND policy.id = NEW.upload_policy_version_id;

  IF policy_mode IS NULL THEN
    RAISE EXCEPTION 'submission link upload policy is unavailable' USING ERRCODE='23514';
  END IF;

  IF policy_mode = 'DIRECT' THEN
    IF NEW.direct_health_evidence_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM auto_listing_asset_publication_health_evidence AS health
      WHERE health.account_id = NEW.account_id
        AND health.id = NEW.direct_health_evidence_id
        AND health.publication_version = NEW.publication_version
        AND health.public_base_url = NEW.publication_base_url
        AND health.public_prefix = NEW.publication_prefix
        AND health.outcome = 'PASSED'
        AND health.expires_at > NOW()
    ) THEN
      RAISE EXCEPTION 'DIRECT submission link requires matching fresh publication health evidence'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.direct_health_evidence_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-DIRECT submission link cannot bind DIRECT health evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_submission_links_direct_health_guard
BEFORE INSERT ON auto_listing_submission_links
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_submission_link_direct_health();

CREATE OR REPLACE FUNCTION auto_listing_validate_upload_attempt_direct_health()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  link_row auto_listing_submission_links%ROWTYPE;
  policy_mode TEXT;
BEGIN
  SELECT link.* INTO link_row
  FROM auto_listing_submission_links AS link
  WHERE link.account_id = NEW.account_id
    AND link.job_id = NEW.job_id
    AND link.auto_listing_item_id = NEW.auto_listing_item_id
    AND link.id = NEW.submission_link_id
    AND link.target_store_id = NEW.target_store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload attempt submission link is unavailable' USING ERRCODE='23514';
  END IF;

  SELECT policy.mode INTO policy_mode
  FROM auto_listing_upload_policy_versions AS policy
  WHERE policy.account_id = NEW.account_id
    AND policy.id = link_row.upload_policy_version_id;

  IF NEW.action = 'DIRECT_UPLOAD' THEN
    IF policy_mode IS DISTINCT FROM 'DIRECT' OR NEW.direct_health_evidence_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM auto_listing_asset_publication_health_evidence AS health
        WHERE health.account_id = NEW.account_id
          AND health.id = NEW.direct_health_evidence_id
          AND health.publication_version = link_row.publication_version
          AND health.public_base_url = link_row.publication_base_url
          AND health.public_prefix = link_row.publication_prefix
          AND health.outcome = 'PASSED'
      ) THEN
      RAISE EXCEPTION 'DIRECT upload attempt requires matching publication health evidence'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.direct_health_evidence_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-DIRECT upload attempt cannot bind DIRECT health evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_upload_attempts_direct_health_guard
BEFORE INSERT ON auto_listing_upload_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_upload_attempt_direct_health();

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
    OR NEW.direct_health_evidence_id IS DISTINCT FROM OLD.direct_health_evidence_id
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
