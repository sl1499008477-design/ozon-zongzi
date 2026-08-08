-- Account-scoped, encrypted AI gateway connection configuration.
-- This migration is additive: legacy environment-backed profiles retain a
-- NULL connection reference and their existing api_key_env_name.

CREATE TABLE IF NOT EXISTS ai_gateway_connection_versions (
  fence BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  display_name TEXT NOT NULL CHECK (NULLIF(BTRIM(display_name), '') IS NOT NULL),
  base_url TEXT NOT NULL CHECK (NULLIF(BTRIM(base_url), '') IS NOT NULL),
  ciphertext TEXT NOT NULL CHECK (NULLIF(BTRIM(ciphertext), '') IS NOT NULL),
  iv TEXT NOT NULL CHECK (NULLIF(BTRIM(iv), '') IS NOT NULL),
  auth_tag TEXT NOT NULL CHECK (NULLIF(BTRIM(auth_tag), '') IS NOT NULL),
  algorithm TEXT NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  key_version TEXT NOT NULL CHECK (NULLIF(BTRIM(key_version), '') IS NOT NULL),
  fingerprint TEXT NOT NULL CHECK (NULLIF(BTRIM(fingerprint), '') IS NOT NULL),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VALIDATED', 'ACTIVE', 'RETIRED')),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version > 0),
  validation_result JSONB,
  validation_hash TEXT,
  rollback_evidence JSONB,
  rollback_evidence_hash TEXT,
  validated_at TIMESTAMPTZ,
  validated_by TEXT,
  activated_at TIMESTAMPTZ,
  activated_by TEXT,
  retired_at TIMESTAMPTZ,
  retired_by TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  correlation_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, id, version),
  UNIQUE (account_id, idempotency_key),
  CHECK ((validation_result IS NULL AND validation_hash IS NULL)
    OR (jsonb_typeof(validation_result) = 'object'
      AND validation_result <> '{}'::JSONB
      AND validation_hash ~ '^[a-f0-9]{64}$')),
  CHECK ((rollback_evidence IS NULL AND rollback_evidence_hash IS NULL)
    OR (jsonb_typeof(rollback_evidence) = 'object'
      AND rollback_evidence <> '{}'::JSONB
      AND rollback_evidence_hash ~ '^[a-f0-9]{64}$'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_connection_versions_one_active_per_account_uq
  ON ai_gateway_connection_versions(account_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ai_gateway_connection_versions_account_created_idx
  ON ai_gateway_connection_versions(account_id, created_at DESC, fence DESC);

CREATE TABLE IF NOT EXISTS ai_gateway_connection_events (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'PENDING_CREATED', 'VALIDATED', 'ACTIVATED', 'RETIRED', 'ROLLBACK_VALIDATED'
  )),
  status_version INTEGER NOT NULL CHECK (status_version > 0),
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, connection_id, connection_version, status_version),
  FOREIGN KEY (account_id, connection_id, connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_gateway_model_sync_tasks (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  sync_purpose TEXT NOT NULL CHECK (sync_purpose IN ('CATALOG_SYNC', 'ROLLBACK_CAPABILITY')),
  target_connection_status_version INTEGER NOT NULL CHECK (target_connection_status_version > 0),
  result_evidence_identity TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD')),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  last_error_safe TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, id, connection_id, connection_version),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id, connection_id, connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE CASCADE,
  CHECK (
    (status = 'LEASED'
      AND attempt_count > 0
      AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
      AND lease_token ~ '^[a-f0-9]{64}$'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL)
    OR (status IN ('PENDING', 'FAILED')
      AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL)
    OR (status IN ('SUCCEEDED', 'DEAD')
      AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL)
  ),
  CHECK (status IN ('FAILED', 'DEAD')
    OR (last_error_code IS NULL AND last_error_safe IS NULL)),
  CHECK (status NOT IN ('FAILED', 'DEAD')
    OR (NULLIF(BTRIM(last_error_code), '') IS NOT NULL
      AND NULLIF(BTRIM(last_error_safe), '') IS NOT NULL)),
  CHECK ((sync_purpose = 'ROLLBACK_CAPABILITY' AND status = 'SUCCEEDED'
      AND result_evidence_identity ~ '^[a-f0-9]{64}$')
    OR ((sync_purpose <> 'ROLLBACK_CAPABILITY' OR status <> 'SUCCEEDED')
      AND result_evidence_identity IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_model_sync_tasks_one_runnable_uq
  ON ai_gateway_model_sync_tasks(account_id, connection_id, connection_version)
  WHERE status IN ('PENDING', 'LEASED', 'FAILED');

CREATE INDEX IF NOT EXISTS ai_gateway_model_sync_tasks_runnable_accounts_idx
  ON ai_gateway_model_sync_tasks(account_id, available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED', 'LEASED');

CREATE TABLE IF NOT EXISTS ai_gateway_model_sync_events (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('ENQUEUED', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD')),
  status_version INTEGER NOT NULL CHECK (status_version > 0),
  lease_version INTEGER NOT NULL CHECK (lease_version >= 0),
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, task_id, status_version),
  FOREIGN KEY (account_id, task_id, connection_id, connection_version)
    REFERENCES ai_gateway_model_sync_tasks(account_id, id, connection_id, connection_version)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_gateway_model_catalogs (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  sync_task_id TEXT NOT NULL,
  catalog JSONB NOT NULL,
  catalog_hash TEXT NOT NULL CHECK (catalog_hash ~ '^[a-f0-9]{64}$'),
  capability_result JSONB NOT NULL,
  capability_hash TEXT NOT NULL CHECK (capability_hash ~ '^[a-f0-9]{64}$'),
  rollback_evidence_identity TEXT,
  tested_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, id, connection_id, connection_version),
  UNIQUE (account_id, id, sync_task_id, connection_id, connection_version),
  UNIQUE (account_id, sync_task_id),
  FOREIGN KEY (account_id, sync_task_id, connection_id, connection_version)
    REFERENCES ai_gateway_model_sync_tasks(account_id, id, connection_id, connection_version)
    ON DELETE CASCADE,
  CHECK (jsonb_typeof(catalog) = 'object'),
  CHECK (catalog <> '{}'::JSONB),
  CHECK (octet_length(catalog::TEXT) <= 1048576),
  CHECK (jsonb_typeof(capability_result) = 'object'),
  CHECK (capability_result <> '{}'::JSONB),
  CHECK (octet_length(capability_result::TEXT) <= 262144),
  CHECK (rollback_evidence_identity IS NULL
    OR rollback_evidence_identity ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS ai_gateway_model_sync_attempt_outcomes (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  lease_version INTEGER NOT NULL CHECK (lease_version > 0),
  lease_owner TEXT NOT NULL CHECK (NULLIF(BTRIM(lease_owner), '') IS NOT NULL),
  lease_token_digest TEXT NOT NULL CHECK (lease_token_digest ~ '^[a-f0-9]{64}$'),
  lease_identity_hash TEXT NOT NULL CHECK (lease_identity_hash ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'DEAD')),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  task_snapshot JSONB NOT NULL CHECK (jsonb_typeof(task_snapshot) = 'object'),
  catalog_id TEXT,
  catalog_hash TEXT,
  capability_hash TEXT,
  rollback_evidence_identity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, task_id, lease_version),
  UNIQUE (account_id, task_id, lease_version, lease_identity_hash),
  FOREIGN KEY (account_id, task_id, connection_id, connection_version)
    REFERENCES ai_gateway_model_sync_tasks(account_id, id, connection_id, connection_version)
    ON DELETE CASCADE,
  CHECK ((outcome = 'SUCCEEDED' AND NULLIF(BTRIM(catalog_id), '') IS NOT NULL)
    OR (outcome IN ('FAILED', 'DEAD') AND catalog_id IS NULL)),
  CHECK ((outcome = 'SUCCEEDED' AND catalog_hash ~ '^[a-f0-9]{64}$'
      AND capability_hash ~ '^[a-f0-9]{64}$')
    OR (outcome IN ('FAILED', 'DEAD') AND catalog_hash IS NULL AND capability_hash IS NULL)),
  CHECK (rollback_evidence_identity IS NULL
    OR (outcome = 'SUCCEEDED' AND rollback_evidence_identity ~ '^[a-f0-9]{64}$'))
);

CREATE OR REPLACE FUNCTION auto_listing_require_succeeded_ai_gateway_model_catalog()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_task ai_gateway_model_sync_tasks%ROWTYPE;
BEGIN
  SELECT * INTO source_task
  FROM ai_gateway_model_sync_tasks
  WHERE account_id = NEW.account_id
    AND id = NEW.sync_task_id
    AND connection_id = NEW.connection_id
    AND connection_version = NEW.connection_version;
  IF NOT FOUND OR source_task.status <> 'SUCCEEDED' OR NOT EXISTS (
    SELECT 1 FROM ai_gateway_model_sync_attempt_outcomes
    WHERE account_id = NEW.account_id
      AND task_id = NEW.sync_task_id
      AND connection_id = NEW.connection_id
      AND connection_version = NEW.connection_version
      AND outcome = 'SUCCEEDED'
      AND catalog_id = NEW.id
      AND catalog_hash = NEW.catalog_hash
      AND capability_hash = NEW.capability_hash
      AND rollback_evidence_identity IS NOT DISTINCT FROM NEW.rollback_evidence_identity
  ) THEN
    RAISE EXCEPTION 'model catalog requires a matching succeeded attempt outcome'
      USING ERRCODE = '23514';
  END IF;
  IF source_task.sync_purpose = 'CATALOG_SYNC' THEN
    IF NEW.rollback_evidence_identity IS NOT NULL
      OR source_task.result_evidence_identity IS NOT NULL
    THEN
      RAISE EXCEPTION 'catalog sync cannot mint rollback evidence' USING ERRCODE = '23514';
    END IF;
  ELSIF source_task.sync_purpose = 'ROLLBACK_CAPABILITY' THEN
    IF NEW.rollback_evidence_identity IS DISTINCT FROM source_task.result_evidence_identity
      OR NEW.capability_result->>'schemaVersion' IS DISTINCT FROM 'AI_GATEWAY_ROLLBACK_TEST_RESULT_V1'
      OR NEW.capability_result->>'outcome' IS DISTINCT FROM 'PASSED'
      OR NEW.capability_result->>'connectionId' IS DISTINCT FROM NEW.connection_id
      OR NEW.capability_result->>'connectionVersion' IS DISTINCT FROM NEW.connection_version::TEXT
      OR NEW.capability_result->'checks'->>'authentication' IS DISTINCT FROM 'true'
      OR NEW.capability_result->'checks'->>'modelsEndpoint' IS DISTINCT FROM 'true'
      OR NEW.tested_at < source_task.created_at
    THEN
      RAISE EXCEPTION 'rollback catalog requires fresh matching capability evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_model_catalogs_succeeded_attempt_guard
BEFORE INSERT ON ai_gateway_model_catalogs
FOR EACH ROW EXECUTE FUNCTION auto_listing_require_succeeded_ai_gateway_model_catalog();

CREATE TABLE IF NOT EXISTS ai_gateway_rollback_evidence_consumptions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  catalog_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  target_connection_status_version INTEGER NOT NULL CHECK (target_connection_status_version > 0),
  evidence_identity TEXT NOT NULL CHECK (evidence_identity ~ '^[a-f0-9]{64}$'),
  validation_hash TEXT NOT NULL CHECK (validation_hash ~ '^[a-f0-9]{64}$'),
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, catalog_id),
  UNIQUE (account_id, connection_id, connection_version, target_connection_status_version),
  FOREIGN KEY (account_id, catalog_id, task_id, connection_id, connection_version)
    REFERENCES ai_gateway_model_catalogs(account_id, id, sync_task_id, connection_id, connection_version)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id, task_id, connection_id, connection_version)
    REFERENCES ai_gateway_model_sync_tasks(account_id, id, connection_id, connection_version)
    ON DELETE CASCADE
);

ALTER TABLE ai_gateway_profiles
  ADD COLUMN IF NOT EXISTS connection_id TEXT,
  ADD COLUMN IF NOT EXISTS connection_version INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_gateway_profiles_connection_shape_check'
      AND conrelid = 'ai_gateway_profiles'::regclass
  ) THEN
    ALTER TABLE ai_gateway_profiles
      ADD CONSTRAINT ai_gateway_profiles_connection_shape_check CHECK (
        (connection_id IS NULL AND connection_version IS NULL
          AND api_key_env_name <> 'SUB2API_ENCRYPTED_KEY')
        OR (connection_id IS NOT NULL
          AND connection_version IS NOT NULL
          AND connection_version > 0
          AND api_key_env_name = 'SUB2API_ENCRYPTED_KEY')
      ) NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ai_gateway_profiles
    WHERE connection_id IS NULL
      AND connection_version IS NULL
      AND api_key_env_name = 'SUB2API_ENCRYPTED_KEY'
  ) THEN
    RAISE EXCEPTION 'legacy AI gateway profile uses encrypted sentinel without a connection binding'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_gateway_profiles_account_connection_fkey'
      AND conrelid = 'ai_gateway_profiles'::regclass
  ) THEN
    ALTER TABLE ai_gateway_profiles
      ADD CONSTRAINT ai_gateway_profiles_account_connection_fkey
      FOREIGN KEY (account_id, connection_id, connection_version)
      REFERENCES ai_gateway_connection_versions(account_id, id, version)
      ON DELETE CASCADE NOT VALID;
  END IF;
