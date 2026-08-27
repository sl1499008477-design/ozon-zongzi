CREATE OR REPLACE FUNCTION auto_listing_ai_model_identity_compatible(
  requested_model TEXT,
  reported_model TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parts TEXT[];
  snapshot_date DATE;
BEGIN
  IF NULLIF(BTRIM(requested_model), '') IS NULL
    OR NULLIF(BTRIM(reported_model), '') IS NULL
    OR BTRIM(requested_model) <> requested_model
    OR BTRIM(reported_model) <> reported_model
  THEN
    RETURN FALSE;
  END IF;

  IF reported_model = requested_model THEN
    RETURN TRUE;
  END IF;

  -- A configured snapshot is already exact and must not accept another suffix.
  IF requested_model ~ '-[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN FALSE;
  END IF;

  parts := regexp_match(reported_model, '^(.*)-([0-9]{4})-([0-9]{2})-([0-9]{2})$');
  IF parts IS NULL OR parts[1] <> requested_model THEN
    RETURN FALSE;
  END IF;

  BEGIN
    snapshot_date := make_date(parts[2]::INTEGER, parts[3]::INTEGER, parts[4]::INTEGER);
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  RETURN TO_CHAR(snapshot_date, 'YYYY-MM-DD') = parts[2] || '-' || parts[3] || '-' || parts[4];
END;
$$;

-- Keep the complete validator from 079 as the authority for every field except
-- the provider's legitimate dated model alias. The wrapper canonicalizes only
-- that one field before delegating, so arbitrary aliases and malformed evidence
-- continue to fail closed.
ALTER FUNCTION auto_listing_rich_asset_checker_evidence_valid(
  JSONB, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT
) RENAME TO auto_listing_rich_asset_checker_evidence_valid_v079;

CREATE FUNCTION auto_listing_rich_asset_checker_evidence_valid(
  value JSONB,
  source_asset_evidence JSONB,
  content_hash TEXT,
  checker_request_id TEXT,
  checker_model TEXT,
  profile_id TEXT,
  profile_account_id TEXT,
  profile_version INTEGER,
  template_version TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized_value JSONB := value;
  reported_model TEXT;
BEGIN
  reported_model := value->'checkerModelEvidence'->>'gatewayReportedTextModel';
  IF (value->'checkerModelEvidence'->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
    AND auto_listing_ai_model_identity_compatible(checker_model, reported_model)
  THEN
    normalized_value := jsonb_set(
      value,
      '{checkerModelEvidence,gatewayReportedTextModel}',
      TO_JSONB(checker_model),
      FALSE
    );
  END IF;

  RETURN auto_listing_rich_asset_checker_evidence_valid_v079(
    normalized_value,
    source_asset_evidence,
    content_hash,
    checker_request_id,
    checker_model,
    profile_id,
    profile_account_id,
    profile_version,
    template_version
  );
END;
$$;

ALTER TABLE ai_rich_content_results
  DROP CONSTRAINT IF EXISTS ai_rich_content_results_accepted_evidence_check;

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
      AND auto_listing_ai_model_identity_compatible(
        model_name,
        model_evidence->>'gatewayReportedTextModel'
      ) IS TRUE
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

ALTER TABLE ai_rich_content_results
  DROP CONSTRAINT IF EXISTS ai_rich_content_results_accepted_closed_evidence_check;

ALTER TABLE ai_rich_content_results
  ADD CONSTRAINT ai_rich_content_results_accepted_closed_evidence_check CHECK (
    status <> 'ACCEPTED' OR (
      request_evidence IS NOT NULL
      AND (jsonb_typeof(request_evidence) = 'object') IS TRUE
      AND (request_evidence ?& ARRAY['requestKey','schemaVersion']) IS TRUE
      AND ((request_evidence - 'requestKey' - 'schemaVersion') = '{}'::JSONB) IS TRUE
      AND (jsonb_typeof(request_evidence->'requestKey') = 'string') IS TRUE
      AND (request_evidence->>'requestKey' = 'auto-listing-rich-' || input_hash) IS TRUE
      AND (jsonb_typeof(request_evidence->'schemaVersion') = 'string') IS TRUE
      AND (request_evidence->>'schemaVersion' = 'AUTO_LISTING_RICH_CONTENT_V1') IS TRUE
      AND model_evidence IS NOT NULL
      AND (jsonb_typeof(model_evidence) = 'object') IS TRUE
      AND (model_evidence ?& ARRAY['requestedTextModel','gatewayReportedTextModel','gatewayReportedTextModelPresent']) IS TRUE
      AND ((model_evidence - 'requestedTextModel' - 'gatewayReportedTextModel' - 'gatewayReportedTextModelPresent') = '{}'::JSONB) IS TRUE
      AND (jsonb_typeof(model_evidence->'requestedTextModel') = 'string') IS TRUE
      AND (model_evidence->>'requestedTextModel' = model_name) IS TRUE
      AND (jsonb_typeof(model_evidence->'gatewayReportedTextModel') = 'string') IS TRUE
      AND auto_listing_ai_model_identity_compatible(
        model_name,
        model_evidence->>'gatewayReportedTextModel'
      ) IS TRUE
      AND (jsonb_typeof(model_evidence->'gatewayReportedTextModelPresent') = 'boolean') IS TRUE
      AND (model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
      AND auto_listing_rich_fact_evidence_valid(source_fact_evidence) IS TRUE
      AND auto_listing_rich_asset_evidence_valid(asset_evidence) IS TRUE
      AND auto_listing_rich_asset_evidence_matches(
        asset_evidence, source_fact_evidence, account_id, job_id, item_id, plan_id,
        plan_hash, source_hash, profile_id, profile_version, model_name
      ) IS TRUE
      AND auto_listing_rich_content_valid(rich_content, source_fact_evidence, asset_evidence) IS TRUE
      AND auto_listing_rich_checker_evidence_valid(checker_result, rich_content, source_fact_evidence, asset_evidence) IS TRUE
    )
  ) NOT VALID;
