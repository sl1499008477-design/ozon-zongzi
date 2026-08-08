-- A PREPARED paid subcall is durable proof that no provider transport started.
-- Once its attempt lease expires, a later account state transition may safely
-- terminal it. SENDING remains quarantined for same-key reconciliation only.

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
       SET status='FAILED',completed_at=NOW()
      FROM ai_gateway_capability_attempts attempt
     WHERE reservation.account_id=target_account_id
       AND reservation.status='PREPARED'
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

CREATE OR REPLACE FUNCTION auto_listing_block_connection_transition_during_paid_subcall()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.status,NEW.status_version) IS DISTINCT FROM (OLD.status,OLD.status_version) THEN
    PERFORM auto_listing_cleanup_expired_prepared_capability_subcalls(OLD.account_id);
    IF EXISTS (
      SELECT 1
        FROM ai_gateway_capability_subcall_reservations reservation
       WHERE reservation.account_id=OLD.account_id
         AND reservation.status IN ('PREPARED','SENDING')
    ) THEN
      RAISE EXCEPTION 'active paid capability subcall blocks connection state transition'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