END;
$$;

ALTER TABLE ai_gateway_profiles
  VALIDATE CONSTRAINT ai_gateway_profiles_connection_shape_check;
ALTER TABLE ai_gateway_profiles
  VALIDATE CONSTRAINT ai_gateway_profiles_account_connection_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_gateway_profiles_account_config_connection_key'
      AND conrelid = 'ai_gateway_profiles'::regclass
  ) THEN
    ALTER TABLE ai_gateway_profiles
      ADD CONSTRAINT ai_gateway_profiles_account_config_connection_key
      UNIQUE (account_id, id, config_version, connection_id, connection_version);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS ai_gateway_profile_binding_events (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  catalog_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, profile_id, config_version),
  FOREIGN KEY (account_id, profile_id, config_version, connection_id, connection_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version, connection_id, connection_version)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id, catalog_id, connection_id, connection_version)
    REFERENCES ai_gateway_model_catalogs(account_id, id, connection_id, connection_version)
    ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION auto_listing_require_pending_ai_gateway_connection_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'PENDING'
    OR NEW.status_version IS DISTINCT FROM 1
    OR NEW.version IS DISTINCT FROM 1
    OR NEW.validation_result IS NOT NULL
    OR NEW.validation_hash IS NOT NULL
    OR NEW.rollback_evidence IS NOT NULL
    OR NEW.rollback_evidence_hash IS NOT NULL
    OR NEW.validated_at IS NOT NULL
    OR NEW.validated_by IS NOT NULL
    OR NEW.activated_at IS NOT NULL
    OR NEW.activated_by IS NOT NULL
    OR NEW.retired_at IS NOT NULL
    OR NEW.retired_by IS NOT NULL
  THEN
    RAISE EXCEPTION 'AI gateway connection versions must be inserted as PENDING'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_connection_versions_pending_insert_guard
