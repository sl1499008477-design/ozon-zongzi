-- ACCEPTED image rows have already passed the authoritative image checker.
-- Keep the database boundary focused on immutable provenance and structure so
-- a newer checker payload cannot be rejected by an older semantic replay.
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
  checker_sources JSONB;
  model_evidence JSONB;
  source_fact_id JSONB;
  distinct_count INTEGER;
  has_category_style BOOLEAN;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR NOT (value ?& ARRAY[
      'checkerResult','textRequired','sourceFactIds','sourceFacts','sourceAssets','generatedHash',
      'checkerModel','checkerModelEvidence','profileId','profileAccountId','profileVersion',
      'templateVersion','requestId'
    ])
    OR jsonb_typeof(value->'checkerResult') IS DISTINCT FROM 'object'
    OR jsonb_typeof(value->'textRequired') IS DISTINCT FROM 'boolean'
    OR ((value ? 'textForbidden') AND jsonb_typeof(value->'textForbidden') IS DISTINCT FROM 'boolean')
    OR jsonb_typeof(value->'sourceFactIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(value->'sourceFactIds') > 256
    OR auto_listing_rich_fact_evidence_valid(value->'sourceFacts') IS NOT TRUE
    OR jsonb_typeof(value->'sourceAssets') IS DISTINCT FROM 'array'
    OR auto_listing_rich_source_asset_evidence_valid(value->'sourceAssets') IS NOT TRUE
    OR value->>'generatedHash' <> content_hash
    OR value->>'checkerModel' <> checker_model
    OR value->>'profileId' <> profile_id
    OR value->>'profileAccountId' <> profile_account_id
    OR jsonb_typeof(value->'profileVersion') IS DISTINCT FROM 'number'
    OR (value->>'profileVersion') !~ '^[0-9]+$'
    OR (value->>'profileVersion')::INTEGER <> profile_version
    OR value->>'templateVersion' <> template_version
    OR value->>'requestId' <> checker_request_id
  THEN
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(source_asset_evidence) IS DISTINCT FROM 'array'
    OR jsonb_array_length(source_asset_evidence) < 1
  THEN
    RETURN FALSE;
  END IF;
  checker_sources := value->'sourceAssets';
  IF checker_sources <> source_asset_evidence
    AND checker_sources <> jsonb_build_array(source_asset_evidence->0)
  THEN
    RETURN FALSE;
  END IF;

  FOR source_fact_id IN
    SELECT fact_id FROM jsonb_array_elements(value->'sourceFactIds') AS fact_ids(fact_id)
  LOOP
    IF jsonb_typeof(source_fact_id) IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(source_fact_id #>> '{}'), '') IS NULL
      OR BTRIM(source_fact_id #>> '{}') <> source_fact_id #>> '{}'
      OR OCTET_LENGTH(source_fact_id #>> '{}') > 240
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(value->'sourceFacts') AS facts(fact)
        WHERE fact->>'factId' = source_fact_id #>> '{}'
      )
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
    OR NOT (model_evidence ?& ARRAY[
      'requestedTextModel','gatewayReportedTextModel','gatewayReportedTextModelPresent'
    ])
    OR (model_evidence - 'requestedTextModel' - 'gatewayReportedTextModel'
      - 'gatewayReportedTextModelPresent') <> '{}'::JSONB
    OR model_evidence->>'requestedTextModel' <> checker_model
    OR jsonb_typeof(model_evidence->'gatewayReportedTextModel') IS DISTINCT FROM 'string'
    OR jsonb_typeof(model_evidence->'gatewayReportedTextModelPresent') IS DISTINCT FROM 'boolean'
    OR NOT (
      ((model_evidence->'gatewayReportedTextModelPresent' = 'true'::JSONB) IS TRUE
        AND auto_listing_ai_model_identity_compatible(
          checker_model, model_evidence->>'gatewayReportedTextModel'
        ) IS TRUE)
      OR
      ((model_evidence->'gatewayReportedTextModelPresent' = 'false'::JSONB) IS TRUE
        AND model_evidence->>'gatewayReportedTextModel' = '')
    )
  THEN
    RETURN FALSE;
  END IF;

  has_category_style := (value ? 'categoryStyleGuidance') OR (value ? 'categoryStyleAssets');
  IF has_category_style AND (
    NOT ((value ? 'categoryStyleGuidance') AND (value ? 'categoryStyleAssets'))
    OR jsonb_typeof(value->'categoryStyleGuidance') IS DISTINCT FROM 'object'
    OR jsonb_typeof(value->'categoryStyleAssets') IS DISTINCT FROM 'array'
    OR jsonb_array_length(value->'categoryStyleAssets') NOT BETWEEN 1 AND 3
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

-- Keep platform-risk content blocked. Package contents are instead decided by
-- the application validator, which can see the exact cited frozen facts.
CREATE OR REPLACE FUNCTION auto_listing_rich_policy_rules_valid(text_value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT NOT (
    text_value ~* 'https?://'
    OR text_value ~* 'www\.'
    OR text_value ~* '[[:alnum:]_.%+-]+@[[:alnum:].-]+\.[A-Za-z]{2,}'
    OR text_value ~ '(\+?7|8)[[:space:]()-]*[0-9]{3}[[:space:]()-]*[0-9]{3}[[:space:]-]*[0-9]{2}[[:space:]-]*[0-9]{2}'
    OR text_value ~* '(^|[^[:alnum:]])(telegram|whatsapp|viber|телеграм|ватсап|позвон|пишите|свяжитесь|контакт[[:alpha:]-]*|телефон[[:alpha:]-]*|обрат[[:alpha:]-]*[[:space:]]+к[[:space:]]+продавц[[:alpha:]-]*)'
    OR text_value ~* '(^|[^[:alnum:]])(остав(ьте|ить)[[:space:]]+отзыв|оцените[[:space:]]+(нас|товар)|отзыв)'
    OR text_value ~* '(^|[^[:alnum:]])(сертифицирован|сертификат|сертификац|лечебн|медицинск|исцел|гаранти|возврат|обмен)[[:alpha:]-]*'
    OR text_value ~* '(^|[^[:alnum:]])(подарок|бонус)'
  )
$$;

-- Any Latin token copied from a cited frozen fact is internal trusted data.
-- Russian prose is still required, so an English-only block remains invalid.
CREATE OR REPLACE FUNCTION auto_listing_rich_russian_text_valid(
  text_value TEXT,
  source_facts JSONB,
  source_fact_ids JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  allowed_tokens TEXT[] := ARRAY['usb','usb-c','led','bpa','ipx4','ipx5','ipx6','ipx7','ipx8','wifi','bluetooth'];
  fact_token_match TEXT[];
  text_token_match TEXT[];
  text_token TEXT;
  has_cyrillic BOOLEAN := FALSE;
BEGIN
  IF text_value IS NULL
    OR jsonb_typeof(source_facts) IS DISTINCT FROM 'array'
    OR jsonb_typeof(source_fact_ids) IS DISTINCT FROM 'array'
  THEN
    RETURN FALSE;
  END IF;

  FOR fact_token_match IN
    SELECT captures
    FROM jsonb_array_elements(source_facts) AS facts(fact),
         jsonb_array_elements(source_fact_ids) AS ids(fact_id),
         LATERAL regexp_matches(fact->>'value', '[A-Za-z][A-Za-z0-9-]*', 'g') AS matches(captures)
    WHERE fact->>'factId' = fact_id #>> '{}'
  LOOP
    allowed_tokens := array_append(allowed_tokens, LOWER(fact_token_match[1]));
  END LOOP;

  FOR text_token_match IN
    SELECT captures
    FROM regexp_matches(text_value, '[[:alnum:]]+(?:-[[:alnum:]]+)*', 'g') AS matches(captures)
  LOOP
    text_token := text_token_match[1];
    IF text_token ~ '[А-Яа-яЁё]' THEN
      IF text_token !~ '^[А-Яа-яЁё0-9-]+$' THEN
        RETURN FALSE;
      END IF;
      has_cyrillic := TRUE;
    ELSIF text_token ~ '^[0-9]+$' THEN
      CONTINUE;
    ELSIF text_token ~ '^[A-Za-z][A-Za-z0-9-]*$'
      AND LOWER(text_token) = ANY(allowed_tokens) THEN
      CONTINUE;
    ELSE
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN has_cyrillic;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;
