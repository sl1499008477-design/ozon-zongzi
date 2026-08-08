-- Provider-send evidence is irreversible. A lease reclaim may reuse the same
-- provider identity, but an unresolved SENDING stage must never become a
-- cleanup-eligible PREPARED stage.

ALTER TABLE ai_gateway_capability_subcall_reservations
  ADD COLUMN IF NOT EXISTS ever_sending_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

-- The 055 guard predates ever_sending_at and rejects a same-status backfill.
-- DDL and the backfill share this migration transaction/table lock; restore the
-- stronger guard below before commit.
DROP TRIGGER IF EXISTS ai_gateway_capability_subcall_reservations_guard
  ON ai_gateway_capability_subcall_reservations;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM ai_gateway_capability_subcall_reservations reservation
      JOIN ai_gateway_capability_attempts attempt
        ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
      JOIN audit_events sending_event
        ON sending_event.account_id=reservation.account_id
       AND sending_event.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_SENDING'
       AND sending_event.metadata->>'attemptId'=reservation.attempt_id
       AND sending_event.metadata->>'stage'=reservation.stage
     WHERE sending_event.status IS DISTINCT FROM 'SUCCESS'
        OR sending_event.entity_type IS DISTINCT FROM 'ai_gateway_profile'
        OR sending_event.entity_id IS DISTINCT FROM reservation.profile_id
        OR sending_event.correlation_id IS DISTINCT FROM attempt.correlation_id
        OR sending_event.metadata->>'providerRequestKey' IS DISTINCT FROM reservation.provider_request_key
        OR sending_event.metadata->>'providerCorrelationId' IS DISTINCT FROM reservation.provider_correlation_id
  ) THEN
    RAISE EXCEPTION 'conflicting historical paid capability send evidence'
      USING ERRCODE='23514';
  END IF;
END;
$$;

WITH historical_send AS (
  SELECT reservation.account_id,reservation.id,MIN(sending_event.occurred_at) AS first_sending_at
    FROM ai_gateway_capability_subcall_reservations reservation
    JOIN ai_gateway_capability_attempts attempt
      ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
    JOIN audit_events sending_event
      ON sending_event.account_id=reservation.account_id
     AND sending_event.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_SENDING'
     AND sending_event.status='SUCCESS'
     AND sending_event.entity_type='ai_gateway_profile'
     AND sending_event.entity_id=reservation.profile_id
     AND sending_event.correlation_id=attempt.correlation_id
     AND sending_event.metadata->>'attemptId'=reservation.attempt_id
     AND sending_event.metadata->>'stage'=reservation.stage
     AND sending_event.metadata->>'providerRequestKey'=reservation.provider_request_key
     AND sending_event.metadata->>'providerCorrelationId'=reservation.provider_correlation_id
   GROUP BY reservation.account_id,reservation.id
)
UPDATE ai_gateway_capability_subcall_reservations reservation
   SET ever_sending_at=historical_send.first_sending_at
  FROM historical_send
 WHERE reservation.account_id=historical_send.account_id
   AND reservation.id=historical_send.id
   AND reservation.ever_sending_at IS NULL;

UPDATE ai_gateway_capability_subcall_reservations
   SET ever_sending_at=sending_at
 WHERE ever_sending_at IS NULL
   AND sending_at IS NOT NULL;

WITH terminal_evidence AS (
  SELECT reservation.account_id,reservation.id,
         MIN(terminal_event.metadata->>'reason') AS terminal_reason
    FROM ai_gateway_capability_subcall_reservations reservation
    JOIN ai_gateway_capability_attempts attempt
      ON attempt.account_id=reservation.account_id AND attempt.id=reservation.attempt_id
    JOIN audit_events terminal_event
      ON terminal_event.account_id=reservation.account_id
     AND terminal_event.action='AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED'
     AND terminal_event.status='SUCCESS'
     AND terminal_event.entity_type='ai_gateway_profile'
     AND terminal_event.entity_id=reservation.profile_id
     AND terminal_event.correlation_id=attempt.correlation_id
     AND terminal_event.metadata->>'attemptId'=reservation.attempt_id
     AND terminal_event.metadata->>'stage'=reservation.stage
     AND terminal_event.metadata->>'providerRequestKey'=reservation.provider_request_key
     AND terminal_event.metadata->>'providerCorrelationId'=reservation.provider_correlation_id
     AND (terminal_event.metadata->>'reservationVersion')::INTEGER=reservation.reservation_version
     AND terminal_event.metadata->>'outcome'=reservation.status
   WHERE reservation.status IN ('SUCCEEDED','FAILED','STALE')
     AND terminal_event.metadata->>'reason' IN (
       'PRE_SEND_ABORTED','PRE_SEND_FAILED','PRE_SEND_LEASE_EXPIRED',
       'PROVIDER_REJECTED','PROVIDER_ACCEPTED','EXECUTION_STALE')
   GROUP BY reservation.account_id,reservation.id
  HAVING COUNT(DISTINCT terminal_event.metadata->>'reason')=1
)
UPDATE ai_gateway_capability_subcall_reservations reservation
   SET terminal_reason=terminal_evidence.terminal_reason
  FROM terminal_evidence
 WHERE reservation.account_id=terminal_evidence.account_id
   AND reservation.id=terminal_evidence.id
   AND reservation.terminal_reason IS NULL;

