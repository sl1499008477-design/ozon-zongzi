CREATE OR REPLACE FUNCTION auto_listing_rich_model_evidence_valid(
  model_name_value TEXT,
  gateway_request_id TEXT,
  input_hash_value TEXT,
  model_evidence_value JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    NULLIF(BTRIM(model_name_value), '') IS NOT NULL
    AND input_hash_value ~ '^[a-f0-9]{64}$'
    AND NULLIF(BTRIM(gateway_request_id), '') IS NOT NULL
    AND jsonb_typeof(model_evidence_value) = 'object'
    AND model_evidence_value ?& ARRAY[
      'requestedTextModel','gatewayReportedTextModel','gatewayReportedTextModelPresent'
    ]
    AND (model_evidence_value
      - 'requestedTextModel' - 'gatewayReportedTextModel' - 'gatewayReportedTextModelPresent') = '{}'::JSONB
    AND jsonb_typeof(model_evidence_value->'requestedTextModel') = 'string'
    AND model_evidence_value->>'requestedTextModel' = model_name_value
    AND jsonb_typeof(model_evidence_value->'gatewayReportedTextModel') = 'string'
    AND jsonb_typeof(model_evidence_value->'gatewayReportedTextModelPresent') = 'boolean'
    AND (
      (
        (model_evidence_value->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
        AND gateway_request_id <> 'auto-listing-rich-fallback-' || input_hash_value
        AND auto_listing_ai_model_identity_compatible(
          model_name_value,
          model_evidence_value->>'gatewayReportedTextModel'
        ) IS TRUE
      )
      OR (
        (model_evidence_value->'gatewayReportedTextModelPresent' = 'false'::JSONB) IS TRUE
        AND model_evidence_value->>'gatewayReportedTextModel' = ''
        AND gateway_request_id = 'auto-listing-rich-fallback-' || input_hash_value
      )
    );
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
      AND auto_listing_rich_model_evidence_valid(
        model_name, gateway_request_id, input_hash, model_evidence
      ) IS TRUE
      AND source_fact_evidence IS NOT NULL AND jsonb_typeof(source_fact_evidence) = 'array'
      AND jsonb_array_length(source_fact_evidence) BETWEEN 1 AND 256
      AND asset_evidence IS NOT NULL AND jsonb_typeof(asset_evidence) = 'array'
      AND jsonb_array_length(asset_evidence) BETWEEN 6 AND 20
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
      AND auto_listing_rich_model_evidence_valid(
        model_name, gateway_request_id, input_hash, model_evidence
      ) IS TRUE
      AND auto_listing_rich_fact_evidence_valid(source_fact_evidence) IS TRUE
      AND auto_listing_rich_asset_evidence_valid(asset_evidence) IS TRUE
      AND auto_listing_rich_asset_evidence_matches(
        asset_evidence, source_fact_evidence, account_id, job_id, item_id, plan_id,
        plan_hash, source_hash, profile_id, profile_version, model_name
      ) IS TRUE
      AND auto_listing_rich_content_valid(rich_content, source_fact_evidence, asset_evidence) IS TRUE
      AND auto_listing_rich_checker_evidence_valid(
        checker_result, rich_content, source_fact_evidence, asset_evidence
      ) IS TRUE
    )
  ) NOT VALID;
