-- Close resolver -> DNS -> provider TOCTOU for paid capability probes. A
-- reservation is committed before DNS and remains account-visible until the
-- provider subcall is terminal. Provider identity survives lease reclaim.

ALTER TABLE ai_gateway_capability_attempts
  ADD CONSTRAINT ai_gateway_capability_attempts_account_id_id_uq UNIQUE (account_id,id);

-- Databases that already recorded the first 054 must receive the privacy-delete
-- exception here because migrate.mjs will not execute 054 again.
CREATE OR REPLACE FUNCTION auto_listing_reject_terminal_gateway_capability_attempt_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'AI gateway capability attempts are append-only' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('PASSED', 'FAILED', 'STALE') THEN
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

CREATE TABLE IF NOT EXISTS ai_gateway_capability_subcall_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  attempt_fence BIGINT NOT NULL CHECK (attempt_fence > 0),
  lease_version INTEGER NOT NULL CHECK (lease_version > 0),
  reservation_version INTEGER NOT NULL DEFAULT 1 CHECK (reservation_version > 0),
  stage TEXT NOT NULL CHECK (stage IN ('REACHABILITY','TEXT','IMAGE')),
  status TEXT NOT NULL CHECK (status IN ('PREPARED','SENDING','SUCCEEDED','FAILED','STALE')),
  provider_request_key TEXT NOT NULL CHECK (provider_request_key ~ '^[a-f0-9]{64}$'),
  provider_correlation_id TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(provider_correlation_id)),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sending_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,attempt_id,stage),
  UNIQUE (account_id,provider_request_key),
  FOREIGN KEY (account_id,attempt_id)
    REFERENCES ai_gateway_capability_attempts(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,profile_id,config_version)
    REFERENCES ai_gateway_profiles(account_id,id,config_version) ON DELETE RESTRICT,
  CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  CHECK (
    (status='PREPARED' AND sending_at IS NULL AND completed_at IS NULL)
    OR (status='SENDING' AND sending_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('SUCCEEDED','FAILED','STALE') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_gateway_capability_subcall_reservations_active_idx
  ON ai_gateway_capability_subcall_reservations(account_id,attempt_id,stage)
  WHERE status IN ('PREPARED','SENDING');

CREATE OR REPLACE FUNCTION auto_listing_guard_ai_gateway_capability_subcall_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'paid capability subcall reservations are append-only' USING ERRCODE='23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.config_version IS DISTINCT FROM OLD.config_version
    OR NEW.attempt_fence IS DISTINCT FROM OLD.attempt_fence
    OR NEW.stage IS DISTINCT FROM OLD.stage
    OR NEW.provider_request_key IS DISTINCT FROM OLD.provider_request_key
    OR NEW.provider_correlation_id IS DISTINCT FROM OLD.provider_correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'paid capability subcall reservation identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_version < OLD.lease_version
    OR NEW.reservation_version < OLD.reservation_version
    OR (NEW.lease_version = OLD.lease_version AND NEW.reservation_version <> OLD.reservation_version)
  THEN
    RAISE EXCEPTION 'paid capability subcall reservation fence cannot move backwards' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_version = OLD.lease_version AND NOT (
    (OLD.status='PREPARED' AND NEW.status IN ('SENDING','FAILED','STALE'))
    OR (OLD.status='SENDING' AND NEW.status IN ('SUCCEEDED','FAILED','STALE'))
  ) THEN
    RAISE EXCEPTION 'invalid paid capability subcall transition' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_version > OLD.lease_version AND (
    NEW.status <> 'PREPARED'
    OR NEW.reservation_version <> OLD.reservation_version + 1
    OR NEW.sending_at IS NOT NULL OR NEW.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid paid capability subcall reclaim' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_gateway_capability_subcall_reservations_guard
  ON ai_gateway_capability_subcall_reservations;
CREATE TRIGGER ai_gateway_capability_subcall_reservations_guard
BEFORE UPDATE OR DELETE ON ai_gateway_capability_subcall_reservations
FOR EACH ROW EXECUTE FUNCTION auto_listing_guard_ai_gateway_capability_subcall_reservation();

CREATE OR REPLACE FUNCTION auto_listing_block_connection_transition_during_paid_subcall()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.status,NEW.status_version) IS DISTINCT FROM (OLD.status,OLD.status_version)
    AND EXISTS (
      SELECT 1
        FROM ai_gateway_capability_subcall_reservations reservation
       WHERE reservation.account_id=OLD.account_id
         AND reservation.status IN ('PREPARED','SENDING')
    )
  THEN
    RAISE EXCEPTION 'active paid capability subcall blocks connection state transition'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_gateway_connection_paid_subcall_guard
  ON ai_gateway_connection_versions;
CREATE TRIGGER ai_gateway_connection_paid_subcall_guard
BEFORE UPDATE ON ai_gateway_connection_versions
FOR EACH ROW EXECUTE FUNCTION auto_listing_block_connection_transition_during_paid_subcall();

-- Repository audits each PREPARED reservation as
-- AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_RESERVED and each provider send
-- with the immutable provider request-key hash.