BEFORE INSERT ON ai_gateway_connection_versions
FOR EACH ROW EXECUTE FUNCTION auto_listing_require_pending_ai_gateway_connection_insert();

CREATE OR REPLACE FUNCTION auto_listing_guard_ai_gateway_connection_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'AI gateway connection versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.base_url IS DISTINCT FROM OLD.base_url
    OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
    OR NEW.iv IS DISTINCT FROM OLD.iv
    OR NEW.auth_tag IS DISTINCT FROM OLD.auth_tag
    OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
    OR NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.status_version <> OLD.status_version + 1
    OR NOT (
      (OLD.status = 'PENDING' AND NEW.status = 'VALIDATED')
      OR (OLD.status = 'VALIDATED' AND NEW.status = 'ACTIVE')
      OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')
      OR (OLD.status = 'RETIRED' AND NEW.status = 'VALIDATED')
    )
  THEN
    RAISE EXCEPTION 'invalid AI gateway connection status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'VALIDATED' AND (
    jsonb_typeof(NEW.validation_result) IS DISTINCT FROM 'object'
    OR NEW.validation_result = '{}'::JSONB
    OR NEW.validation_hash !~ '^[a-f0-9]{64}$'
    OR NEW.validated_at IS NULL
    OR NULLIF(BTRIM(NEW.validated_by), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'validated AI gateway connection requires capability evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status = 'VALIDATED' AND (
    NEW.rollback_evidence IS NOT NULL OR NEW.rollback_evidence_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'initial validation cannot claim rollback evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RETIRED' AND NEW.status = 'VALIDATED' AND (
    jsonb_typeof(NEW.rollback_evidence) IS DISTINCT FROM 'object'
    OR NEW.rollback_evidence_hash !~ '^[a-f0-9]{64}$'
    OR NOT (
      (NEW.rollback_evidence->>'schemaVersion' = 'AI_GATEWAY_ROLLBACK_CAPABILITY_V2'
       AND EXISTS (
        SELECT 1
        FROM ai_gateway_model_catalogs c
        JOIN ai_gateway_model_sync_tasks t
          ON t.account_id = c.account_id
         AND t.id = c.sync_task_id
         AND t.connection_id = c.connection_id
         AND t.connection_version = c.connection_version
        JOIN ai_gateway_model_sync_attempt_outcomes o
          ON o.account_id = t.account_id
         AND o.task_id = t.id
         AND o.connection_id = t.connection_id
         AND o.connection_version = t.connection_version
         AND o.outcome = 'SUCCEEDED'
         AND o.catalog_id = c.id
        JOIN ai_gateway_rollback_evidence_consumptions x
          ON x.account_id = c.account_id
         AND x.catalog_id = c.id
         AND x.task_id = t.id
         AND x.connection_id = c.connection_id
         AND x.connection_version = c.connection_version
        WHERE c.account_id = OLD.account_id
          AND c.connection_id = OLD.id
          AND c.connection_version = OLD.version
          AND c.id = NEW.rollback_evidence->>'catalogId'
          AND c.sync_task_id = NEW.rollback_evidence->>'taskId'
          AND c.catalog_hash = NEW.rollback_evidence->>'catalogHash'
          AND c.capability_hash = NEW.rollback_evidence->>'capabilityHash'
          AND c.rollback_evidence_identity = NEW.rollback_evidence->>'evidenceIdentity'
          AND t.status = 'SUCCEEDED'
          AND t.sync_purpose = 'ROLLBACK_CAPABILITY'
          AND t.target_connection_status_version = OLD.status_version
          AND NEW.rollback_evidence->>'targetConnectionStatusVersion' = OLD.status_version::TEXT
          AND t.result_evidence_identity = c.rollback_evidence_identity
          AND o.rollback_evidence_identity = c.rollback_evidence_identity
          AND x.target_connection_status_version = OLD.status_version
          AND x.evidence_identity = c.rollback_evidence_identity
          AND x.validation_hash = NEW.validation_hash
          AND c.capability_result = NEW.validation_result
          AND c.capability_hash = NEW.validation_hash
      ))
      OR
      (NEW.rollback_evidence->>'schemaVersion' = 'AI_GATEWAY_PROFILE_ROLLBACK_CAPABILITY_V1'
       AND EXISTS (
        SELECT 1
        FROM ai_gateway_capability_attempts a
        JOIN ai_gateway_profiles p
          ON p.account_id = a.account_id
         AND p.id = a.profile_id
         AND p.config_version = a.config_version
        JOIN audit_events capability_audit
          ON capability_audit.account_id = a.account_id
         AND capability_audit.action = 'AUTO_LISTING_AI_PROFILE_CAPABILITY_TEST'
         AND capability_audit.status = 'SUCCESS'
         AND capability_audit.entity_type = 'ai_gateway_profile'
         AND capability_audit.entity_id = a.profile_id
         AND capability_audit.metadata->>'attemptId' = a.id
         AND capability_audit.metadata->>'purpose' = 'ROLLBACK_CAPABILITY'
         AND capability_audit.metadata->'costConfirmed' = 'true'::JSONB
        WHERE a.account_id = OLD.account_id
          AND a.id = NEW.rollback_evidence->>'attemptId'
          AND a.profile_id = NEW.rollback_evidence->>'profileId'
          AND a.config_version::TEXT = NEW.rollback_evidence->>'configVersion'
          AND a.status = 'PASSED'
          AND a.response->>'outcome' = 'PASSED'
          AND a.response->>'checkedAt' = NEW.rollback_evidence->>'checkedAt'
          AND (a.response->>'checkedAt')::TIMESTAMPTZ >= OLD.retired_at
          AND a.completed_at >= OLD.retired_at
          AND p.connection_id = OLD.id
          AND p.connection_version = OLD.version
          AND p.capability_result = NEW.validation_result
          AND (a.response - 'profileId' - 'configVersion' - 'enabled') = NEW.validation_result
      ))
    )
  ) THEN
    RAISE EXCEPTION 'rollback requires matching passed capability evidence' USING ERRCODE = '23514';
  END IF;
  IF (NEW.status = 'VALIDATED' AND (
      NEW.activated_at IS DISTINCT FROM OLD.activated_at
      OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
      OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
      OR NEW.retired_by IS DISTINCT FROM OLD.retired_by
    ))
    OR (NEW.status = 'ACTIVE' AND (
      NEW.validation_result IS DISTINCT FROM OLD.validation_result
      OR NEW.validation_hash IS DISTINCT FROM OLD.validation_hash
      OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
      OR NEW.validated_by IS DISTINCT FROM OLD.validated_by
      OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
      OR NEW.retired_by IS DISTINCT FROM OLD.retired_by
      OR NEW.rollback_evidence IS DISTINCT FROM OLD.rollback_evidence
      OR NEW.rollback_evidence_hash IS DISTINCT FROM OLD.rollback_evidence_hash
    ))
    OR (NEW.status = 'RETIRED' AND (
      NEW.validation_result IS DISTINCT FROM OLD.validation_result
      OR NEW.validation_hash IS DISTINCT FROM OLD.validation_hash
      OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
      OR NEW.validated_by IS DISTINCT FROM OLD.validated_by
      OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
      OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
      OR NEW.rollback_evidence IS DISTINCT FROM OLD.rollback_evidence
      OR NEW.rollback_evidence_hash IS DISTINCT FROM OLD.rollback_evidence_hash
    ))
  THEN
    RAISE EXCEPTION 'AI gateway connection transition evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_connection_versions_transition_guard
BEFORE UPDATE OR DELETE ON ai_gateway_connection_versions
FOR EACH ROW EXECUTE FUNCTION auto_listing_guard_ai_gateway_connection_version();

CREATE OR REPLACE FUNCTION auto_listing_require_pending_ai_gateway_model_sync_task()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'PENDING'
    OR NEW.status_version IS DISTINCT FROM 1
    OR NEW.attempt_count IS DISTINCT FROM 0
    OR NEW.lease_version IS DISTINCT FROM 0
    OR NEW.result_evidence_identity IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM ai_gateway_connection_versions
      WHERE account_id = NEW.account_id
        AND id = NEW.connection_id
        AND version = NEW.connection_version
        AND status_version = NEW.target_connection_status_version
        AND (
          (NEW.sync_purpose = 'CATALOG_SYNC'
            AND NEW.created_by = NEW.account_id
            AND status IN ('PENDING', 'VALIDATED', 'ACTIVE'))
          OR (NEW.sync_purpose = 'ROLLBACK_CAPABILITY' AND status = 'RETIRED')
        )
    )
  THEN
    RAISE EXCEPTION 'model sync task must target the exact allowed connection state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_model_sync_tasks_pending_insert_guard
