-- Depends on the AI profile/admin contracts introduced by migrations 033 and
-- 034. Historical gateway profiles remain unchanged; only new capability
-- tests create append-only fenced attempt rows.

CREATE TABLE IF NOT EXISTS ai_gateway_capability_attempts (
  id TEXT PRIMARY KEY,
  fence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  correlation_id TEXT NOT NULL,
  lease_version INTEGER NOT NULL DEFAULT 1 CHECK (lease_version > 0),
  lease_token TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'PASSED', 'FAILED', 'STALE')),
  completion_hash TEXT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, profile_id, config_version, correlation_id),
  FOREIGN KEY (account_id, profile_id, config_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version) ON DELETE RESTRICT,
  CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  CHECK (auto_listing_ai_runtime_safe_identifier(correlation_id)),
  CHECK (auto_listing_ai_runtime_safe_identifier(lease_token)),
  CHECK (
    (status = 'RUNNING' AND completion_hash IS NULL AND response IS NULL AND completed_at IS NULL
      AND lease_expires_at IS NOT NULL)
    OR (status IN ('PASSED', 'FAILED', 'STALE')
      AND completion_hash ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(response) = 'object'
      AND response <> '{}'::JSONB
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_gateway_capability_attempts_profile_fence_idx
  ON ai_gateway_capability_attempts(account_id, profile_id, config_version, fence DESC);

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

DROP TRIGGER IF EXISTS ai_gateway_capability_attempts_terminal_immutable
  ON ai_gateway_capability_attempts;
CREATE TRIGGER ai_gateway_capability_attempts_terminal_immutable
BEFORE UPDATE OR DELETE ON ai_gateway_capability_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_terminal_gateway_capability_attempt_mutation();
