CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_for_validation(value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry JSONB;
  normalized_entry JSONB;
  normalized_assets JSONB := '[]'::JSONB;
  full_sources JSONB;
  checker_sources JSONB;
  checker_model_evidence JSONB;
  image_model_evidence JSONB;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN
    RETURN NULL;
  END IF;

  FOR entry IN SELECT asset FROM jsonb_array_elements(value) AS assets(asset)
  LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN
      RETURN NULL;
    END IF;
    normalized_entry := entry;
    full_sources := entry->'sourceAssetEvidence';
    checker_sources := entry->'checkerEvidence'->'sourceAssets';

    IF jsonb_typeof(full_sources) IS DISTINCT FROM 'array'
      OR jsonb_array_length(full_sources) < 1
      OR jsonb_typeof(checker_sources) IS DISTINCT FROM 'array'
    THEN
      RETURN NULL;
    END IF;

    IF jsonb_array_length(checker_sources) = jsonb_array_length(full_sources) THEN
      IF checker_sources <> full_sources THEN
        RETURN NULL;
      END IF;
    ELSIF jsonb_array_length(checker_sources) = 1 THEN
      IF checker_sources <> jsonb_build_array(full_sources->0) THEN
        RETURN NULL;
      END IF;
      normalized_entry := jsonb_set(
        normalized_entry,
        '{sourceAssetEvidence}',
        checker_sources,
        FALSE
      );
    ELSE
      RETURN NULL;
    END IF;

    checker_model_evidence := normalized_entry->'checkerEvidence'->'checkerModelEvidence';
    IF (checker_model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
      AND auto_listing_ai_model_identity_compatible(
        checker_model_evidence->>'requestedTextModel',
        checker_model_evidence->>'gatewayReportedTextModel'
      )
    THEN
      normalized_entry := jsonb_set(
        normalized_entry,
        '{checkerEvidence,checkerModelEvidence,gatewayReportedTextModel}',
        checker_model_evidence->'requestedTextModel',
        FALSE
      );
    END IF;

    image_model_evidence := normalized_entry->'modelEvidence';
    IF (image_model_evidence->'gatewayReportedImageModelPresent' = 'true'::JSONB) IS TRUE
      AND auto_listing_ai_model_identity_compatible(
        image_model_evidence->>'requestedImageModel',
        image_model_evidence->>'gatewayReportedImageModel'
      )
    THEN
      normalized_entry := jsonb_set(
        normalized_entry,
        '{modelEvidence,gatewayReportedImageModel}',
        image_model_evidence->'requestedImageModel',
        FALSE
      );
    END IF;

    normalized_assets := normalized_assets || jsonb_build_array(normalized_entry);
  END LOOP;

  RETURN normalized_assets;
END;
$$;

ALTER TABLE ai_rich_content_results
  DROP CONSTRAINT IF EXISTS ai_rich_content_results_generating_closed_evidence_check;

ALTER TABLE ai_rich_content_results
  ADD CONSTRAINT ai_rich_content_results_generating_closed_evidence_check CHECK (
    status <> 'GENERATING' OR (
      request_evidence IS NOT NULL
      AND (jsonb_typeof(request_evidence) = 'object') IS TRUE
      AND (request_evidence ?& ARRAY['requestKey','schemaVersion']) IS TRUE
      AND ((request_evidence - 'requestKey' - 'schemaVersion') = '{}'::JSONB) IS TRUE
      AND (jsonb_typeof(request_evidence->'requestKey') = 'string') IS TRUE
      AND (request_evidence->>'requestKey' = 'auto-listing-rich-' || input_hash) IS TRUE
      AND (jsonb_typeof(request_evidence->'schemaVersion') = 'string') IS TRUE
      AND (request_evidence->>'schemaVersion' = 'AUTO_LISTING_RICH_CONTENT_V1') IS TRUE
      AND auto_listing_rich_fact_evidence_valid(source_fact_evidence) IS TRUE
      AND auto_listing_rich_asset_evidence_valid(
        auto_listing_rich_asset_evidence_for_validation(asset_evidence)
      ) IS TRUE
      AND auto_listing_rich_asset_evidence_matches(
        auto_listing_rich_asset_evidence_for_validation(asset_evidence),
        source_fact_evidence, account_id, job_id, item_id, plan_id,
        plan_hash, source_hash, profile_id, profile_version, model_name
      ) IS TRUE
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
      AND auto_listing_rich_asset_evidence_valid(
        auto_listing_rich_asset_evidence_for_validation(asset_evidence)
      ) IS TRUE
      AND auto_listing_rich_asset_evidence_matches(
        auto_listing_rich_asset_evidence_for_validation(asset_evidence),
        source_fact_evidence, account_id, job_id, item_id, plan_id,
        plan_hash, source_hash, profile_id, profile_version, model_name
      ) IS TRUE
      AND auto_listing_rich_content_valid(
        rich_content,
        source_fact_evidence,
        auto_listing_rich_asset_evidence_for_validation(asset_evidence)
      ) IS TRUE
      AND auto_listing_rich_checker_evidence_valid(
        checker_result,
        rich_content,
        source_fact_evidence,
        auto_listing_rich_asset_evidence_for_validation(asset_evidence)
      ) IS TRUE
    )
  ) NOT VALID;