BEFORE INSERT ON ai_gateway_model_sync_tasks
FOR EACH ROW EXECUTE FUNCTION auto_listing_require_pending_ai_gateway_model_sync_task();

CREATE OR REPLACE FUNCTION auto_listing_guard_ai_gateway_model_sync_task()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'AI gateway model sync tasks are durable evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_version IS DISTINCT FROM OLD.connection_version
    OR NEW.sync_purpose IS DISTINCT FROM OLD.sync_purpose
    OR NEW.target_connection_status_version IS DISTINCT FROM OLD.target_connection_status_version
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.status_version <> OLD.status_version + 1
    OR (NEW.status <> 'SUCCEEDED'
      AND NEW.result_evidence_identity IS DISTINCT FROM OLD.result_evidence_identity)
    OR NOT (
      (OLD.status IN ('PENDING', 'FAILED') AND NEW.status = 'LEASED')
      OR (OLD.status IN ('PENDING', 'FAILED')
        AND OLD.sync_purpose = 'ROLLBACK_CAPABILITY'
        AND NEW.status = 'DEAD'
        AND NOT EXISTS (
          SELECT 1 FROM ai_gateway_connection_versions
          WHERE account_id = OLD.account_id
            AND id = OLD.connection_id
            AND version = OLD.connection_version
            AND status = 'RETIRED'
            AND status_version = OLD.target_connection_status_version
        ))
      OR (OLD.status = 'LEASED' AND OLD.lease_expires_at <= NOW() AND NEW.status = 'LEASED')
      OR (OLD.status = 'LEASED' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'DEAD'))
    )
  THEN
    RAISE EXCEPTION 'invalid AI gateway model sync task transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
    OR NEW.attempt_count > OLD.attempt_count + 1
    OR NEW.lease_version < OLD.lease_version
    OR NEW.lease_version > OLD.lease_version + 1
  THEN
    RAISE EXCEPTION 'AI gateway model sync lease fence cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_model_sync_tasks_transition_guard
