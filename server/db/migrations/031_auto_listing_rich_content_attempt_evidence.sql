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

CREATE OR REPLACE FUNCTION auto_listing_rich_fact_evidence_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry JSONB;
  distinct_count INTEGER;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(value) NOT BETWEEN 1 AND 256 THEN
    RETURN FALSE;
  END IF;
  FOR entry IN SELECT fact_entry FROM jsonb_array_elements(value) AS facts(fact_entry)
  LOOP
    IF jsonb_typeof(entry) <> 'object'
      OR NOT (entry ?& ARRAY['factId','field','kind','value','numericValue','unit','sourcePath'])
      OR (entry - 'factId' - 'field' - 'kind' - 'value' - 'numericValue' - 'unit' - 'sourcePath') <> '{}'::JSONB
      OR jsonb_typeof(entry->'factId') <> 'string' OR NULLIF(BTRIM(entry->>'factId'), '') IS NULL
      OR jsonb_typeof(entry->'field') <> 'string' OR NULLIF(BTRIM(entry->>'field'), '') IS NULL
      OR jsonb_typeof(entry->'kind') <> 'string' OR NULLIF(BTRIM(entry->>'kind'), '') IS NULL
      OR jsonb_typeof(entry->'value') <> 'string' OR NULLIF(BTRIM(entry->>'value'), '') IS NULL
      OR jsonb_typeof(entry->'numericValue') NOT IN ('number', 'null')
      OR jsonb_typeof(entry->'unit') NOT IN ('string', 'null')
      OR (jsonb_typeof(entry->'numericValue') = 'null' AND jsonb_typeof(entry->'unit') <> 'null')
      OR (jsonb_typeof(entry->'unit') = 'string' AND NULLIF(BTRIM(entry->>'unit'), '') IS NULL)
      OR jsonb_typeof(entry->'sourcePath') <> 'string' OR NULLIF(BTRIM(entry->>'sourcePath'), '') IS NULL
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  SELECT COUNT(DISTINCT fact_row->>'factId')
  INTO distinct_count
  FROM jsonb_array_elements(value) AS facts(fact_row);
  RETURN distinct_count = jsonb_array_length(value);
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_source_asset_evidence_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry JSONB;
  distinct_count INTEGER;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(value) NOT BETWEEN 1 AND 7 THEN
    RETURN FALSE;
  END IF;
  FOR entry IN SELECT source_entry FROM jsonb_array_elements(value) AS sources(source_entry)
  LOOP
    IF jsonb_typeof(entry) <> 'object'
      OR NOT (entry ?& ARRAY['assetId','contentHash','contentType','width','height','size'])
      OR (entry - 'assetId' - 'contentHash' - 'contentType' - 'width' - 'height' - 'size') <> '{}'::JSONB
      OR jsonb_typeof(entry->'assetId') <> 'string' OR NULLIF(BTRIM(entry->>'assetId'), '') IS NULL
      OR jsonb_typeof(entry->'contentHash') <> 'string' OR COALESCE(entry->>'contentHash', '') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(entry->'contentType') <> 'string' OR entry->>'contentType' <> 'image/png'
      OR jsonb_typeof(entry->'width') <> 'number' OR (entry->>'width') !~ '^[0-9]+$' OR (entry->>'width')::NUMERIC < 1
      OR jsonb_typeof(entry->'height') <> 'number' OR (entry->>'height') !~ '^[0-9]+$' OR (entry->>'height')::NUMERIC < 1
      OR jsonb_typeof(entry->'size') <> 'number' OR (entry->>'size') !~ '^[0-9]+$' OR (entry->>'size')::NUMERIC < 1
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  SELECT COUNT(DISTINCT source_row->>'assetId') INTO distinct_count
  FROM jsonb_array_elements(value) AS sources(source_row);
  RETURN distinct_count = jsonb_array_length(value);