-- Old 7af reclaim could erase SENDING into PREPARED. Once historical provider
-- send evidence is restored, restore the conservative active state as well.
UPDATE ai_gateway_capability_subcall_reservations
   SET status='SENDING',sending_at=ever_sending_at,completed_at=NULL,terminal_reason=NULL
 WHERE status='PREPARED'
   AND ever_sending_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='ai_gateway_capability_subcall_ever_sending_ck'
       AND conrelid='ai_gateway_capability_subcall_reservations'::regclass
  ) THEN
    ALTER TABLE ai_gateway_capability_subcall_reservations
      ADD CONSTRAINT ai_gateway_capability_subcall_ever_sending_ck CHECK (
        (sending_at IS NULL OR ever_sending_at IS NOT NULL)
        AND (status <> 'SENDING' OR ever_sending_at IS NOT NULL)
        AND (terminal_reason IS NULL OR terminal_reason IN (
          'PRE_SEND_ABORTED','PRE_SEND_FAILED','PRE_SEND_LEASE_EXPIRED',
          'PROVIDER_REJECTED','PROVIDER_ACCEPTED','EXECUTION_STALE'))
        AND (status NOT IN ('PREPARED','SENDING') OR terminal_reason IS NULL)
      );
  END IF;
END;
$$;

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
  IF OLD.ever_sending_at IS NOT NULL
    AND NEW.ever_sending_at IS DISTINCT FROM OLD.ever_sending_at
  THEN
    RAISE EXCEPTION 'paid capability provider-send evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.ever_sending_at IS NULL AND NEW.ever_sending_at IS NOT NULL AND NOT (
    OLD.status='PREPARED' AND NEW.status='SENDING'
    AND NEW.sending_at IS NOT NULL
    AND NEW.ever_sending_at IS NOT DISTINCT FROM NEW.sending_at
  ) THEN
    RAISE EXCEPTION 'paid capability provider-send evidence is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_version < OLD.lease_version
    OR NEW.reservation_version < OLD.reservation_version
    OR (NEW.lease_version = OLD.lease_version
      AND NEW.reservation_version <> OLD.reservation_version)
  THEN
    RAISE EXCEPTION 'paid capability subcall reservation fence cannot move backwards' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_version = OLD.lease_version AND NOT (
    (OLD.status='PREPARED' AND NEW.status='SENDING'
      AND NEW.sending_at IS NOT NULL AND NEW.completed_at IS NULL
      AND NEW.terminal_reason IS NULL)
    OR (OLD.status='PREPARED' AND OLD.ever_sending_at IS NULL AND NEW.status='FAILED'
      AND NEW.completed_at IS NOT NULL
      AND NEW.terminal_reason IN ('PRE_SEND_ABORTED','PRE_SEND_FAILED','PRE_SEND_LEASE_EXPIRED'))
    OR (OLD.status='PREPARED' AND OLD.ever_sending_at IS NULL AND NEW.status='STALE'
      AND NEW.completed_at IS NOT NULL AND NEW.terminal_reason='EXECUTION_STALE')
    OR (OLD.status='SENDING' AND NEW.status='SENDING'
      AND NEW.sending_at IS NOT DISTINCT FROM OLD.sending_at
      AND NEW.completed_at IS NULL AND NEW.terminal_reason IS NULL)
    OR (OLD.status='SENDING' AND NEW.status='SUCCEEDED'
      AND NEW.sending_at IS NOT DISTINCT FROM OLD.sending_at
      AND NEW.completed_at IS NOT NULL AND NEW.terminal_reason='PROVIDER_ACCEPTED')
    OR (OLD.status='SENDING' AND NEW.status='FAILED'
      AND NEW.sending_at IS NOT DISTINCT FROM OLD.sending_at
      AND NEW.completed_at IS NOT NULL AND NEW.terminal_reason='PROVIDER_REJECTED')
    OR (OLD.status='SENDING' AND NEW.status='STALE'
      AND NEW.sending_at IS NOT DISTINCT FROM OLD.sending_at
      AND NEW.completed_at IS NOT NULL AND NEW.terminal_reason='EXECUTION_STALE')
  ) THEN
    RAISE EXCEPTION 'invalid paid capability subcall transition' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_version > OLD.lease_version AND NOT (
    NEW.reservation_version = OLD.reservation_version + 1
    AND NEW.completed_at IS NULL
    AND NEW.terminal_reason IS NULL
    AND NEW.prepared_at >= OLD.prepared_at
    AND NEW.ever_sending_at IS NOT DISTINCT FROM OLD.ever_sending_at
    AND (
      (OLD.status='SENDING' AND NEW.status='SENDING'
        AND NEW.sending_at IS NOT DISTINCT FROM OLD.sending_at)
      OR (OLD.status<>'SENDING' AND NEW.status='PREPARED' AND NEW.sending_at IS NULL)
    )
  ) THEN
    RAISE EXCEPTION 'invalid paid capability subcall reclaim' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_gateway_capability_subcall_reservations_guard
