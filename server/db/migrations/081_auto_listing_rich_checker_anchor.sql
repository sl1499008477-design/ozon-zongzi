CREATE OR REPLACE FUNCTION auto_listing_rich_asset_checker_evidence_valid(
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
  checker_source_asset_evidence JSONB := source_asset_evidence;
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

  -- Image generation may use one additional role reference, while the checker
  -- deliberately sees only the first product anchor. Accept exactly the same
  -- two shapes used by accepted-image replay: every source, or the first source.
  IF jsonb_typeof(source_asset_evidence) = 'array'
    AND jsonb_array_length(source_asset_evidence) > 0
    AND jsonb_typeof(value->'sourceAssets') = 'array'
  THEN
    IF jsonb_array_length(value->'sourceAssets') = jsonb_array_length(source_asset_evidence) THEN
      checker_source_asset_evidence := source_asset_evidence;
    ELSE
      checker_source_asset_evidence := jsonb_build_array(source_asset_evidence->0);
    END IF;
  END IF;

  RETURN auto_listing_rich_asset_checker_evidence_valid_v079(
    normalized_value,
    checker_source_asset_evidence,
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
