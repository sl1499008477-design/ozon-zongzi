-- Migration 087 rebuilt this constraint for deterministic fallback support but
-- accidentally bypassed the closed validation projection introduced by 082/083.
-- Keep the original evidence immutable and validate only its canonical projection.

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