BEFORE UPDATE OR DELETE ON ai_gateway_capability_subcall_reservations
FOR EACH ROW EXECUTE FUNCTION auto_listing_guard_ai_gateway_capability_subcall_reservation();

CREATE OR REPLACE FUNCTION auto_listing_cleanup_expired_prepared_capability_subcalls(
  target_account_id TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  cleaned_count INTEGER := 0;
BEGIN
  WITH expired AS (
    UPDATE ai_gateway_capability_subcall_reservations reservation
       SET status='FAILED',completed_at=NOW(),terminal_reason='PRE_SEND_LEASE_EXPIRED'
      FROM ai_gateway_capability_attempts attempt
     WHERE reservation.account_id=target_account_id
       AND reservation.status='PREPARED'
       AND reservation.ever_sending_at IS NULL
       AND attempt.account_id=reservation.account_id
       AND attempt.id=reservation.attempt_id
       AND attempt.lease_version=reservation.lease_version
       AND attempt.lease_expires_at<=NOW()
    RETURNING reservation.account_id,reservation.attempt_id,reservation.profile_id,
              reservation.stage,reservation.provider_request_key,
              reservation.provider_correlation_id,reservation.lease_version,
              reservation.reservation_version,attempt.correlation_id
  ), evidence AS (
    INSERT INTO audit_events (
      event_id,account_id,store_id,action,status,actor_type,actor_id,device_id,source,
      entity_type,entity_id,correlation_id,metadata,occurred_at,created_at
    )
    SELECT 'audit_ai_capability_expired_' || MD5(account_id || ':' || attempt_id || ':' || stage
                 || ':' || reservation_version::TEXT),
           account_id,NULL,'AUTO_LISTING_AI_PROFILE_CAPABILITY_SUBCALL_TERMINATED','SUCCESS',
           'system','expired-prepared-cleanup','','auto-listing-ai-admin',
           'ai_gateway_profile',profile_id,correlation_id,
           JSONB_BUILD_OBJECT(
             'requestHash',MD5('PRE_SEND_LEASE_EXPIRED:' || account_id || ':' || attempt_id || ':'
                 || stage || ':' || reservation_version::TEXT)
               || MD5(provider_request_key || ':PRE_SEND_LEASE_EXPIRED'),
             'attemptId',attempt_id,'stage',stage,'outcome','FAILED',
             'reason','PRE_SEND_LEASE_EXPIRED','providerRequestKey',provider_request_key,
             'providerCorrelationId',provider_correlation_id,'leaseVersion',lease_version,
             'reservationVersion',reservation_version),
           NOW(),NOW()
      FROM expired
    ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO cleaned_count FROM expired;
  RETURN cleaned_count;
END;
$$;
