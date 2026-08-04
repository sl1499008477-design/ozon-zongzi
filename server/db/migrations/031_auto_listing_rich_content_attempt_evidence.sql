ALTER TABLE ai_rich_content_results
  ADD COLUMN IF NOT EXISTS plan_hash TEXT,
  ADD COLUMN IF NOT EXISTS fact_registry_hash TEXT,
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS gateway_request_id TEXT,
  ADD COLUMN IF NOT EXISTS request_evidence JSONB,
  ADD COLUMN IF NOT EXISTS model_evidence JSONB,
  ADD COLUMN IF NOT EXISTS source_fact_evidence JSONB,
  ADD COLUMN IF NOT EXISTS asset_evidence JSONB,
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_hash_format_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
    ALTER TABLE ai_rich_content_results
      ADD CONSTRAINT ai_rich_content_results_hash_format_check CHECK (
        (plan_hash IS NULL OR plan_hash ~ '^[a-f0-9]{64}$')
        AND (fact_registry_hash IS NULL OR fact_registry_hash ~ '^[a-f0-9]{64}$')
        AND (prompt_hash IS NULL OR prompt_hash ~ '^[a-f0-9]{64}$')
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_json_evidence_type_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
    ALTER TABLE ai_rich_content_results
      ADD CONSTRAINT ai_rich_content_results_json_evidence_type_check CHECK (
        (request_evidence IS NULL OR jsonb_typeof(request_evidence) = 'object')
        AND (model_evidence IS NULL OR jsonb_typeof(model_evidence) = 'object')
        AND (source_fact_evidence IS NULL OR jsonb_typeof(source_fact_evidence) = 'array')
        AND (asset_evidence IS NULL OR jsonb_typeof(asset_evidence) = 'array')
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_generating_evidence_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
    ALTER TABLE ai_rich_content_results
      ADD CONSTRAINT ai_rich_content_results_generating_evidence_check CHECK (
        status <> 'GENERATING' OR (
          plan_hash IS NOT NULL AND plan_hash ~ '^[a-f0-9]{64}$'
          AND fact_registry_hash IS NOT NULL AND fact_registry_hash ~ '^[a-f0-9]{64}$'
          AND prompt_hash IS NOT NULL AND prompt_hash ~ '^[a-f0-9]{64}$'
          AND request_evidence IS NOT NULL AND jsonb_typeof(request_evidence) = 'object'
          AND request_evidence ? 'requestKey'
          AND request_evidence ? 'schemaVersion'
          AND (request_evidence - 'requestKey' - 'schemaVersion') = '{}'::JSONB
          AND jsonb_typeof(request_evidence->'requestKey') = 'string'
          AND NULLIF(BTRIM(request_evidence->>'requestKey'), '') IS NOT NULL
          AND jsonb_typeof(request_evidence->'schemaVersion') = 'string'
          AND (request_evidence->>'schemaVersion' = 'AUTO_LISTING_RICH_CONTENT_V1') IS TRUE
          AND source_fact_evidence IS NOT NULL AND jsonb_typeof(source_fact_evidence) = 'array' AND jsonb_array_length(source_fact_evidence) BETWEEN 1 AND 256
          AND asset_evidence IS NOT NULL AND jsonb_typeof(asset_evidence) = 'array' AND jsonb_array_length(asset_evidence) BETWEEN 6 AND 20
          AND lease_owner IS NOT NULL AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
          AND lease_token IS NOT NULL AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
          AND lease_expires_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_accepted_evidence_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
    ALTER TABLE ai_rich_content_results
      ADD CONSTRAINT ai_rich_content_results_accepted_evidence_check CHECK (
        status <> 'ACCEPTED' OR (
          plan_hash IS NOT NULL AND plan_hash ~ '^[a-f0-9]{64}$'
          AND fact_registry_hash IS NOT NULL AND fact_registry_hash ~ '^[a-f0-9]{64}$'
          AND prompt_hash IS NOT NULL AND prompt_hash ~ '^[a-f0-9]{64}$'
          AND gateway_request_id IS NOT NULL AND NULLIF(BTRIM(gateway_request_id), '') IS NOT NULL
          AND request_evidence IS NOT NULL AND jsonb_typeof(request_evidence) = 'object'
          AND request_evidence ? 'requestKey'
          AND request_evidence ? 'schemaVersion'
          AND (request_evidence - 'requestKey' - 'schemaVersion') = '{}'::JSONB
          AND jsonb_typeof(request_evidence->'requestKey') = 'string'
          AND NULLIF(BTRIM(request_evidence->>'requestKey'), '') IS NOT NULL
          AND jsonb_typeof(request_evidence->'schemaVersion') = 'string'
          AND (request_evidence->>'schemaVersion' = 'AUTO_LISTING_RICH_CONTENT_V1') IS TRUE
          AND model_name IS NOT NULL AND NULLIF(BTRIM(model_name), '') IS NOT NULL
          AND model_evidence IS NOT NULL AND jsonb_typeof(model_evidence) = 'object'
          AND model_evidence ? 'requestedTextModel'
          AND model_evidence ? 'gatewayReportedTextModel'
          AND model_evidence ? 'gatewayReportedTextModelPresent'
          AND (model_evidence - 'requestedTextModel' - 'gatewayReportedTextModel' - 'gatewayReportedTextModelPresent') = '{}'::JSONB
          AND jsonb_typeof(model_evidence->'requestedTextModel') = 'string'
          AND NULLIF(BTRIM(model_evidence->>'requestedTextModel'), '') IS NOT NULL
          AND (model_evidence->>'requestedTextModel' = model_name) IS TRUE
          AND jsonb_typeof(model_evidence->'gatewayReportedTextModel') = 'string'
          AND NULLIF(BTRIM(model_evidence->>'gatewayReportedTextModel'), '') IS NOT NULL
          AND (model_evidence->>'gatewayReportedTextModel' = model_name) IS TRUE
          AND jsonb_typeof(model_evidence->'gatewayReportedTextModelPresent') = 'boolean'
          AND (model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
          AND source_fact_evidence IS NOT NULL AND jsonb_typeof(source_fact_evidence) = 'array' AND jsonb_array_length(source_fact_evidence) BETWEEN 1 AND 256
          AND asset_evidence IS NOT NULL AND jsonb_typeof(asset_evidence) = 'array' AND jsonb_array_length(asset_evidence) BETWEEN 6 AND 20
          AND checker_result IS NOT NULL AND jsonb_typeof(checker_result) = 'object'
          AND checker_result ? 'accepted'
          AND jsonb_typeof(checker_result->'accepted') = 'boolean'
          AND (checker_result->'accepted' = 'true'::JSONB) IS TRUE
          AND accepted_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_closed_lease_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
    ALTER TABLE ai_rich_content_results
      ADD CONSTRAINT ai_rich_content_results_closed_lease_check CHECK (
        (status = 'GENERATING'
          AND lease_owner IS NOT NULL AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
          AND lease_token IS NOT NULL AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
          AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'GENERATING'
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL)
      ) NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_full_attempt_key
  ON ai_rich_content_results(account_id, job_id, item_id, plan_id, input_hash, attempt_no);

-- Rows written before 031 have no lease evidence and are not active under the
-- new contract.  The predicate avoids rewriting or deleting their audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_active_input_key
  ON ai_rich_content_results(account_id, job_id, item_id, plan_id, input_hash)
  WHERE status = 'GENERATING' AND plan_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_full_accepted_input_key
  ON ai_rich_content_results(account_id, job_id, item_id, plan_id, input_hash)
  WHERE status = 'ACCEPTED';
