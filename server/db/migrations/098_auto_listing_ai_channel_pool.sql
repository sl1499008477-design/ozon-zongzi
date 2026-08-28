-- Account-scoped AI gateway channels keep selected connections and assignment
-- leases explicit. Historical runtime rows remain readable with NULL evidence.

CREATE TABLE IF NOT EXISTS auto_listing_ai_profile_channels (
  account_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  channel_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version > 0),
  channel_order INTEGER NOT NULL CHECK (channel_order > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_until TIMESTAMPTZ,
  requires_revalidation BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failure_count >= 0),
  assigned_job_id TEXT,
  assigned_item_id TEXT,
  assigned_status_version INTEGER,
  assigned_at TIMESTAMPTZ,
  execution_lease_owner TEXT,
  execution_lease_token TEXT,
  execution_lease_expires_at TIMESTAMPTZ,
  dispatch_generation INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_generation >= 0),
  uncertain_result_count INTEGER NOT NULL DEFAULT 0 CHECK (uncertain_result_count BETWEEN 0 AND 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, profile_id, profile_version, channel_id),
  UNIQUE (account_id, profile_id, profile_version, channel_order),
  UNIQUE (account_id, profile_id, profile_version, connection_id, connection_version),
  FOREIGN KEY (account_id, profile_id, profile_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, connection_id, connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, assigned_job_id, assigned_item_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  CHECK (cooldown_until IS NULL OR isfinite(cooldown_until)),
  CHECK (
    (assigned_job_id IS NULL AND assigned_item_id IS NULL
      AND assigned_status_version IS NULL AND assigned_at IS NULL)
    OR (assigned_job_id IS NOT NULL AND assigned_item_id IS NOT NULL
      AND assigned_status_version > 0 AND assigned_at IS NOT NULL)
  ),
  CHECK (
    (execution_lease_owner IS NULL AND execution_lease_token IS NULL AND execution_lease_expires_at IS NULL)
    OR (NULLIF(BTRIM(execution_lease_owner), '') IS NOT NULL
      AND NULLIF(BTRIM(execution_lease_token), '') IS NOT NULL
      AND execution_lease_expires_at IS NOT NULL
      AND assigned_job_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_ai_profile_channels_assigned_item_uq
  ON auto_listing_ai_profile_channels(account_id, assigned_job_id, assigned_item_id, assigned_status_version)
  WHERE assigned_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION auto_listing_ai_profile_channels_require_connection_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  connection_status TEXT;
BEGIN
  SELECT status INTO connection_status
  FROM ai_gateway_connection_versions
  WHERE account_id = NEW.account_id
    AND id = NEW.connection_id
    AND version = NEW.connection_version;

  IF connection_status IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.channel_order = 1 AND connection_status IS DISTINCT FROM 'ACTIVE')
    OR (NEW.channel_order > 1 AND connection_status IS DISTINCT FROM 'VALIDATED')
  THEN
    RAISE EXCEPTION 'AI profile channel requires an eligible connection status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_ai_profile_channels_connection_status ON auto_listing_ai_profile_channels;
CREATE TRIGGER auto_listing_ai_profile_channels_connection_status
BEFORE INSERT OR UPDATE OF account_id, connection_id, connection_version, channel_order
ON auto_listing_ai_profile_channels
FOR EACH ROW EXECUTE FUNCTION auto_listing_ai_profile_channels_require_connection_status();

ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS last_ai_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS last_ai_connection_version INTEGER,
  ADD COLUMN IF NOT EXISTS last_ai_channel_assigned_at TIMESTAMPTZ;

ALTER TABLE auto_listing_job_items
  DROP CONSTRAINT IF EXISTS auto_listing_job_items_last_ai_connection_pair_check,
  DROP CONSTRAINT IF EXISTS auto_listing_job_items_last_ai_connection_scope_fk;

ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_last_ai_connection_pair_check CHECK (
    (last_ai_connection_id IS NULL AND last_ai_connection_version IS NULL AND last_ai_channel_assigned_at IS NULL)
    OR (last_ai_connection_id IS NOT NULL AND last_ai_connection_version > 0 AND last_ai_channel_assigned_at IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_job_items_last_ai_connection_scope_fk
    FOREIGN KEY (account_id, last_ai_connection_id, last_ai_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE auto_listing_content_plan_attempts
  ADD COLUMN IF NOT EXISTS gateway_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS gateway_connection_version INTEGER;

ALTER TABLE auto_listing_content_plan_attempts
  DROP CONSTRAINT IF EXISTS auto_listing_content_plan_attempts_gateway_connection_pair_check,
  DROP CONSTRAINT IF EXISTS auto_listing_content_plan_attempts_gateway_connection_scope_fk;

ALTER TABLE auto_listing_content_plan_attempts
  ADD CONSTRAINT auto_listing_content_plan_attempts_gateway_connection_pair_check CHECK (
    (gateway_connection_id IS NULL AND gateway_connection_version IS NULL)
    OR (gateway_connection_id IS NOT NULL AND gateway_connection_version > 0)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_content_plan_attempts_gateway_connection_scope_fk
    FOREIGN KEY (account_id, gateway_connection_id, gateway_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ai_generation_assets
  ADD COLUMN IF NOT EXISTS gateway_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS gateway_connection_version INTEGER,
  ADD COLUMN IF NOT EXISTS checker_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS checker_connection_version INTEGER;

ALTER TABLE ai_generation_assets
  DROP CONSTRAINT IF EXISTS ai_generation_assets_gateway_connection_pair_check,
  DROP CONSTRAINT IF EXISTS ai_generation_assets_gateway_connection_scope_fk,
  DROP CONSTRAINT IF EXISTS ai_generation_assets_checker_connection_pair_check,
  DROP CONSTRAINT IF EXISTS ai_generation_assets_checker_connection_scope_fk;

ALTER TABLE ai_generation_assets
  ADD CONSTRAINT ai_generation_assets_gateway_connection_pair_check CHECK (
    (gateway_connection_id IS NULL AND gateway_connection_version IS NULL)
    OR (gateway_connection_id IS NOT NULL AND gateway_connection_version > 0)
  ) NOT VALID,
  ADD CONSTRAINT ai_generation_assets_gateway_connection_scope_fk
    FOREIGN KEY (account_id, gateway_connection_id, gateway_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT ai_generation_assets_checker_connection_pair_check CHECK (
    (checker_connection_id IS NULL AND checker_connection_version IS NULL)
    OR (checker_connection_id IS NOT NULL AND checker_connection_version > 0)
  ) NOT VALID,
  ADD CONSTRAINT ai_generation_assets_checker_connection_scope_fk
    FOREIGN KEY (account_id, checker_connection_id, checker_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ai_rich_content_results
  ADD COLUMN IF NOT EXISTS gateway_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS gateway_connection_version INTEGER;

ALTER TABLE ai_rich_content_results
  DROP CONSTRAINT IF EXISTS ai_rich_content_results_gateway_connection_pair_check,
  DROP CONSTRAINT IF EXISTS ai_rich_content_results_gateway_connection_scope_fk;

ALTER TABLE ai_rich_content_results
  ADD CONSTRAINT ai_rich_content_results_gateway_connection_pair_check CHECK (
    (gateway_connection_id IS NULL AND gateway_connection_version IS NULL)
    OR (gateway_connection_id IS NOT NULL AND gateway_connection_version > 0)
  ) NOT VALID,
  ADD CONSTRAINT ai_rich_content_results_gateway_connection_scope_fk
    FOREIGN KEY (account_id, gateway_connection_id, gateway_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id, id, version) ON DELETE RESTRICT NOT VALID;

ALTER TABLE auto_listing_ai_outbox
  ADD COLUMN IF NOT EXISTS dispatch_contract_version TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS uncertain_result_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispatch_queued_at TIMESTAMPTZ;

ALTER TABLE auto_listing_ai_outbox
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_dispatch_contract_version_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_dispatch_generation_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_uncertain_result_count_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_publication_lifecycle_check;

ALTER TABLE auto_listing_ai_outbox
  ADD CONSTRAINT auto_listing_ai_outbox_dispatch_contract_version_check CHECK (
    dispatch_contract_version IS NULL OR dispatch_contract_version = 'CHANNEL_WORK_V1'
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_dispatch_generation_check CHECK (
    dispatch_generation >= 0
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_uncertain_result_count_check CHECK (
    uncertain_result_count BETWEEN 0 AND 2
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_publication_lifecycle_check CHECK (
    contract_version IS NULL OR (
      (state = 'PENDING'
        AND publication_id IS NULL AND published_at IS NULL AND dispatch_queued_at IS NULL)
      OR (state = 'PROCESSING' AND (
        (dispatch_contract_version IS NULL
          AND publication_id IS NULL AND published_at IS NULL AND dispatch_queued_at IS NULL)
        OR (dispatch_contract_version = 'CHANNEL_WORK_V1'
          AND publication_id = dedupe_key || ':' || dispatch_generation
          AND dispatch_queued_at IS NOT NULL AND published_at IS NULL)
      ))
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
  IF TG_OP = 'UPDATE' AND OLD.state NOT IN ('PENDING', 'PROCESSING') AND (
    NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
    OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
    OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
    OR NEW.dispatch_contract_version IS DISTINCT FROM OLD.dispatch_contract_version
    OR NEW.dispatch_generation IS DISTINCT FROM OLD.dispatch_generation
    OR NEW.uncertain_result_count IS DISTINCT FROM OLD.uncertain_result_count
    OR NEW.dispatch_queued_at IS DISTINCT FROM OLD.dispatch_queued_at
  ) THEN
    RAISE EXCEPTION 'only pending or processing outbox rows may change dispatch or lease fields' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- A channel is synthesized only when the current enabled profile already
-- selects an active stored connection. Legacy environment-backed profiles are
-- deliberately left without a fabricated channel.
INSERT INTO auto_listing_ai_profile_channels (
  account_id, profile_id, profile_version, channel_id, display_name,
  connection_id, connection_version, channel_order
)
SELECT p.account_id, p.id, p.config_version, 'primary', p.display_name,
  p.connection_id, p.connection_version, 1
FROM ai_gateway_profiles p
JOIN ai_gateway_connection_versions c
  ON c.account_id = p.account_id
  AND c.id = p.connection_id
  AND c.version = p.connection_version
WHERE p.enabled IS TRUE
  AND p.connection_id IS NOT NULL
  AND p.connection_version IS NOT NULL
  AND c.status = 'ACTIVE'
ON CONFLICT DO NOTHING;
