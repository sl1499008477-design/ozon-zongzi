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
  canonical_claims JSONB;
  fact_id_entry RECORD;
  bound_fact_id TEXT;
  source_fact JSONB;
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

    IF jsonb_typeof(normalized_entry->'checkerEvidence'->'sourceFactIds') IS DISTINCT FROM 'array'
      OR jsonb_typeof(normalized_entry->'checkerEvidence'->'sourceFacts') IS DISTINCT FROM 'array'
    THEN
      RETURN NULL;
    END IF;
    canonical_claims := '[]'::JSONB;
    FOR fact_id_entry IN
      SELECT fact_id, ordinal
      FROM jsonb_array_elements(normalized_entry->'checkerEvidence'->'sourceFactIds')
        WITH ORDINALITY AS bound_ids(fact_id, ordinal)
      ORDER BY ordinal
    LOOP
      IF jsonb_typeof(fact_id_entry.fact_id) IS DISTINCT FROM 'string' THEN
        RETURN NULL;
      END IF;
      bound_fact_id := fact_id_entry.fact_id #>> '{}';
      SELECT fact INTO source_fact
      FROM jsonb_array_elements(normalized_entry->'checkerEvidence'->'sourceFacts') AS facts(fact)
      WHERE fact->>'factId' = bound_fact_id
      LIMIT 1;
      IF source_fact IS NULL
        OR jsonb_typeof(source_fact->'field') IS DISTINCT FROM 'string'
        OR jsonb_typeof(source_fact->'value') IS DISTINCT FROM 'string'
        OR jsonb_typeof(source_fact->'numericValue') NOT IN ('number','null')
        OR jsonb_typeof(source_fact->'unit') NOT IN ('string','null')
      THEN
        RETURN NULL;
      END IF;
      canonical_claims := canonical_claims || jsonb_build_array(jsonb_build_object(
        'text', source_fact->>'value',
        'sourceFactId', source_fact->'factId',
        'field', source_fact->'field',
        'value', source_fact->'value',
        'numericValue', source_fact->'numericValue',
        'unit', source_fact->'unit'
      ));
    END LOOP;

    normalized_entry := jsonb_set(
      normalized_entry,
      '{checkerEvidence,checkerResult,evidence,claims}',
      canonical_claims,
      FALSE
    );
    normalized_entry := jsonb_set(
      normalized_entry,
      '{checkerEvidence,checkerResult,claimsVerified}',
      'true'::JSONB,
      FALSE
    );
    normalized_assets := normalized_assets || jsonb_build_array(normalized_entry);
  END LOOP;

  RETURN normalized_assets;
END;
$$;
