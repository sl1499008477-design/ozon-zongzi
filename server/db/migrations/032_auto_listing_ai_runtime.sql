-- Durable runtime for the dedicated auto-listing AI queue. Historical rows
-- created by migration 027 keep contract_version NULL and are not rewritten.

-- Historical jobs predate AI runtime execution, so their profile reference
-- remains an all-NULL pair. New jobs freeze one exact account-scoped profile
-- version selected by the repository in the job-creation transaction.
ALTER TABLE auto_listing_jobs
  ADD COLUMN IF NOT EXISTS ai_profile_id TEXT,
  ADD COLUMN IF NOT EXISTS ai_profile_version INTEGER;

ALTER TABLE auto_listing_jobs
  DROP CONSTRAINT IF EXISTS auto_listing_jobs_ai_profile_pair_check,
  DROP CONSTRAINT IF EXISTS auto_listing_jobs_ai_profile_scope_fk;

ALTER TABLE auto_listing_jobs
  ADD CONSTRAINT auto_listing_jobs_ai_profile_pair_check CHECK (
    (ai_profile_id IS NULL AND ai_profile_version IS NULL)
    OR (ai_profile_id IS NOT NULL AND ai_profile_version IS NOT NULL
      AND ai_profile_version > 0)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_jobs_ai_profile_scope_fk
    FOREIGN KEY (account_id, ai_profile_id, ai_profile_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION auto_listing_jobs_protect_ai_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ai_profile_id IS DISTINCT FROM OLD.ai_profile_id
    OR NEW.ai_profile_version IS DISTINCT FROM OLD.ai_profile_version
  THEN
    RAISE EXCEPTION 'auto-listing job AI profile is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_jobs_ai_profile_immutable ON auto_listing_jobs;
CREATE TRIGGER auto_listing_jobs_ai_profile_immutable
BEFORE UPDATE ON auto_listing_jobs
FOR EACH ROW EXECUTE FUNCTION auto_listing_jobs_protect_ai_profile();

-- Migration 027 protected profile configuration only after a content plan had
-- been written. A job now freezes the same profile earlier, so extend that
-- existing trigger function to close the creation-to-planning race. Capability
-- outcomes and enabled status remain operational fields and are still mutable.
CREATE OR REPLACE FUNCTION auto_listing_protect_referenced_ai_gateway_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    EXISTS (
      SELECT 1
      FROM ai_content_plans
      WHERE account_id = OLD.account_id
        AND profile_id = OLD.id
        AND profile_version = OLD.config_version
    )
    OR EXISTS (
      SELECT 1
      FROM auto_listing_jobs
      WHERE account_id = OLD.account_id
        AND ai_profile_id = OLD.id
        AND ai_profile_version = OLD.config_version
    )
  ) AND (
    NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.base_url IS DISTINCT FROM OLD.base_url
    OR NEW.api_key_env_name IS DISTINCT FROM OLD.api_key_env_name
    OR NEW.text_protocol IS DISTINCT FROM OLD.text_protocol
    OR NEW.image_protocol IS DISTINCT FROM OLD.image_protocol
    OR NEW.text_model IS DISTINCT FROM OLD.text_model
    OR NEW.image_model IS DISTINCT FROM OLD.image_model
    OR NEW.config_version IS DISTINCT FROM OLD.config_version
  ) THEN
    RAISE EXCEPTION 'referenced AI gateway profile configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE auto_listing_ai_outbox
  ADD COLUMN IF NOT EXISTS contract_version TEXT,
  ADD COLUMN IF NOT EXISTS phase TEXT,
  ADD COLUMN IF NOT EXISTS phase_target_id TEXT,
  ADD COLUMN IF NOT EXISTS expected_status_version INTEGER,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS publication_id TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE auto_listing_ai_outbox
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_state_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_runtime_state_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_runtime_lease_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_contract_version_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_new_contract_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_publication_lifecycle_check;

ALTER TABLE auto_listing_ai_outbox
  ADD CONSTRAINT auto_listing_ai_outbox_runtime_state_check CHECK (
    state IN ('PENDING', 'LEASED', 'PROCESSING', 'SUCCEEDED', 'COMPLETED', 'DEAD')
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_runtime_lease_check CHECK (
    (state = 'LEASED'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR (state = 'PROCESSING'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('LEASED', 'PROCESSING')
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION auto_listing_ai_runtime_is_ip(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  PERFORM value::INET;
  RETURN TRUE;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_ai_runtime_safe_identifier(value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT value IS NOT NULL
    AND NULLIF(BTRIM(value), '') IS NOT NULL
    AND value = BTRIM(value)
    AND OCTET_LENGTH(value) <= 240
    AND value ~ '^[[:alnum:]][[:alnum:]._:-]*$'
    AND value !~ '[[:cntrl:]]'
    AND POSITION('@' IN value) = 0
    AND NOT auto_listing_ai_runtime_is_ip(value)
    AND value !~* '(https?:|ftp:|file:|data:|www\.)'
    AND value !~* '(^|[._:-])(api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token)($|[._:-])'
    AND value !~* '(^|[^[:alnum:]-])([[:alnum:]]([[:alnum:]-]{0,61}[[:alnum:]])?\.)+([[:alpha:]]{2,63}|xn--[a-z0-9-]{2,59})($|[^[:alnum:]-])'
    AND value !~* '^(sk-(proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})$'
$$;

CREATE OR REPLACE FUNCTION auto_listing_ai_outbox_payload_valid(
  value JSONB,
  row_contract_version TEXT,
  row_account_id TEXT,
  row_item_id TEXT,
  row_phase TEXT,
  row_phase_target_id TEXT,
  row_expected_status_version INTEGER,
  row_correlation_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  key_count INTEGER;
  canonical_value TEXT;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;
  SELECT COUNT(*) INTO key_count FROM jsonb_object_keys(value);
  IF NOT (value ?& ARRAY['contractVersion','accountId','itemId','phase','expectedStatusVersion','correlationId'])
    OR jsonb_typeof(value->'contractVersion') IS DISTINCT FROM 'string'
    OR value->>'contractVersion' <> row_contract_version
    OR jsonb_typeof(value->'accountId') IS DISTINCT FROM 'string'
    OR value->>'accountId' <> row_account_id
    OR jsonb_typeof(value->'itemId') IS DISTINCT FROM 'string'
    OR value->>'itemId' <> row_item_id
    OR jsonb_typeof(value->'phase') IS DISTINCT FROM 'string'
    OR value->>'phase' <> row_phase
    OR jsonb_typeof(value->'expectedStatusVersion') IS DISTINCT FROM 'number'
    OR (value->>'expectedStatusVersion') !~ '^[1-9][0-9]*$'
    OR (value->'expectedStatusVersion')::INTEGER <> row_expected_status_version
    OR jsonb_typeof(value->'correlationId') IS DISTINCT FROM 'string'
    OR value->>'correlationId' <> row_correlation_id
    OR NOT auto_listing_ai_runtime_safe_identifier(value->>'accountId')
    OR NOT auto_listing_ai_runtime_safe_identifier(value->>'itemId')
    OR NOT auto_listing_ai_runtime_safe_identifier(value->>'correlationId')
  THEN
    RETURN FALSE;
  END IF;

  canonical_value := '{"accountId":' || TO_JSONB(value->>'accountId')::TEXT
    || ',"contractVersion":' || TO_JSONB(value->>'contractVersion')::TEXT
    || ',"correlationId":' || TO_JSONB(value->>'correlationId')::TEXT
    || ',"expectedStatusVersion":' || (value->>'expectedStatusVersion')
    || ',"itemId":' || TO_JSONB(value->>'itemId')::TEXT
    || ',"phase":' || TO_JSONB(value->>'phase')::TEXT;

  IF row_phase = 'MATERIALIZE_SOURCE_ASSET' THEN
    canonical_value := canonical_value || ',"sourceAssetId":' || TO_JSONB(value->>'sourceAssetId')::TEXT || '}';
    RETURN OCTET_LENGTH(canonical_value) <= 2048 AND key_count = 7
      AND value ? 'sourceAssetId'
      AND jsonb_typeof(value->'sourceAssetId') = 'string'
      AND value->>'sourceAssetId' = row_phase_target_id
      AND auto_listing_ai_runtime_safe_identifier(value->>'sourceAssetId');
  ELSIF row_phase = 'GENERATE_IMAGE_SLOT' THEN
    canonical_value := canonical_value || ',"slotKey":' || TO_JSONB(value->>'slotKey')::TEXT || '}';
    RETURN OCTET_LENGTH(canonical_value) <= 2048 AND key_count = 7
      AND value ? 'slotKey'
      AND jsonb_typeof(value->'slotKey') = 'string'
      AND value->>'slotKey' = row_phase_target_id
      AND auto_listing_ai_runtime_safe_identifier(value->>'slotKey');
  END IF;

  canonical_value := canonical_value || '}';
  RETURN OCTET_LENGTH(canonical_value) <= 2048 AND key_count = 6 AND row_phase_target_id IS NULL
    AND NOT (value ? 'sourceAssetId') AND NOT (value ? 'slotKey');
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

ALTER TABLE auto_listing_ai_outbox
  ADD CONSTRAINT auto_listing_ai_outbox_contract_version_check CHECK (
    contract_version IS NULL OR contract_version = 'V1'
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_new_contract_check CHECK (
    contract_version IS NULL OR ((
      contract_version = 'V1'
      AND state IN ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD')
      AND phase IN ('PLAN_CONTENT', 'MATERIALIZE_SOURCE_ASSET', 'FINALIZE_MATERIALIZED_PLAN', 'GENERATE_IMAGE_SLOT', 'GENERATE_RICH_CONTENT')
      AND event_type = phase
      AND expected_status_version BETWEEN 1 AND 2147483647
      AND auto_listing_ai_runtime_safe_identifier(id)
      AND dedupe_key ~ '^[a-f0-9]{64}$'
      AND auto_listing_ai_runtime_safe_identifier(correlation_id)
      AND auto_listing_ai_outbox_payload_valid(
        payload, contract_version, account_id, item_id, phase, phase_target_id,
        expected_status_version, correlation_id
      ) IS TRUE
      AND last_error_safe IS NULL
      AND (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$')
    ) IS TRUE)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_publication_lifecycle_check CHECK (
    contract_version IS NULL OR (
      (state IN ('PENDING', 'PROCESSING')
        AND publication_id IS NULL AND published_at IS NULL AND dead_at IS NULL
        AND next_retry_at IS NOT NULL)
      OR (state = 'COMPLETED'
        AND publication_id IS NOT NULL AND publication_id = dedupe_key
        AND published_at IS NOT NULL AND dead_at IS NULL AND last_error_code IS NULL
        AND next_retry_at IS NULL)
      OR (state = 'DEAD'
        AND publication_id IS NULL AND published_at IS NULL
        AND dead_at IS NOT NULL AND last_error_code IS NOT NULL
        AND next_retry_at IS NULL)
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_ai_outbox_account_publication_key
  ON auto_listing_ai_outbox(account_id, publication_id)
  WHERE publication_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_listing_ai_outbox_runtime_pending_idx
  ON auto_listing_ai_outbox(account_id, next_retry_at, created_at, id)
  WHERE contract_version = 'V1' AND state = 'PENDING';
CREATE INDEX IF NOT EXISTS auto_listing_ai_outbox_runtime_lease_idx
  ON auto_listing_ai_outbox(account_id, lease_expires_at, id)
  WHERE contract_version = 'V1' AND state = 'PROCESSING';

CREATE OR REPLACE FUNCTION auto_listing_ai_outbox_protect_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state IN ('SUCCEEDED', 'COMPLETED', 'DEAD') THEN
    RAISE EXCEPTION 'terminal auto-listing AI outbox rows are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.contract_version IS NOT NULL THEN
    RAISE EXCEPTION 'auto-listing AI outbox audit rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.contract_version IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.phase IS DISTINCT FROM OLD.phase
    OR NEW.phase_target_id IS DISTINCT FROM OLD.phase_target_id
    OR NEW.expected_status_version IS DISTINCT FROM OLD.expected_status_version
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
  ) THEN
    RAISE EXCEPTION 'auto-listing AI outbox contract is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_ai_outbox_terminal_immutable ON auto_listing_ai_outbox;
CREATE TRIGGER auto_listing_ai_outbox_terminal_immutable
BEFORE UPDATE OR DELETE ON auto_listing_ai_outbox
FOR EACH ROW EXECUTE FUNCTION auto_listing_ai_outbox_protect_contract();

ALTER TABLE ai_content_plans
  ADD COLUMN IF NOT EXISTS parent_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS derivation_kind TEXT,
  ADD COLUMN IF NOT EXISTS materialization_set_hash TEXT,
  ADD COLUMN IF NOT EXISTS fact_registry JSONB,
  ADD COLUMN IF NOT EXISTS fact_registry_hash TEXT;

ALTER TABLE ai_content_plans
  DROP CONSTRAINT IF EXISTS ai_content_plans_materialization_derivation_check,
  DROP CONSTRAINT IF EXISTS ai_content_plans_parent_scope_fk,
  DROP CONSTRAINT IF EXISTS ai_content_plans_fact_registry_contract_check;

ALTER TABLE ai_content_plans
  ADD CONSTRAINT ai_content_plans_materialization_derivation_check CHECK (
    (parent_plan_id IS NULL AND derivation_kind IS NULL AND materialization_set_hash IS NULL)
    OR (parent_plan_id IS NOT NULL AND parent_plan_id <> id
      AND derivation_kind = 'SOURCE_MATERIALIZATION'
      AND materialization_set_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT ai_content_plans_parent_scope_fk
    FOREIGN KEY (account_id, job_id, item_id, parent_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT ai_content_plans_fact_registry_contract_check CHECK (
    (fact_registry IS NULL AND fact_registry_hash IS NULL)
    OR (jsonb_typeof(fact_registry) = 'array'
      AND jsonb_array_length(fact_registry) BETWEEN 1 AND 10000
      AND fact_registry_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ai_content_plans_derived_materialization_key
  ON ai_content_plans(account_id, job_id, item_id, parent_plan_id, materialization_set_hash)
  WHERE parent_plan_id IS NOT NULL;

-- Generation rows created before this runtime contract remain valid with a
-- NULL fence. New production adapters always persist the item version they
-- locked, and every owner transition compares that value again.
ALTER TABLE ai_generation_assets
  ADD COLUMN IF NOT EXISTS expected_status_version INTEGER;

ALTER TABLE ai_generation_assets
  DROP CONSTRAINT IF EXISTS ai_generation_assets_expected_status_version_check;

ALTER TABLE ai_generation_assets
  ADD CONSTRAINT ai_generation_assets_expected_status_version_check CHECK (
    expected_status_version IS NULL
    OR expected_status_version BETWEEN 1 AND 2147483647
  ) NOT VALID;

ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS active_content_plan_id TEXT;

ALTER TABLE auto_listing_job_items
  DROP CONSTRAINT IF EXISTS auto_listing_job_items_active_content_plan_scope_fk;

ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_active_content_plan_scope_fk
    FOREIGN KEY (account_id, job_id, id, active_content_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT NOT VALID;

CREATE TABLE IF NOT EXISTS auto_listing_content_plan_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('PLANNING', 'ACCEPTED', 'FAILED')),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  accepted_plan_id TEXT,
  accepted_at TIMESTAMPTZ,
  error_code TEXT,
  error_retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  CHECK (
    (status = 'PLANNING'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND accepted_plan_id IS NULL AND accepted_at IS NULL AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'ACCEPTED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND accepted_plan_id IS NOT NULL AND accepted_at IS NOT NULL AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'FAILED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND accepted_plan_id IS NULL AND accepted_at IS NULL
      AND error_code ~ '^[A-Z][A-Z0-9_]{0,119}$' AND error_retryable IS NOT NULL)
  ),
  UNIQUE (account_id, job_id, item_id, input_hash, attempt_no),
  FOREIGN KEY (account_id, job_id) REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id) REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, source_snapshot_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id, snapshot_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, profile_id, profile_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, accepted_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT
);

-- A re-applied early 032 draft may already own this table. Keep its historical
-- attempts readable while making the new planner request identity explicit.
ALTER TABLE auto_listing_content_plan_attempts
  ADD COLUMN IF NOT EXISTS expected_status_version INTEGER,
  ADD COLUMN IF NOT EXISTS request_key TEXT;

ALTER TABLE auto_listing_content_plan_attempts
  DROP CONSTRAINT IF EXISTS auto_listing_content_plan_attempt_request_contract_check;

ALTER TABLE auto_listing_content_plan_attempts
  ADD CONSTRAINT auto_listing_content_plan_attempt_request_contract_check CHECK (
    (expected_status_version IS NULL AND request_key IS NULL)
    OR (expected_status_version BETWEEN 1 AND 2147483647
      AND request_key ~ '^auto-listing-plan-[a-f0-9]{64}$')
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_active_input_key
  ON auto_listing_content_plan_attempts(account_id, job_id, item_id, input_hash)
  WHERE status = 'PLANNING';
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_accepted_input_key
  ON auto_listing_content_plan_attempts(account_id, job_id, item_id, input_hash)
  WHERE status = 'ACCEPTED';
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_active_request_key
  ON auto_listing_content_plan_attempts(account_id, job_id, item_id, request_key)
  WHERE status = 'PLANNING' AND request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_accepted_request_key
  ON auto_listing_content_plan_attempts(account_id, job_id, item_id, request_key)
  WHERE status = 'ACCEPTED' AND request_key IS NOT NULL;

-- 032 is not deployed yet, but an engineer may have re-applied an earlier
-- draft locally. Fail closed if that draft already contains overlapping
-- planning audit rows; never guess which row to delete or silently rewrite.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auto_listing_content_plan_attempts
    WHERE status = 'PLANNING'
    GROUP BY account_id,job_id,item_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple active content-plan attempts require operator remediation' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_one_planning_per_item
  ON auto_listing_content_plan_attempts(account_id, job_id, item_id)
  WHERE status = 'PLANNING';

CREATE OR REPLACE FUNCTION auto_listing_content_plan_attempt_require_runtime_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.expected_status_version IS NULL OR NEW.request_key IS NULL THEN
    RAISE EXCEPTION 'new content-plan attempts require the runtime request contract' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_content_plan_attempt_identity_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.profile_version IS DISTINCT FROM OLD.profile_version
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
    OR NEW.expected_status_version IS DISTINCT FROM OLD.expected_status_version
    OR NEW.request_key IS DISTINCT FROM OLD.request_key
  THEN
    RAISE EXCEPTION 'content-plan attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_content_plan_attempt_require_runtime_contract ON auto_listing_content_plan_attempts;
CREATE TRIGGER auto_listing_content_plan_attempt_require_runtime_contract
BEFORE INSERT ON auto_listing_content_plan_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_attempt_require_runtime_contract();

DROP TRIGGER IF EXISTS auto_listing_content_plan_attempt_identity_immutable ON auto_listing_content_plan_attempts;
CREATE TRIGGER auto_listing_content_plan_attempt_identity_immutable
BEFORE UPDATE ON auto_listing_content_plan_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_attempt_identity_immutable();

CREATE OR REPLACE FUNCTION auto_listing_runtime_reject_terminal_attempt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('ACCEPTED', 'FAILED') THEN
    RAISE EXCEPTION 'terminal auto-listing runtime attempts are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_content_plan_attempts_terminal_immutable ON auto_listing_content_plan_attempts;
CREATE TRIGGER auto_listing_content_plan_attempts_terminal_immutable
BEFORE UPDATE OR DELETE ON auto_listing_content_plan_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_runtime_reject_terminal_attempt_mutation();

CREATE TABLE IF NOT EXISTS auto_listing_source_materialization_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  parent_plan_id TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  source_ref_hash TEXT NOT NULL CHECK (source_ref_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  expected_status_version INTEGER NOT NULL DEFAULT 1 CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('MATERIALIZING', 'STORED', 'ACCEPTED', 'FAILED')),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  object_key_version TEXT,
  object_key TEXT,
  content_hash TEXT,
  content_type TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  accepted_at TIMESTAMPTZ,
  error_code TEXT,
  error_retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (auto_listing_ai_runtime_safe_identifier(id) AND auto_listing_ai_runtime_safe_identifier(source_asset_id)),
  CHECK (
    (status = 'MATERIALIZING'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND object_key_version IS NULL AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL
      AND width IS NULL AND height IS NULL AND size_bytes IS NULL
      AND accepted_at IS NULL AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'STORED'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND object_key_version = 'SOURCE_V1' AND object_key IS NOT NULL AND content_hash ~ '^[a-f0-9]{64}$'
      AND content_type IN ('image/png','image/jpeg','image/webp')
      AND width > 0 AND height > 0 AND size_bytes BETWEEN 1 AND 8388608
      AND accepted_at IS NULL AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'ACCEPTED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND object_key_version = 'SOURCE_V1' AND object_key IS NOT NULL AND content_hash ~ '^[a-f0-9]{64}$'
      AND content_type IN ('image/png','image/jpeg','image/webp')
      AND width > 0 AND height > 0 AND size_bytes > 0 AND accepted_at IS NOT NULL
      AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'FAILED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND accepted_at IS NULL AND error_code ~ '^[A-Z][A-Z0-9_]{0,119}$' AND error_retryable IS NOT NULL)
  ),
  CONSTRAINT auto_listing_source_materialization_attempt_scope_asset_key
    UNIQUE (account_id, job_id, item_id, parent_plan_id, source_asset_id, id),
  CONSTRAINT auto_listing_source_materialization_attempt_stored_evidence_key
    UNIQUE (account_id, job_id, item_id, parent_plan_id, source_asset_id, id, object_key_version, object_key, content_hash),
  UNIQUE (account_id, job_id, item_id, parent_plan_id, source_asset_id, source_ref_hash, input_hash, attempt_no),
  FOREIGN KEY (account_id, job_id) REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id) REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, parent_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT
);

-- Keep a re-applied early 032 draft compatible while making every new stored
-- record carry the immutable item version and SOURCE_V1 object-key contract.
ALTER TABLE auto_listing_source_materialization_attempts
  ADD COLUMN IF NOT EXISTS expected_status_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS object_key_version TEXT;

CREATE OR REPLACE FUNCTION auto_listing_source_materialization_key_segment(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT REPLACE(REPLACE(TRANSLATE(ENCODE(CONVERT_TO(value, 'UTF8'), 'base64'), '+/', '-_'), '=', ''), CHR(10), '')
$$;

CREATE OR REPLACE FUNCTION auto_listing_source_materialization_object_key_valid(
  row_account_id TEXT,
  row_job_id TEXT,
  row_item_id TEXT,
  row_parent_plan_id TEXT,
  row_source_asset_id TEXT,
  row_source_ref_hash TEXT,
  row_input_hash TEXT,
  row_attempt_no INTEGER,
  row_object_key_version TEXT,
  row_object_key TEXT,
  row_content_hash TEXT,
  row_content_type TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT row_object_key_version = 'SOURCE_V1'
    AND row_source_ref_hash ~ '^[a-f0-9]{64}$'
    AND row_input_hash ~ '^[a-f0-9]{64}$'
    AND row_content_hash ~ '^[a-f0-9]{64}$'
    AND row_attempt_no BETWEEN 1 AND 3
    AND row_content_type IN ('image/png','image/jpeg','image/webp')
    AND OCTET_LENGTH(row_object_key) <= 2048
    AND row_object_key = 'auto-listing/source/v1/'
      || auto_listing_source_materialization_key_segment(row_account_id) || '/'
      || auto_listing_source_materialization_key_segment(row_job_id) || '/'
      || auto_listing_source_materialization_key_segment(row_item_id) || '/'
      || auto_listing_source_materialization_key_segment(row_parent_plan_id) || '/'
      || auto_listing_source_materialization_key_segment(row_source_asset_id) || '/'
      || row_source_ref_hash || '/attempt-' || row_attempt_no || '/'
      || row_input_hash || '/' || row_content_hash || CASE row_content_type
        WHEN 'image/png' THEN '.png'
        WHEN 'image/jpeg' THEN '.jpg'
        WHEN 'image/webp' THEN '.webp'
      END
$$;

ALTER TABLE auto_listing_source_materialization_attempts
  DROP CONSTRAINT IF EXISTS auto_listing_source_materialization_expected_version_check,
  DROP CONSTRAINT IF EXISTS auto_listing_source_materialization_lifecycle_check;

ALTER TABLE auto_listing_source_materialization_attempts
  ADD CONSTRAINT auto_listing_source_materialization_expected_version_check CHECK (
    expected_status_version BETWEEN 1 AND 2147483647
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_source_materialization_lifecycle_check CHECK (
    (status = 'MATERIALIZING'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND object_key_version IS NULL AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL
      AND width IS NULL AND height IS NULL AND size_bytes IS NULL
      AND accepted_at IS NULL AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'STORED'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND auto_listing_source_materialization_object_key_valid(
        account_id,job_id,item_id,parent_plan_id,source_asset_id,source_ref_hash,input_hash,attempt_no,
        object_key_version,object_key,content_hash,content_type
      ) IS TRUE
      AND width > 0 AND height > 0 AND width::BIGINT * height::BIGINT <= 40000000
      AND size_bytes BETWEEN 1 AND 8388608
      AND accepted_at IS NULL AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'ACCEPTED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND auto_listing_source_materialization_object_key_valid(
        account_id,job_id,item_id,parent_plan_id,source_asset_id,source_ref_hash,input_hash,attempt_no,
        object_key_version,object_key,content_hash,content_type
      ) IS TRUE
      AND width > 0 AND height > 0 AND width::BIGINT * height::BIGINT <= 40000000
      AND size_bytes BETWEEN 1 AND 8388608 AND accepted_at IS NOT NULL
      AND error_code IS NULL AND error_retryable IS NULL)
    OR (status = 'FAILED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND accepted_at IS NULL
      AND error_code ~ '^[A-Z][A-Z0-9_]{0,119}$' AND error_retryable IS NOT NULL
      AND ((object_key_version IS NULL AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL
          AND width IS NULL AND height IS NULL AND size_bytes IS NULL)
        OR (auto_listing_source_materialization_object_key_valid(
            account_id,job_id,item_id,parent_plan_id,source_asset_id,source_ref_hash,input_hash,attempt_no,
            object_key_version,object_key,content_hash,content_type
          ) IS TRUE
          AND width > 0 AND height > 0 AND width::BIGINT * height::BIGINT <= 40000000
          AND size_bytes BETWEEN 1 AND 8388608)))
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_source_materialization_active_input_key
  ON auto_listing_source_materialization_attempts(account_id, job_id, item_id, parent_plan_id, source_asset_id, input_hash)
  WHERE status IN ('MATERIALIZING', 'STORED');
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_source_materialization_accepted_input_key
  ON auto_listing_source_materialization_attempts(account_id, job_id, item_id, parent_plan_id, source_asset_id, input_hash)
  WHERE status = 'ACCEPTED';

DROP TRIGGER IF EXISTS auto_listing_source_materialization_terminal_immutable ON auto_listing_source_materialization_attempts;
CREATE TRIGGER auto_listing_source_materialization_terminal_immutable
BEFORE UPDATE OR DELETE ON auto_listing_source_materialization_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_runtime_reject_terminal_attempt_mutation();

CREATE TABLE IF NOT EXISTS auto_listing_content_plan_derivations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  parent_plan_id TEXT NOT NULL,
  derived_plan_id TEXT NOT NULL,
  materialization_set_hash TEXT NOT NULL CHECK (materialization_set_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, job_id, item_id, parent_plan_id, materialization_set_hash),
  UNIQUE (account_id, job_id, item_id, derived_plan_id),
  FOREIGN KEY (account_id, job_id) REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id) REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, parent_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, derived_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS auto_listing_source_object_cleanup_obligations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  parent_plan_id TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  materialization_attempt_id TEXT NOT NULL,
  source_ref_hash TEXT NOT NULL CHECK (source_ref_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  lease_token TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(lease_token)),
  object_key_version TEXT NOT NULL CHECK (object_key_version = 'SOURCE_V1'),
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 100000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 100000),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  original_error_code TEXT NOT NULL CHECK (original_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'ADOPTED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_owner TEXT,
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'PROCESSING'
      AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (status <> 'PROCESSING'
      AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)),
  CHECK (width::BIGINT * height::BIGINT <= 40000000),
  CHECK (auto_listing_source_materialization_object_key_valid(
    account_id, job_id, item_id, parent_plan_id, source_asset_id,
    source_ref_hash, input_hash, attempt_no, object_key_version,
    object_key, content_hash, content_type
  ) IS TRUE),
  UNIQUE (account_id, object_key),
  FOREIGN KEY (account_id, job_id) REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id) REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, parent_plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT,
  CONSTRAINT auto_listing_source_cleanup_materialization_asset_fkey
    FOREIGN KEY (account_id, job_id, item_id, parent_plan_id, source_asset_id, materialization_attempt_id)
    REFERENCES auto_listing_source_materialization_attempts(
      account_id, job_id, item_id, parent_plan_id, source_asset_id, id
    ) ON DELETE RESTRICT
);

-- Reapplying 032 to a schema created by an earlier revision must strengthen
-- new writes without rewriting or rejecting its historical audit rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auto_listing_source_materialization_attempt_scope_asset_key'
      AND conrelid = 'auto_listing_source_materialization_attempts'::regclass
  ) THEN
    ALTER TABLE auto_listing_source_materialization_attempts
      ADD CONSTRAINT auto_listing_source_materialization_attempt_scope_asset_key
      UNIQUE (account_id, job_id, item_id, parent_plan_id, source_asset_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auto_listing_source_cleanup_materialization_asset_fkey'
      AND conrelid = 'auto_listing_source_object_cleanup_obligations'::regclass
  ) THEN
    ALTER TABLE auto_listing_source_object_cleanup_obligations
      ADD CONSTRAINT auto_listing_source_cleanup_materialization_asset_fkey
      FOREIGN KEY (account_id, job_id, item_id, parent_plan_id, source_asset_id, materialization_attempt_id)
      REFERENCES auto_listing_source_materialization_attempts(
        account_id, job_id, item_id, parent_plan_id, source_asset_id, id
      ) ON DELETE RESTRICT NOT VALID;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS auto_listing_source_cleanup_pending_idx
  ON auto_listing_source_object_cleanup_obligations(account_id, status, next_retry_at, created_at, id);