BEFORE UPDATE OR DELETE ON ai_gateway_model_sync_tasks
FOR EACH ROW EXECUTE FUNCTION auto_listing_guard_ai_gateway_model_sync_task();

CREATE OR REPLACE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AI gateway settings evidence is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER ai_gateway_connection_events_append_only
BEFORE UPDATE OR DELETE ON ai_gateway_connection_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation();

CREATE TRIGGER ai_gateway_model_sync_events_append_only
BEFORE UPDATE OR DELETE ON ai_gateway_model_sync_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation();

CREATE TRIGGER ai_gateway_model_catalogs_append_only
BEFORE UPDATE OR DELETE ON ai_gateway_model_catalogs
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation();

CREATE TRIGGER ai_gateway_model_sync_attempt_outcomes_append_only
BEFORE UPDATE OR DELETE ON ai_gateway_model_sync_attempt_outcomes
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation();

CREATE TRIGGER ai_gateway_rollback_evidence_consumptions_append_only
BEFORE UPDATE OR DELETE ON ai_gateway_rollback_evidence_consumptions
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation();

CREATE TRIGGER ai_gateway_profile_binding_events_append_only
BEFORE UPDATE OR DELETE ON ai_gateway_profile_binding_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_gateway_settings_evidence_mutation();

