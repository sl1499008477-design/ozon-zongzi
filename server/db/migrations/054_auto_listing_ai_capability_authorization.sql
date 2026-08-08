-- Upgrade already-migrated Task 7 databases with durable, lease-bound paid
-- capability authorization. The same additions live in 053 for fresh installs;
-- every statement here is idempotent for databases that received that version.

ALTER TABLE ai_gateway_capability_attempts
  ADD COLUMN IF NOT EXISTS authorization_schema_version TEXT,
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS cost_confirmed BOOLEAN,
  ADD COLUMN IF NOT EXISTS authorization_hash TEXT,
  ADD COLUMN IF NOT EXISTS request_key TEXT,
  ADD COLUMN IF NOT EXISTS actor_id TEXT,
  ADD COLUMN IF NOT EXISTS target_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS target_connection_version INTEGER,
  ADD COLUMN IF NOT EXISTS target_connection_status TEXT,
  ADD COLUMN IF NOT EXISTS target_connection_status_version INTEGER,
  ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_gateway_capability_attempts_authorization_shape_check'
      AND conrelid = 'ai_gateway_capability_attempts'::regclass
  ) THEN
    ALTER TABLE ai_gateway_capability_attempts
      ADD CONSTRAINT ai_gateway_capability_attempts_authorization_shape_check CHECK (
        (authorization_schema_version IS NULL
          AND purpose IS NULL AND cost_confirmed IS NULL
          AND authorization_hash IS NULL AND request_key IS NULL AND actor_id IS NULL
          AND target_connection_id IS NULL AND target_connection_version IS NULL
          AND target_connection_status IS NULL AND target_connection_status_version IS NULL
          AND authorized_at IS NULL)
        OR
        (authorization_schema_version = 'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1'
          AND purpose IN ('PROFILE_CAPABILITY','ROLLBACK_CAPABILITY')
          AND cost_confirmed IS TRUE
          AND authorization_hash ~ '^[a-f0-9]{64}$'
          AND request_key ~ '^[a-f0-9]{64}$'
          AND NULLIF(BTRIM(actor_id), '') IS NOT NULL
          AND authorized_at IS NOT NULL
          AND (
            (target_connection_status = 'LEGACY'
              AND purpose = 'PROFILE_CAPABILITY'
              AND target_connection_id IS NULL AND target_connection_version IS NULL
              AND target_connection_status_version = 0)
            OR
            (target_connection_id IS NOT NULL AND target_connection_version > 0
              AND target_connection_status_version > 0
              AND ((purpose = 'PROFILE_CAPABILITY' AND target_connection_status = 'VALIDATED')
                OR (purpose = 'ROLLBACK_CAPABILITY' AND target_connection_status = 'RETIRED')))
          ))) NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_gateway_capability_attempts_target_connection_fkey'
      AND conrelid = 'ai_gateway_capability_attempts'::regclass
  ) THEN
    ALTER TABLE ai_gateway_capability_attempts
      ADD CONSTRAINT ai_gateway_capability_attempts_target_connection_fkey
      FOREIGN KEY (account_id,target_connection_id,target_connection_version)
      REFERENCES ai_gateway_connection_versions(account_id,id,version)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END;
$$;

ALTER TABLE ai_gateway_capability_attempts
  VALIDATE CONSTRAINT ai_gateway_capability_attempts_authorization_shape_check;
ALTER TABLE ai_gateway_capability_attempts
  VALIDATE CONSTRAINT ai_gateway_capability_attempts_target_connection_fkey;

CREATE INDEX IF NOT EXISTS ai_gateway_capability_attempts_authorization_idx
  ON ai_gateway_capability_attempts(account_id,profile_id,config_version,fence DESC)
  WHERE authorization_schema_version = 'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1';

CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_capability_attempts_request_key_uq
  ON ai_gateway_capability_attempts(account_id,request_key)
  WHERE request_key IS NOT NULL;

CREATE OR REPLACE FUNCTION auto_listing_require_authorized_gateway_capability_attempt_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.authorization_schema_version IS DISTINCT FROM 'AI_GATEWAY_CAPABILITY_AUTHORIZATION_V1'
    OR NEW.cost_confirmed IS DISTINCT FROM TRUE
    OR NEW.authorized_at IS NULL
  THEN
    RAISE EXCEPTION 'new AI gateway capability attempts require durable authorization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_gateway_capability_attempts_authorized_insert
  ON ai_gateway_capability_attempts;
CREATE TRIGGER ai_gateway_capability_attempts_authorized_insert
BEFORE INSERT ON ai_gateway_capability_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_require_authorized_gateway_capability_attempt_insert();


CREATE OR REPLACE FUNCTION auto_listing_reject_terminal_gateway_capability_attempt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('PASSED', 'FAILED', 'STALE') THEN
    RAISE EXCEPTION 'terminal AI gateway capability attempts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.fence IS DISTINCT FROM OLD.fence
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.config_version IS DISTINCT FROM OLD.config_version
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.authorization_schema_version IS DISTINCT FROM OLD.authorization_schema_version
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.cost_confirmed IS DISTINCT FROM OLD.cost_confirmed
    OR NEW.authorization_hash IS DISTINCT FROM OLD.authorization_hash
    OR NEW.request_key IS DISTINCT FROM OLD.request_key
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.target_connection_id IS DISTINCT FROM OLD.target_connection_id
    OR NEW.target_connection_version IS DISTINCT FROM OLD.target_connection_version
    OR NEW.target_connection_status IS DISTINCT FROM OLD.target_connection_status
    OR NEW.target_connection_status_version IS DISTINCT FROM OLD.target_connection_status_version
    OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
  THEN
    RAISE EXCEPTION 'AI gateway capability attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RUNNING' AND (
    NEW.lease_version < OLD.lease_version
    OR (NEW.lease_version = OLD.lease_version AND (
      NEW.lease_token IS DISTINCT FROM OLD.lease_token
      OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    ))
  ) THEN
    RAISE EXCEPTION 'AI gateway capability lease fence cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_ai_settings_audit_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source IN ('auto-listing-ai-settings','auto-listing-ai-admin')
    OR (TG_OP = 'UPDATE' AND NEW.source IN ('auto-listing-ai-settings','auto-listing-ai-admin'))
  THEN
    IF TG_OP = 'UPDATE'
      AND OLD.account_id IS NOT NULL
      AND NEW.account_id IS NULL
      AND (TO_JSONB(NEW) - 'account_id') IS NOT DISTINCT FROM (TO_JSONB(OLD) - 'account_id')
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AI gateway settings and capability audits are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
