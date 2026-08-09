-- Allow a disabled successor profile to prove paid capabilities against the
-- exact, still-ACTIVE connection it will replace. Existing legacy and rollback
-- authorization shapes remain unchanged.

ALTER TABLE ai_gateway_capability_attempts
  DROP CONSTRAINT IF EXISTS ai_gateway_capability_attempts_authorization_shape_check;

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
          AND ((purpose = 'PROFILE_CAPABILITY'
                AND target_connection_status IN ('VALIDATED','ACTIVE'))
            OR (purpose = 'ROLLBACK_CAPABILITY'
                AND target_connection_status = 'RETIRED')))
      ))) NOT VALID;

ALTER TABLE ai_gateway_capability_attempts
  VALIDATE CONSTRAINT ai_gateway_capability_attempts_authorization_shape_check;
