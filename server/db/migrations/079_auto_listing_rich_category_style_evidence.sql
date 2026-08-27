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
  model_evidence JSONB;
  checker_result JSONB;
  evidence JSONB;
  source_fact_id JSONB;
  claim JSONB;
  detected_text JSONB;
  distinct_count INTEGER;
  has_category_style BOOLEAN;
  style_guidance JSONB;
  style_assets JSONB;
  style_evidence JSONB;
  entry JSONB;
  prohibited_pattern JSONB;
  style_id_count INTEGER;
  style_sku_count INTEGER;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;

  has_category_style := value ?& ARRAY['categoryStyleGuidance','categoryStyleAssets'];
  IF (value ? 'categoryStyleGuidance') <> (value ? 'categoryStyleAssets') THEN
    RETURN FALSE;
  END IF;

  IF has_category_style THEN
    style_guidance := value->'categoryStyleGuidance';
    style_assets := value->'categoryStyleAssets';
    checker_result := value->'checkerResult';
    evidence := checker_result->'evidence';
    style_evidence := evidence->'categoryStyle';

    IF NOT (value ?& ARRAY[
        'checkerResult','textRequired','sourceFactIds','sourceFacts','sourceAssets','generatedHash',
        'checkerModel','checkerModelEvidence','profileId','profileAccountId','profileVersion',
        'templateVersion','requestId','categoryStyleGuidance','categoryStyleAssets'
      ])
      OR (value - 'checkerResult' - 'textRequired' - 'sourceFactIds' - 'sourceFacts' - 'sourceAssets'
        - 'generatedHash' - 'checkerModel' - 'checkerModelEvidence' - 'profileId' - 'profileAccountId'
        - 'profileVersion' - 'templateVersion' - 'requestId'
        - 'categoryStyleGuidance' - 'categoryStyleAssets') <> '{}'::JSONB
      OR jsonb_typeof(style_guidance) IS DISTINCT FROM 'object'
      OR NOT (style_guidance ?& ARRAY[
        'overallStyle','prohibitedPatterns','role','composition','background','textDensity','layout'
      ])
      OR (style_guidance - 'overallStyle' - 'prohibitedPatterns' - 'role' - 'composition'
        - 'background' - 'textDensity' - 'layout') <> '{}'::JSONB
      OR jsonb_typeof(style_guidance->'overallStyle') <> 'string'
      OR NULLIF(BTRIM(style_guidance->>'overallStyle'), '') IS NULL
      OR BTRIM(style_guidance->>'overallStyle') <> style_guidance->>'overallStyle'
      OR OCTET_LENGTH(style_guidance->>'overallStyle') > 1000
      OR jsonb_typeof(style_guidance->'role') <> 'string'
      OR NULLIF(BTRIM(style_guidance->>'role'), '') IS NULL
      OR BTRIM(style_guidance->>'role') <> style_guidance->>'role'
      OR OCTET_LENGTH(style_guidance->>'role') > 1000
      OR jsonb_typeof(style_guidance->'composition') <> 'string'
      OR NULLIF(BTRIM(style_guidance->>'composition'), '') IS NULL
      OR BTRIM(style_guidance->>'composition') <> style_guidance->>'composition'
      OR OCTET_LENGTH(style_guidance->>'composition') > 1000
      OR jsonb_typeof(style_guidance->'background') <> 'string'
      OR NULLIF(BTRIM(style_guidance->>'background'), '') IS NULL
      OR BTRIM(style_guidance->>'background') <> style_guidance->>'background'
      OR OCTET_LENGTH(style_guidance->>'background') > 1000
      OR jsonb_typeof(style_guidance->'textDensity') <> 'string'
      OR NULLIF(BTRIM(style_guidance->>'textDensity'), '') IS NULL
      OR BTRIM(style_guidance->>'textDensity') <> style_guidance->>'textDensity'
      OR OCTET_LENGTH(style_guidance->>'textDensity') > 1000
      OR jsonb_typeof(style_guidance->'layout') <> 'string'
      OR NULLIF(BTRIM(style_guidance->>'layout'), '') IS NULL
      OR BTRIM(style_guidance->>'layout') <> style_guidance->>'layout'
      OR OCTET_LENGTH(style_guidance->>'layout') > 1000
      OR jsonb_typeof(style_guidance->'prohibitedPatterns') <> 'array'
      OR (CASE WHEN jsonb_typeof(style_guidance->'prohibitedPatterns') = 'array'
        THEN jsonb_array_length(style_guidance->'prohibitedPatterns') > 20 ELSE TRUE END)
      OR jsonb_typeof(style_assets) <> 'array'
      OR (CASE WHEN jsonb_typeof(style_assets) = 'array'
        THEN jsonb_array_length(style_assets) NOT BETWEEN 1 AND 3 ELSE TRUE END)
      OR jsonb_typeof(checker_result) IS DISTINCT FROM 'object'
      OR NOT (checker_result ?& ARRAY[
        'matchesProduct','matchesCategoryStyle','claimsVerified','russianText','quality',
        'prohibitedContent','reasons','evidence'
      ])
      OR (checker_result - 'matchesProduct' - 'matchesCategoryStyle' - 'claimsVerified'
        - 'russianText' - 'quality' - 'prohibitedContent' - 'reasons' - 'evidence') <> '{}'::JSONB
      OR (checker_result->'matchesCategoryStyle' = 'true'::JSONB) IS NOT TRUE
      OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
      OR NOT (evidence ?& ARRAY[
        'identity','categoryStyle','claims','detectedTexts','language','qualityFlags','prohibitedFlags'
      ])
      OR (evidence - 'identity' - 'categoryStyle' - 'claims' - 'detectedTexts'
        - 'language' - 'qualityFlags' - 'prohibitedFlags') <> '{}'::JSONB
      OR jsonb_typeof(style_evidence) IS DISTINCT FROM 'object'
      OR NOT (style_evidence ?& ARRAY['matches','referenceEvidenceIds'])
      OR (style_evidence - 'matches' - 'referenceEvidenceIds') <> '{}'::JSONB
      OR jsonb_typeof(style_evidence->'matches') <> 'boolean'
      OR style_evidence->'matches' <> checker_result->'matchesCategoryStyle'
      OR jsonb_typeof(style_evidence->'referenceEvidenceIds') <> 'array'
      OR style_evidence->'referenceEvidenceIds' <> (
        SELECT COALESCE(jsonb_agg(style_entry->'evidenceId' ORDER BY ordinal), '[]'::JSONB)
        FROM jsonb_array_elements(style_assets) WITH ORDINALITY AS style_entries(style_entry, ordinal)
      )
    THEN
      RETURN FALSE;
    END IF;

    FOR prohibited_pattern IN
      SELECT pattern FROM jsonb_array_elements(style_guidance->'prohibitedPatterns') AS patterns(pattern)
    LOOP
      IF jsonb_typeof(prohibited_pattern) <> 'string'
        OR NULLIF(BTRIM(prohibited_pattern #>> '{}'), '') IS NULL
        OR BTRIM(prohibited_pattern #>> '{}') <> prohibited_pattern #>> '{}'
        OR OCTET_LENGTH(prohibited_pattern #>> '{}') > 1000
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    SELECT COUNT(DISTINCT pattern #>> '{}') INTO distinct_count
    FROM jsonb_array_elements(style_guidance->'prohibitedPatterns') AS patterns(pattern);
    IF distinct_count <> jsonb_array_length(style_guidance->'prohibitedPatterns') THEN
      RETURN FALSE;
    END IF;

    FOR entry IN SELECT asset FROM jsonb_array_elements(style_assets) AS assets(asset)
    LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
        OR NOT (entry ?& ARRAY['evidenceId','sku','contentHash','contentType','width','height','size'])
        OR (entry - 'evidenceId' - 'sku' - 'contentHash' - 'contentType'
          - 'width' - 'height' - 'size') <> '{}'::JSONB
        OR jsonb_typeof(entry->'evidenceId') <> 'string'
        OR NULLIF(BTRIM(entry->>'evidenceId'), '') IS NULL
        OR BTRIM(entry->>'evidenceId') <> entry->>'evidenceId'
        OR OCTET_LENGTH(entry->>'evidenceId') > 240
        OR jsonb_typeof(entry->'sku') <> 'string'
        OR NULLIF(BTRIM(entry->>'sku'), '') IS NULL
        OR BTRIM(entry->>'sku') <> entry->>'sku'
        OR OCTET_LENGTH(entry->>'sku') > 240
        OR jsonb_typeof(entry->'contentHash') <> 'string'
        OR (entry->>'contentHash') !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(entry->'contentType') <> 'string'
        OR entry->>'contentType' NOT IN ('image/png','image/jpeg','image/webp')
        OR jsonb_typeof(entry->'width') <> 'number'
        OR (entry->>'width') !~ '^[0-9]+$' OR (entry->>'width')::NUMERIC < 256
        OR jsonb_typeof(entry->'height') <> 'number'
        OR (entry->>'height') !~ '^[0-9]+$' OR (entry->>'height')::NUMERIC < 256
        OR jsonb_typeof(entry->'size') <> 'number'
        OR (entry->>'size') !~ '^[0-9]+$' OR (entry->>'size')::NUMERIC < 1
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    SELECT COUNT(DISTINCT style_entry->>'evidenceId'), COUNT(DISTINCT style_entry->>'sku')
    INTO style_id_count, style_sku_count
    FROM jsonb_array_elements(style_assets) AS style_entries(style_entry);
    IF style_id_count <> jsonb_array_length(style_assets)
      OR style_sku_count <> jsonb_array_length(style_assets)
    THEN
      RETURN FALSE;
    END IF;

    checker_result := (checker_result - 'matchesCategoryStyle')
      || jsonb_build_object('evidence', evidence - 'categoryStyle');
    value := (value - 'categoryStyleGuidance' - 'categoryStyleAssets')
      || jsonb_build_object('checkerResult', checker_result);
  END IF;

  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR NOT (value ?& ARRAY[
      'checkerResult','textRequired','sourceFactIds','sourceFacts','sourceAssets','generatedHash',
      'checkerModel','checkerModelEvidence','profileId','profileAccountId','profileVersion',
      'templateVersion','requestId'
    ])
    OR (value - 'checkerResult' - 'textRequired' - 'sourceFactIds' - 'sourceFacts' - 'sourceAssets'
      - 'generatedHash' - 'checkerModel' - 'checkerModelEvidence' - 'profileId' - 'profileAccountId'
      - 'profileVersion' - 'templateVersion' - 'requestId') <> '{}'::JSONB
    OR jsonb_typeof(value->'textRequired') <> 'boolean'
    OR jsonb_typeof(value->'sourceFactIds') <> 'array'
    OR jsonb_array_length(value->'sourceFactIds') > 256
    OR jsonb_typeof(value->'sourceFacts') <> 'array'
    OR NOT auto_listing_rich_fact_evidence_valid(value->'sourceFacts')
    OR jsonb_typeof(value->'sourceAssets') <> 'array'
    OR value->'sourceAssets' <> source_asset_evidence
    OR NOT auto_listing_rich_source_asset_evidence_valid(value->'sourceAssets')
    OR jsonb_typeof(value->'generatedHash') <> 'string' OR value->>'generatedHash' <> content_hash
    OR jsonb_typeof(value->'checkerModel') <> 'string' OR value->>'checkerModel' <> checker_model
    OR OCTET_LENGTH(value->>'checkerModel') > 240
    OR jsonb_typeof(value->'profileId') <> 'string' OR value->>'profileId' <> profile_id
    OR OCTET_LENGTH(value->>'profileId') > 240
    OR jsonb_typeof(value->'profileAccountId') <> 'string' OR value->>'profileAccountId' <> profile_account_id
    OR OCTET_LENGTH(value->>'profileAccountId') > 240
    OR jsonb_typeof(value->'profileVersion') <> 'number' OR (value->>'profileVersion') !~ '^[0-9]+$'
    OR (value->>'profileVersion')::NUMERIC <> profile_version
    OR jsonb_typeof(value->'templateVersion') <> 'string' OR value->>'templateVersion' <> template_version
    OR OCTET_LENGTH(value->>'templateVersion') > 240
    OR jsonb_typeof(value->'requestId') <> 'string' OR value->>'requestId' <> checker_request_id
    OR OCTET_LENGTH(value->>'requestId') > 240
  THEN
    RETURN FALSE;
  END IF;

  FOR source_fact_id IN
    SELECT fact_id FROM jsonb_array_elements(value->'sourceFactIds') AS fact_ids(fact_id)
  LOOP
    IF jsonb_typeof(source_fact_id) <> 'string'
      OR NULLIF(BTRIM(source_fact_id #>> '{}'), '') IS NULL
      OR BTRIM(source_fact_id #>> '{}') <> source_fact_id #>> '{}'
      OR OCTET_LENGTH(source_fact_id #>> '{}') > 240
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  SELECT COUNT(DISTINCT fact_id #>> '{}') INTO distinct_count
  FROM jsonb_array_elements(value->'sourceFactIds') AS fact_ids(fact_id);
  IF distinct_count <> jsonb_array_length(value->'sourceFactIds') THEN
    RETURN FALSE;
  END IF;

  model_evidence := value->'checkerModelEvidence';
  IF jsonb_typeof(model_evidence) IS DISTINCT FROM 'object'
    OR NOT (model_evidence ?& ARRAY['requestedTextModel','gatewayReportedTextModel','gatewayReportedTextModelPresent'])
    OR (model_evidence - 'requestedTextModel' - 'gatewayReportedTextModel' - 'gatewayReportedTextModelPresent') <> '{}'::JSONB
    OR jsonb_typeof(model_evidence->'requestedTextModel') <> 'string'
    OR model_evidence->>'requestedTextModel' <> checker_model
    OR jsonb_typeof(model_evidence->'gatewayReportedTextModelPresent') <> 'boolean'
    OR NOT (
      ((model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
        AND jsonb_typeof(model_evidence->'gatewayReportedTextModel') = 'string'
        AND model_evidence->>'gatewayReportedTextModel' = checker_model)
      OR
      ((model_evidence->'gatewayReportedTextModelPresent' = 'false'::JSONB) IS TRUE
        AND jsonb_typeof(model_evidence->'gatewayReportedTextModel') = 'string'
        AND model_evidence->>'gatewayReportedTextModel' = '')
    )
  THEN
    RETURN FALSE;
  END IF;

  checker_result := value->'checkerResult';
  evidence := checker_result->'evidence';
  IF jsonb_typeof(checker_result) IS DISTINCT FROM 'object'
    OR NOT (checker_result ?& ARRAY['matchesProduct','claimsVerified','russianText','quality','prohibitedContent','reasons','evidence'])
    OR (checker_result - 'matchesProduct' - 'claimsVerified' - 'russianText' - 'quality' - 'prohibitedContent' - 'reasons' - 'evidence') <> '{}'::JSONB
    OR (checker_result->'matchesProduct' = 'true'::JSONB) IS NOT TRUE
    OR (checker_result->'claimsVerified' = 'true'::JSONB) IS NOT TRUE
    OR jsonb_typeof(checker_result->'russianText') <> 'boolean'
    OR jsonb_typeof(checker_result->'quality') <> 'string'
    OR checker_result->>'quality' <> 'PASS'
    OR (checker_result->'prohibitedContent' = 'false'::JSONB) IS NOT TRUE
    OR jsonb_typeof(checker_result->'reasons') <> 'array'
    OR (CASE WHEN jsonb_typeof(checker_result->'reasons') = 'array'
      THEN jsonb_array_length(checker_result->'reasons') > 32 ELSE TRUE END)
    OR checker_result->'reasons' <> '[]'::JSONB
    OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    OR NOT (evidence ?& ARRAY['identity','claims','detectedTexts','language','qualityFlags','prohibitedFlags'])
    OR (evidence - 'identity' - 'claims' - 'detectedTexts' - 'language' - 'qualityFlags' - 'prohibitedFlags') <> '{}'::JSONB
    OR jsonb_typeof(evidence->'claims') <> 'array'
    OR (CASE WHEN jsonb_typeof(evidence->'claims') = 'array'
      THEN jsonb_array_length(evidence->'claims') > 256 ELSE TRUE END)
    OR jsonb_typeof(evidence->'detectedTexts') <> 'array'
    OR (CASE WHEN jsonb_typeof(evidence->'detectedTexts') = 'array'
      THEN jsonb_array_length(evidence->'detectedTexts') > 64 ELSE TRUE END)
    OR jsonb_typeof(evidence->'language') <> 'string'
    OR evidence->>'language' NOT IN ('ru','other')
    OR jsonb_typeof(evidence->'qualityFlags') <> 'array'
    OR (CASE WHEN jsonb_typeof(evidence->'qualityFlags') = 'array'
      THEN jsonb_array_length(evidence->'qualityFlags') > 4 ELSE TRUE END)
    OR evidence->'qualityFlags' <> '[]'::JSONB
    OR jsonb_typeof(evidence->'prohibitedFlags') <> 'array'
    OR (CASE WHEN jsonb_typeof(evidence->'prohibitedFlags') = 'array'
      THEN jsonb_array_length(evidence->'prohibitedFlags') > 8 ELSE TRUE END)
    OR evidence->'prohibitedFlags' <> '[]'::JSONB
    OR jsonb_typeof(evidence->'identity') IS DISTINCT FROM 'object'
    OR NOT ((evidence->'identity') ?& ARRAY['color','shape','accessoryCount','sourceAssetIds'])
    OR ((evidence->'identity') - 'color' - 'shape' - 'accessoryCount' - 'sourceAssetIds') <> '{}'::JSONB
    OR (evidence->'identity'->'color' = 'true'::JSONB) IS NOT TRUE
    OR (evidence->'identity'->'shape' = 'true'::JSONB) IS NOT TRUE
    OR (evidence->'identity'->'accessoryCount' = 'true'::JSONB) IS NOT TRUE
    OR jsonb_typeof(evidence->'identity'->'sourceAssetIds') <> 'array'
    OR (CASE WHEN jsonb_typeof(evidence->'identity'->'sourceAssetIds') = 'array'
      THEN jsonb_array_length(evidence->'identity'->'sourceAssetIds') NOT BETWEEN 1 AND 7 ELSE TRUE END)
    OR evidence->'identity'->'sourceAssetIds' <> (
      SELECT COALESCE(jsonb_agg(source_entry->'assetId' ORDER BY ordinal), '[]'::JSONB)
      FROM jsonb_array_elements(source_asset_evidence) WITH ORDINALITY AS sources(source_entry, ordinal)
    )
  THEN
    RETURN FALSE;
  END IF;

  FOR claim IN SELECT claim_value FROM jsonb_array_elements(evidence->'claims') AS claims(claim_value)
  LOOP
    IF jsonb_typeof(claim) IS DISTINCT FROM 'object'
      OR NOT (claim ?& ARRAY['text','sourceFactId','field','value','numericValue','unit'])
      OR (claim - 'text' - 'sourceFactId' - 'field' - 'value' - 'numericValue' - 'unit') <> '{}'::JSONB
      OR jsonb_typeof(claim->'text') <> 'string' OR NULLIF(BTRIM(claim->>'text'), '') IS NULL
      OR BTRIM(claim->>'text') <> claim->>'text' OR OCTET_LENGTH(claim->>'text') > 2048
      OR jsonb_typeof(claim->'sourceFactId') <> 'string' OR NULLIF(BTRIM(claim->>'sourceFactId'), '') IS NULL
      OR BTRIM(claim->>'sourceFactId') <> claim->>'sourceFactId' OR OCTET_LENGTH(claim->>'sourceFactId') > 240
      OR jsonb_typeof(claim->'field') <> 'string' OR NULLIF(BTRIM(claim->>'field'), '') IS NULL
      OR BTRIM(claim->>'field') <> claim->>'field' OR OCTET_LENGTH(claim->>'field') > 512
      OR jsonb_typeof(claim->'value') <> 'string' OR NULLIF(BTRIM(claim->>'value'), '') IS NULL
      OR BTRIM(claim->>'value') <> claim->>'value' OR OCTET_LENGTH(claim->>'value') > 2048
      OR jsonb_typeof(claim->'numericValue') NOT IN ('number','null')
      OR jsonb_typeof(claim->'unit') NOT IN ('string','null')
      OR (jsonb_typeof(claim->'numericValue') = 'null' AND jsonb_typeof(claim->'unit') <> 'null')
      OR (jsonb_typeof(claim->'unit') = 'string' AND (NULLIF(BTRIM(claim->>'unit'), '') IS NULL
        OR BTRIM(claim->>'unit') <> claim->>'unit' OR OCTET_LENGTH(claim->>'unit') > 64))
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value->'sourceFacts') AS facts(fact)
        WHERE fact->>'factId' = claim->>'sourceFactId'
          AND fact->'field' = claim->'field'
          AND fact->'value' = claim->'value'
          AND fact->'numericValue' = claim->'numericValue'
          AND fact->'unit' = claim->'unit'
      )
      OR (
        jsonb_typeof(claim->'numericValue') = 'null'
        AND POSITION(
          LOWER(REGEXP_REPLACE(BTRIM(claim->>'value'), '[[:space:]]+', ' ', 'g'))
          IN LOWER(REGEXP_REPLACE(BTRIM(claim->>'text'), '[[:space:]]+', ' ', 'g'))
        ) = 0
      )
      OR auto_listing_rich_text_matches_bindings(claim->>'text', jsonb_build_array(claim - 'text')) IS NOT TRUE
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  FOR detected_text IN
    SELECT text_value FROM jsonb_array_elements(evidence->'detectedTexts') AS detected(text_value)
  LOOP
    IF jsonb_typeof(detected_text) <> 'string'
      OR NULLIF(BTRIM(detected_text #>> '{}'), '') IS NULL
      OR BTRIM(detected_text #>> '{}') <> detected_text #>> '{}'
      OR OCTET_LENGTH(detected_text #>> '{}') > 2048
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  SELECT COUNT(DISTINCT text_value #>> '{}') INTO distinct_count
  FROM jsonb_array_elements(evidence->'detectedTexts') AS detected(text_value);
  IF distinct_count <> jsonb_array_length(evidence->'detectedTexts')
    OR value->'sourceFactIds' <> (
      SELECT COALESCE(jsonb_agg(derived_source_fact_id ORDER BY first_ordinal), '[]'::JSONB)
      FROM (
        SELECT claim_value->'sourceFactId' AS derived_source_fact_id, MIN(ordinal) AS first_ordinal
        FROM jsonb_array_elements(evidence->'claims') WITH ORDINALITY AS claims(claim_value, ordinal)
        GROUP BY claim_value->'sourceFactId'
      ) AS derived_fact_ids
    )
    OR (jsonb_array_length(evidence->'detectedTexts') > 0 AND (
      (checker_result->'russianText' = 'true'::JSONB) IS NOT TRUE OR evidence->>'language' <> 'ru'
    ))
    OR ((value->'textRequired' = 'true'::JSONB) IS TRUE AND (
      jsonb_array_length(evidence->'detectedTexts') = 0
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(evidence->'detectedTexts') AS detected(text_value)
        WHERE text_value ~ '[А-Яа-яЁё]'
      )
    ))
  THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;