END;
$$;

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
BEGIN
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
    OR jsonb_typeof(value->'sourceFacts') <> 'array'
    OR NOT auto_listing_rich_fact_evidence_valid(value->'sourceFacts')
    OR jsonb_typeof(value->'sourceAssets') <> 'array'
    OR value->'sourceAssets' <> source_asset_evidence
    OR NOT auto_listing_rich_source_asset_evidence_valid(value->'sourceAssets')
    OR jsonb_typeof(value->'generatedHash') <> 'string' OR value->>'generatedHash' <> content_hash
    OR jsonb_typeof(value->'checkerModel') <> 'string' OR value->>'checkerModel' <> checker_model
    OR jsonb_typeof(value->'profileId') <> 'string' OR value->>'profileId' <> profile_id
    OR jsonb_typeof(value->'profileAccountId') <> 'string' OR value->>'profileAccountId' <> profile_account_id
    OR jsonb_typeof(value->'profileVersion') <> 'number' OR (value->>'profileVersion') !~ '^[0-9]+$'
    OR (value->>'profileVersion')::NUMERIC <> profile_version
    OR jsonb_typeof(value->'templateVersion') <> 'string' OR value->>'templateVersion' <> template_version
    OR jsonb_typeof(value->'requestId') <> 'string' OR value->>'requestId' <> checker_request_id
  THEN
    RETURN FALSE;
  END IF;

  model_evidence := value->'checkerModelEvidence';
  IF jsonb_typeof(model_evidence) IS DISTINCT FROM 'object'
    OR NOT (model_evidence ?& ARRAY['requestedTextModel','gatewayReportedTextModel','gatewayReportedTextModelPresent'])
    OR (model_evidence - 'requestedTextModel' - 'gatewayReportedTextModel' - 'gatewayReportedTextModelPresent') <> '{}'::JSONB
    OR jsonb_typeof(model_evidence->'requestedTextModel') <> 'string'
    OR model_evidence->>'requestedTextModel' <> checker_model
    OR jsonb_typeof(model_evidence->'gatewayReportedTextModel') <> 'string'
    OR model_evidence->>'gatewayReportedTextModel' <> checker_model
    OR jsonb_typeof(model_evidence->'gatewayReportedTextModelPresent') <> 'boolean'
    OR (model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS NOT TRUE
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
    OR checker_result->'reasons' <> '[]'::JSONB
    OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    OR NOT (evidence ?& ARRAY['identity','claims','detectedTexts','language','qualityFlags','prohibitedFlags'])
    OR (evidence - 'identity' - 'claims' - 'detectedTexts' - 'language' - 'qualityFlags' - 'prohibitedFlags') <> '{}'::JSONB
    OR jsonb_typeof(evidence->'claims') <> 'array'
    OR jsonb_typeof(evidence->'detectedTexts') <> 'array'
    OR jsonb_typeof(evidence->'language') <> 'string'
    OR evidence->>'language' NOT IN ('ru','other')
    OR evidence->'qualityFlags' <> '[]'::JSONB
    OR evidence->'prohibitedFlags' <> '[]'::JSONB
    OR jsonb_typeof(evidence->'identity') IS DISTINCT FROM 'object'
    OR NOT ((evidence->'identity') ?& ARRAY['color','shape','accessoryCount','sourceAssetIds'])
    OR ((evidence->'identity') - 'color' - 'shape' - 'accessoryCount' - 'sourceAssetIds') <> '{}'::JSONB
    OR (evidence->'identity'->'color' = 'true'::JSONB) IS NOT TRUE
    OR (evidence->'identity'->'shape' = 'true'::JSONB) IS NOT TRUE
    OR (evidence->'identity'->'accessoryCount' = 'true'::JSONB) IS NOT TRUE
    OR evidence->'identity'->'sourceAssetIds' <> (
      SELECT COALESCE(jsonb_agg(source_entry->'assetId' ORDER BY ordinal), '[]'::JSONB)
      FROM jsonb_array_elements(source_asset_evidence) WITH ORDINALITY AS sources(source_entry, ordinal)
    )
  THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_legacy_object_key_complete(
  account_id TEXT,
  job_id TEXT,
  item_id TEXT,
  plan_id TEXT,
  visual_group_key TEXT,
  slot_key TEXT,
  input_hash TEXT,
  content_hash TEXT,
  object_key TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT account_id IS NOT NULL AND BTRIM(account_id) = account_id AND account_id <> ''
    AND job_id IS NOT NULL AND BTRIM(job_id) = job_id AND job_id <> ''
    AND item_id IS NOT NULL AND BTRIM(item_id) = item_id AND item_id <> ''
    AND plan_id IS NOT NULL AND BTRIM(plan_id) = plan_id AND plan_id <> ''
    AND visual_group_key IS NOT NULL AND BTRIM(visual_group_key) = visual_group_key AND visual_group_key <> ''
    AND slot_key IS NOT NULL AND BTRIM(slot_key) = slot_key AND slot_key <> ''
    AND input_hash ~ '^[a-f0-9]{64}$'
    AND content_hash ~ '^[a-f0-9]{64}$'
    AND object_key = 'auto-listing/'
      || auto_listing_object_key_segment(account_id) || '/'
      || auto_listing_object_key_segment(job_id) || '/'
      || auto_listing_object_key_segment(item_id) || '/'
      || auto_listing_object_key_segment(plan_id) || '/'
      || auto_listing_object_key_segment(visual_group_key) || '/'
      || auto_listing_object_key_segment(slot_key) || '/'
      || input_hash || '/' || content_hash || '.png'
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry JSONB;
  model_evidence JSONB;
  distinct_count INTEGER;
  slot_count INTEGER;
  main_count INTEGER;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(value) NOT BETWEEN 6 AND 20 THEN
    RETURN FALSE;
  END IF;
  FOR entry IN SELECT asset_entry FROM jsonb_array_elements(value) AS assets(asset_entry)
  LOOP
    IF jsonb_typeof(entry) <> 'object'
      OR NOT (entry ?& ARRAY[
        'assetId','status','accountId','jobId','itemId','planId','visualGroupKey','slotKey','role',
        'attemptIdentityHash','attemptNo','inputHash','generationSize','contentHash','objectKeyVersion','objectKey',
        'contentType','width','height','size','gatewayRequestId','checkerRequestId','modelEvidence',
        'profileId','profileVersion','modelName','planHash','sourceHash','strategyHash','configHash',
        'visualGroupsHash','promptTemplateVersion','promptHash','checkerEvidence','sourceAssetEvidence','regeneration'
      ])
      OR (entry - 'assetId' - 'status' - 'accountId' - 'jobId' - 'itemId' - 'planId'
        - 'visualGroupKey' - 'slotKey' - 'role' - 'attemptIdentityHash' - 'attemptNo' - 'inputHash'
        - 'generationSize' - 'contentHash' - 'objectKeyVersion' - 'objectKey' - 'contentType'
        - 'width' - 'height' - 'size' - 'gatewayRequestId' - 'checkerRequestId' - 'modelEvidence'
        - 'profileId' - 'profileVersion' - 'modelName' - 'planHash' - 'sourceHash' - 'strategyHash'
        - 'configHash' - 'visualGroupsHash' - 'promptTemplateVersion' - 'promptHash' - 'checkerEvidence'
        - 'sourceAssetEvidence' - 'regeneration') <> '{}'::JSONB
      OR jsonb_typeof(entry->'assetId') <> 'string' OR NULLIF(BTRIM(entry->>'assetId'), '') IS NULL
      OR jsonb_typeof(entry->'status') <> 'string' OR entry->>'status' <> 'ACCEPTED'
      OR jsonb_typeof(entry->'accountId') <> 'string' OR NULLIF(BTRIM(entry->>'accountId'), '') IS NULL
      OR jsonb_typeof(entry->'jobId') <> 'string' OR NULLIF(BTRIM(entry->>'jobId'), '') IS NULL
      OR jsonb_typeof(entry->'itemId') <> 'string' OR NULLIF(BTRIM(entry->>'itemId'), '') IS NULL
      OR jsonb_typeof(entry->'planId') <> 'string' OR NULLIF(BTRIM(entry->>'planId'), '') IS NULL
      OR jsonb_typeof(entry->'visualGroupKey') <> 'string' OR NULLIF(BTRIM(entry->>'visualGroupKey'), '') IS NULL
      OR jsonb_typeof(entry->'slotKey') <> 'string' OR NULLIF(BTRIM(entry->>'slotKey'), '') IS NULL
      OR jsonb_typeof(entry->'role') <> 'string'
      OR entry->>'role' NOT IN ('MAIN','SELLING_POINT','DETAIL','SCENE','SPECIFICATION','INFOGRAPHIC')
      OR COALESCE(entry->>'attemptIdentityHash', '') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(entry->'attemptNo') <> 'number' OR (entry->>'attemptNo') !~ '^[0-9]+$'
      OR (entry->>'attemptNo')::NUMERIC NOT BETWEEN 1 AND 3
      OR COALESCE(entry->>'inputHash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(entry->>'generationSize', '') !~ '^[0-9]+x[0-9]+$'
      OR COALESCE(entry->>'contentHash', '') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(entry->'objectKeyVersion') NOT IN ('string','null')
      OR jsonb_typeof(entry->'objectKey') <> 'string' OR NULLIF(BTRIM(entry->>'objectKey'), '') IS NULL
      OR jsonb_typeof(entry->'contentType') <> 'string' OR entry->>'contentType' <> 'image/png'
      OR jsonb_typeof(entry->'width') <> 'number' OR (entry->>'width') !~ '^[0-9]+$' OR (entry->>'width')::NUMERIC < 1
      OR jsonb_typeof(entry->'height') <> 'number' OR (entry->>'height') !~ '^[0-9]+$' OR (entry->>'height')::NUMERIC < 1
      OR jsonb_typeof(entry->'size') <> 'number' OR (entry->>'size') !~ '^[0-9]+$' OR (entry->>'size')::NUMERIC < 1
      OR jsonb_typeof(entry->'gatewayRequestId') <> 'string' OR NULLIF(BTRIM(entry->>'gatewayRequestId'), '') IS NULL
      OR jsonb_typeof(entry->'checkerRequestId') <> 'string' OR NULLIF(BTRIM(entry->>'checkerRequestId'), '') IS NULL
      OR jsonb_typeof(entry->'profileId') <> 'string' OR NULLIF(BTRIM(entry->>'profileId'), '') IS NULL
      OR jsonb_typeof(entry->'profileVersion') <> 'number' OR (entry->>'profileVersion') !~ '^[0-9]+$' OR (entry->>'profileVersion')::NUMERIC < 1
      OR jsonb_typeof(entry->'modelName') <> 'string' OR NULLIF(BTRIM(entry->>'modelName'), '') IS NULL
      OR COALESCE(entry->>'planHash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(entry->>'sourceHash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(entry->>'strategyHash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(entry->>'configHash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(entry->>'visualGroupsHash', '') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(entry->'promptTemplateVersion') <> 'string' OR NULLIF(BTRIM(entry->>'promptTemplateVersion'), '') IS NULL
      OR COALESCE(entry->>'promptHash', '') !~ '^[a-f0-9]{64}$'
      OR NOT auto_listing_rich_source_asset_evidence_valid(entry->'sourceAssetEvidence')
      OR NOT (jsonb_typeof(entry->'regeneration') = 'null' OR (
        jsonb_typeof(entry->'regeneration') = 'object'
        AND entry->'regeneration' ?& ARRAY['requestId','reason']
        AND (entry->'regeneration' - 'requestId' - 'reason') = '{}'::JSONB
        AND jsonb_typeof(entry->'regeneration'->'requestId') = 'string'
        AND NULLIF(BTRIM(entry->'regeneration'->>'requestId'), '') IS NOT NULL
        AND jsonb_typeof(entry->'regeneration'->'reason') = 'string'
        AND NULLIF(BTRIM(entry->'regeneration'->>'reason'), '') IS NOT NULL
      ))
    THEN
      RETURN FALSE;
    END IF;

    IF NOT (
      (jsonb_typeof(entry->'objectKeyVersion') = 'string'
        AND entry->>'objectKeyVersion' = 'ATTEMPT_V2'
        AND auto_listing_generation_object_key_v2_complete(
          entry->>'accountId', entry->>'jobId', entry->>'itemId', entry->>'planId',
          entry->>'visualGroupKey', entry->>'slotKey', entry->>'attemptIdentityHash',
          (entry->>'attemptNo')::INTEGER, entry->>'inputHash', entry->>'contentHash', entry->>'objectKey'
        ) IS TRUE)
      OR
      (jsonb_typeof(entry->'objectKeyVersion') = 'null'
        AND auto_listing_rich_legacy_object_key_complete(
          entry->>'accountId', entry->>'jobId', entry->>'itemId', entry->>'planId',
          entry->>'visualGroupKey', entry->>'slotKey', entry->>'inputHash', entry->>'contentHash', entry->>'objectKey'
        ) IS TRUE)
    ) THEN
      RETURN FALSE;
    END IF;

    model_evidence := entry->'modelEvidence';
    IF jsonb_typeof(model_evidence) IS DISTINCT FROM 'object'
      OR NOT (model_evidence ?& ARRAY['requestedImageModel','gatewayReportedImageModel','gatewayReportedImageModelPresent','orchestratorModel'])
      OR (model_evidence - 'requestedImageModel' - 'gatewayReportedImageModel' - 'gatewayReportedImageModelPresent' - 'orchestratorModel') <> '{}'::JSONB
      OR jsonb_typeof(model_evidence->'requestedImageModel') <> 'string'
      OR model_evidence->>'requestedImageModel' <> entry->>'modelName'
      OR jsonb_typeof(model_evidence->'gatewayReportedImageModel') <> 'string'
      OR model_evidence->>'gatewayReportedImageModel' <> entry->>'modelName'
      OR jsonb_typeof(model_evidence->'gatewayReportedImageModelPresent') <> 'boolean'
      OR (model_evidence->'gatewayReportedImageModelPresent' = 'true'::JSONB) IS NOT TRUE
      OR jsonb_typeof(model_evidence->'orchestratorModel') <> 'string'
      OR NOT auto_listing_rich_asset_checker_evidence_valid(
        entry->'checkerEvidence', entry->'sourceAssetEvidence', entry->>'contentHash',
        entry->>'checkerRequestId', entry->'checkerEvidence'->>'checkerModel', entry->>'profileId',
        entry->>'accountId', (entry->>'profileVersion')::INTEGER, entry->>'promptTemplateVersion'
      )
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  SELECT COUNT(DISTINCT asset_row->>'assetId'),
         COUNT(DISTINCT (asset_row->>'visualGroupKey', asset_row->>'slotKey')),
         COUNT(*) FILTER (WHERE asset_row->>'role' = 'MAIN')
  INTO distinct_count, slot_count, main_count
  FROM jsonb_array_elements(value) AS assets(asset_row);
  RETURN distinct_count = jsonb_array_length(value)
    AND slot_count = jsonb_array_length(value)
    AND main_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_asset_evidence_matches(
  value JSONB,
  source_fact_evidence JSONB,
  expected_account_id TEXT,
  expected_job_id TEXT,
  expected_item_id TEXT,
  expected_plan_id TEXT,
  expected_plan_hash TEXT,
  expected_source_hash TEXT,
  expected_profile_id TEXT,
  expected_profile_version INTEGER,
  expected_checker_model TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry JSONB;
BEGIN
  IF NOT auto_listing_rich_asset_evidence_valid(value) THEN
    RETURN FALSE;
  END IF;
  FOR entry IN SELECT asset_entry FROM jsonb_array_elements(value) AS assets(asset_entry)
  LOOP
    IF entry->>'accountId' <> expected_account_id OR entry->>'jobId' <> expected_job_id
      OR entry->>'itemId' <> expected_item_id OR entry->>'planId' <> expected_plan_id
      OR entry->>'planHash' <> expected_plan_hash OR entry->>'sourceHash' <> expected_source_hash
      OR entry->>'profileId' <> expected_profile_id
      OR (entry->>'profileVersion')::INTEGER <> expected_profile_version
      OR entry->'checkerEvidence'->>'checkerModel' <> expected_checker_model
      OR entry->'checkerEvidence'->'sourceFacts' <> source_fact_evidence
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_content_valid(
  rich_content JSONB,
  source_fact_evidence JSONB,
  asset_evidence JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  block JSONB;
  binding JSONB;
  fact_id JSONB;
  block_index INTEGER;
  hero_count INTEGER := 0;
  referenced_asset_ids TEXT[] := ARRAY[]::TEXT[];
  source_fact_count INTEGER;
  binding_count INTEGER;
BEGIN
  IF NOT auto_listing_rich_fact_evidence_valid(source_fact_evidence)
    OR NOT auto_listing_rich_asset_evidence_valid(asset_evidence)
    OR jsonb_typeof(rich_content) IS DISTINCT FROM 'object'
    OR NOT (rich_content ?& ARRAY['version','language','blocks'])
    OR (rich_content - 'version' - 'language' - 'blocks') <> '{}'::JSONB
    OR jsonb_typeof(rich_content->'version') <> 'string'
    OR (rich_content->>'version' = 'AUTO_LISTING_RICH_CONTENT_V1') IS NOT TRUE
    OR jsonb_typeof(rich_content->'language') <> 'string'
    OR (rich_content->>'language' = 'ru') IS NOT TRUE
    OR jsonb_typeof(rich_content->'blocks') IS DISTINCT FROM 'array'
    OR jsonb_array_length(rich_content->'blocks') NOT BETWEEN 3 AND 20
  THEN
    RETURN FALSE;
  END IF;

  FOR block, block_index IN
    SELECT block_value, ordinal::INTEGER
    FROM jsonb_array_elements(rich_content->'blocks') WITH ORDINALITY AS blocks(block_value, ordinal)
  LOOP
    IF jsonb_typeof(block) <> 'object' OR jsonb_typeof(block->'type') <> 'string' THEN
      RETURN FALSE;
    END IF;
    IF block->>'type' = 'HERO_IMAGE' THEN
      hero_count := hero_count + 1;
      IF block_index <> 1 OR NOT (block ?& ARRAY['type','assetId'])
        OR (block - 'type' - 'assetId') <> '{}'::JSONB
        OR jsonb_typeof(block->'assetId') <> 'string' OR NULLIF(BTRIM(block->>'assetId'), '') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(asset_evidence) AS assets(entry)
          WHERE entry->>'assetId' = block->>'assetId' AND entry->>'role' = 'MAIN'
        )
      THEN
        RETURN FALSE;
      END IF;
      referenced_asset_ids := array_append(referenced_asset_ids, block->>'assetId');
      CONTINUE;
    END IF;

    IF block->>'type' NOT IN ('HEADING','TEXT','IMAGE_TEXT')
      OR NOT (block ?& ARRAY['type','text','sourceFactIds','factBindings'])
      OR (block->>'type' = 'IMAGE_TEXT' AND NOT (block ? 'assetId'))
      OR (block->>'type' <> 'IMAGE_TEXT' AND block ? 'assetId')
      OR (block - 'type' - 'assetId' - 'text' - 'sourceFactIds' - 'factBindings') <> '{}'::JSONB
      OR jsonb_typeof(block->'text') <> 'string' OR NULLIF(BTRIM(block->>'text'), '') IS NULL
      OR OCTET_LENGTH(block->>'text') > 8192
      OR jsonb_typeof(block->'sourceFactIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(block->'sourceFactIds') NOT BETWEEN 1 AND 32
      OR jsonb_typeof(block->'factBindings') IS DISTINCT FROM 'array'
      OR jsonb_array_length(block->'factBindings') <> jsonb_array_length(block->'sourceFactIds')
    THEN
      RETURN FALSE;
    END IF;

    SELECT COUNT(*), COUNT(DISTINCT fact_value #>> '{}')
    INTO source_fact_count, binding_count
    FROM jsonb_array_elements(block->'sourceFactIds') AS ids(fact_value)
    WHERE jsonb_typeof(fact_value) = 'string'
      AND NULLIF(BTRIM(fact_value #>> '{}'), '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(source_fact_evidence) AS facts(entry)
        WHERE entry->>'factId' = fact_value #>> '{}'
      );
    IF source_fact_count <> jsonb_array_length(block->'sourceFactIds')
      OR binding_count <> source_fact_count THEN
      RETURN FALSE;
    END IF;

    FOR binding IN SELECT binding_value FROM jsonb_array_elements(block->'factBindings') AS bindings(binding_value)
    LOOP
      IF jsonb_typeof(binding) <> 'object'
        OR NOT (binding ?& ARRAY['sourceFactId','field','value','numericValue','unit'])
        OR (binding - 'sourceFactId' - 'field' - 'value' - 'numericValue' - 'unit') <> '{}'::JSONB
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(source_fact_evidence) AS facts(entry)
          WHERE entry->>'factId' = binding->>'sourceFactId'
            AND entry->'field' = binding->'field'
            AND entry->'value' = binding->'value'
            AND entry->'numericValue' = binding->'numericValue'
            AND entry->'unit' = binding->'unit'
        )
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(block->'sourceFactIds') AS ids(fact_value)
          WHERE fact_value #>> '{}' = binding->>'sourceFactId'
        )
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    SELECT COUNT(DISTINCT entry->>'sourceFactId')
    INTO binding_count
    FROM jsonb_array_elements(block->'factBindings') AS bindings(entry);
    IF binding_count <> jsonb_array_length(block->'factBindings') THEN
      RETURN FALSE;
    END IF;

    IF block->>'type' = 'IMAGE_TEXT' THEN
      IF jsonb_typeof(block->'assetId') <> 'string' OR NULLIF(BTRIM(block->>'assetId'), '') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(asset_evidence) AS assets(entry)
          WHERE entry->>'assetId' = block->>'assetId'
        )
      THEN
        RETURN FALSE;
      END IF;
      referenced_asset_ids := array_append(referenced_asset_ids, block->>'assetId');
    END IF;
  END LOOP;
  SELECT COUNT(DISTINCT asset_id) INTO source_fact_count FROM unnest(referenced_asset_ids) AS ids(asset_id);
  RETURN hero_count = 1 AND source_fact_count = cardinality(referenced_asset_ids);
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_checker_evidence_valid(
  checker_result JSONB,
  rich_content JSONB,
  source_fact_evidence JSONB,
  asset_evidence JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  checker_fact_count INTEGER;
  checker_asset_count INTEGER;
  content_fact_count INTEGER;
  content_asset_count INTEGER;
BEGIN
  IF NOT auto_listing_rich_content_valid(rich_content, source_fact_evidence, asset_evidence)
    OR jsonb_typeof(checker_result) IS DISTINCT FROM 'object'
    OR NOT (checker_result ?& ARRAY['accepted','validator','sourceFactIds','assetIds'])
    OR (checker_result - 'accepted' - 'validator' - 'sourceFactIds' - 'assetIds') <> '{}'::JSONB
    OR jsonb_typeof(checker_result->'accepted') <> 'boolean'
    OR (checker_result->'accepted' = 'true'::JSONB) IS NOT TRUE
    OR jsonb_typeof(checker_result->'validator') <> 'string'
    OR (checker_result->>'validator' = 'AUTO_LISTING_RICH_CONTENT_V1') IS NOT TRUE
    OR jsonb_typeof(checker_result->'sourceFactIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(checker_result->'sourceFactIds') < 1
    OR jsonb_typeof(checker_result->'assetIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(checker_result->'assetIds') < 1
  THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(DISTINCT fact_id #>> '{}') INTO checker_fact_count
  FROM jsonb_array_elements(checker_result->'sourceFactIds') AS checker_facts(fact_id)
  WHERE jsonb_typeof(fact_id) = 'string'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(source_fact_evidence) AS facts(entry)
      WHERE entry->>'factId' = fact_id #>> '{}'
    );
  SELECT COUNT(DISTINCT asset_id #>> '{}') INTO checker_asset_count
  FROM jsonb_array_elements(checker_result->'assetIds') AS checker_assets(asset_id)
  WHERE jsonb_typeof(asset_id) = 'string'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(asset_evidence) AS assets(entry)
      WHERE entry->>'assetId' = asset_id #>> '{}'
    );
  SELECT COUNT(DISTINCT fact_id #>> '{}') INTO content_fact_count
  FROM jsonb_array_elements(rich_content->'blocks') AS blocks(block),
       LATERAL jsonb_array_elements(COALESCE(block->'sourceFactIds', '[]'::JSONB)) AS ids(fact_id);
  SELECT COUNT(DISTINCT block->>'assetId') INTO content_asset_count
  FROM jsonb_array_elements(rich_content->'blocks') AS blocks(block)
  WHERE block ? 'assetId';

  RETURN checker_fact_count = jsonb_array_length(checker_result->'sourceFactIds')
    AND checker_asset_count = jsonb_array_length(checker_result->'assetIds')
    AND checker_fact_count = content_fact_count
    AND checker_asset_count = content_asset_count
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(rich_content->'blocks') AS blocks(block),
           LATERAL jsonb_array_elements(COALESCE(block->'sourceFactIds', '[]'::JSONB)) AS ids(fact_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(checker_result->'sourceFactIds') AS checker_facts(checker_id)
        WHERE checker_id #>> '{}' = fact_id #>> '{}'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(rich_content->'blocks') AS blocks(block)
      WHERE block ? 'assetId' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(checker_result->'assetIds') AS checker_assets(asset_id)
        WHERE asset_id #>> '{}' = block->>'assetId'
      )
    );
END;
$$;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_new_write_hash_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
    ALTER TABLE ai_rich_content_results
      ADD CONSTRAINT ai_rich_content_results_new_write_hash_check CHECK (
        status NOT IN ('GENERATING', 'ACCEPTED') OR (
          input_hash IS NOT NULL AND input_hash ~ '^[a-f0-9]{64}$'
          AND source_hash IS NOT NULL AND source_hash ~ '^[a-f0-9]{64}$'
          AND asset_hash IS NOT NULL AND asset_hash ~ '^[a-f0-9]{64}$'
          AND plan_hash IS NOT NULL AND plan_hash ~ '^[a-f0-9]{64}$'
          AND fact_registry_hash IS NOT NULL AND fact_registry_hash ~ '^[a-f0-9]{64}$'
          AND prompt_hash IS NOT NULL AND prompt_hash ~ '^[a-f0-9]{64}$'
          AND (status <> 'ACCEPTED' OR (
            output_hash IS NOT NULL AND output_hash ~ '^[a-f0-9]{64}$'
          ))
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_generating_closed_evidence_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
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
          AND auto_listing_rich_asset_evidence_valid(asset_evidence) IS TRUE
          AND auto_listing_rich_asset_evidence_matches(
            asset_evidence, source_fact_evidence, account_id, job_id, item_id, plan_id,
            plan_hash, source_hash, profile_id, profile_version, model_name
          ) IS TRUE
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_rich_content_results_accepted_closed_evidence_check'
      AND conrelid = 'ai_rich_content_results'::regclass
  ) THEN
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
          AND (model_evidence->>'gatewayReportedTextModel' = model_name) IS TRUE
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