CREATE OR REPLACE FUNCTION auto_listing_protect_ai_gateway_profile_connection_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_version IS DISTINCT FROM OLD.connection_version
  THEN
    RAISE EXCEPTION 'AI gateway profile connection binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.connection_id IS NOT NULL AND (
    NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.api_key_env_name IS DISTINCT FROM OLD.api_key_env_name
    OR NEW.base_url IS DISTINCT FROM OLD.base_url
  ) THEN
    RAISE EXCEPTION 'AI gateway profile connection binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_profiles_connection_binding_immutable
BEFORE UPDATE ON ai_gateway_profiles
FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_ai_gateway_profile_connection_binding();

CREATE OR REPLACE FUNCTION auto_listing_ai_settings_audit_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source = 'auto-listing-ai-settings'
    OR (TG_OP = 'UPDATE' AND NEW.source = 'auto-listing-ai-settings')
  THEN
    IF TG_OP = 'UPDATE'
      AND OLD.account_id IS NOT NULL
      AND NEW.account_id IS NULL
      AND (TO_JSONB(NEW) - 'account_id') IS NOT DISTINCT FROM (TO_JSONB(OLD) - 'account_id')
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AI gateway settings audits are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_ai_settings_audit_append_only_trigger
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_ai_settings_audit_append_only();
