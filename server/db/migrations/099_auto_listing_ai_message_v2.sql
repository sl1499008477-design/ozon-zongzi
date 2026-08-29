-- Fence new automatic-listing work from workers that only understand the
-- pre-six-image V1 message contract. Historical V1 rows stay readable so the
-- upgraded runtime can drain them after the unified restart.

ALTER TABLE auto_listing_ai_outbox
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_contract_version_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_new_contract_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_publication_lifecycle_check;

ALTER TABLE auto_listing_ai_outbox
  ADD CONSTRAINT auto_listing_ai_outbox_contract_version_check CHECK (
    contract_version IS NULL OR contract_version IN ('V1', 'V2')
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_new_contract_check CHECK (
    contract_version IS NULL OR ((
      contract_version IN ('V1', 'V2')
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
      (state = 'PENDING'
        AND publication_id IS NULL AND published_at IS NULL AND dispatch_queued_at IS NULL
        AND dead_at IS NULL AND next_retry_at IS NOT NULL)
      OR (state = 'PROCESSING' AND (
        (dispatch_contract_version IS NULL
          AND publication_id IS NULL AND published_at IS NULL AND dispatch_queued_at IS NULL)
        OR (dispatch_contract_version = 'CHANNEL_WORK_V1'
          AND publication_id = dedupe_key || ':' || dispatch_generation
          AND dispatch_queued_at IS NOT NULL)
      ) AND dead_at IS NULL AND next_retry_at IS NOT NULL)
      OR (state = 'COMPLETED' AND (
        (dispatch_contract_version IS NULL
          AND publication_id = dedupe_key AND published_at IS NOT NULL AND dispatch_queued_at IS NULL)
        OR (dispatch_contract_version = 'CHANNEL_WORK_V1'
          AND publication_id = dedupe_key || ':' || dispatch_generation
          AND dispatch_queued_at IS NOT NULL AND published_at IS NOT NULL)
      ) AND dead_at IS NULL AND last_error_code IS NULL AND next_retry_at IS NULL)
      OR (state = 'DEAD'
        AND publication_id IS NULL AND published_at IS NULL
        AND dead_at IS NOT NULL AND last_error_code IS NOT NULL AND next_retry_at IS NULL)
    )
  ) NOT VALID;

DROP INDEX IF EXISTS auto_listing_ai_outbox_runtime_pending_idx;
CREATE INDEX auto_listing_ai_outbox_runtime_pending_idx
  ON auto_listing_ai_outbox(account_id, next_retry_at, created_at, id)
  WHERE contract_version IN ('V1', 'V2') AND state = 'PENDING';

DROP INDEX IF EXISTS auto_listing_ai_outbox_runtime_lease_idx;
CREATE INDEX auto_listing_ai_outbox_runtime_lease_idx
  ON auto_listing_ai_outbox(account_id, lease_expires_at, id)
  WHERE contract_version IN ('V1', 'V2') AND state = 'PROCESSING';
