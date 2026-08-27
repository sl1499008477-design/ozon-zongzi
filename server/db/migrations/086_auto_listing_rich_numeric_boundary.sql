CREATE OR REPLACE FUNCTION auto_listing_rich_fact_derived_numeric(value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  captures TEXT[];
  numeric_text TEXT;
  unit_text TEXT;
BEGIN
  captures := regexp_match(BTRIM(value), '^(-?[0-9]+([.,][0-9]+)?)[[:space:]]*([[:alpha:]%°]{1,16})$');
  IF captures IS NOT NULL THEN
    numeric_text := captures[1];
    unit_text := captures[3];
  ELSE
    captures := regexp_match(BTRIM(value), ',[[:space:]]*([[:alpha:]%°]{1,16})[[:space:]]*:[[:space:]]*(-?[0-9]+([.,][0-9]+)?)[[:space:]]*$');
    IF captures IS NOT NULL THEN
      unit_text := captures[1];
      numeric_text := captures[2];
    ELSE
      captures := regexp_match(BTRIM(value), '\([[:space:]]*([[:alpha:]%°]{1,16})[[:space:]]*\)[[:space:]]*:[[:space:]]*(-?[0-9]+([.,][0-9]+)?)[[:space:]]*$');
      IF captures IS NULL THEN
        RETURN NULL;
      END IF;
      unit_text := captures[1];
      numeric_text := captures[2];
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'numericValue', REPLACE(numeric_text, ',', '.')::NUMERIC,
    'unit', auto_listing_rich_unit_normalized(unit_text)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_fact_numeric_projection_matches(left_fact JSONB, right_fact JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  derived JSONB;
  explicit_fact JSONB;
BEGIN
  IF jsonb_typeof(left_fact->'numericValue') = 'null'
    AND jsonb_typeof(right_fact->'numericValue') = 'null' THEN
    RETURN TRUE;
  END IF;
  IF jsonb_typeof(left_fact->'numericValue') = 'number'
    AND jsonb_typeof(right_fact->'numericValue') = 'number' THEN
    RETURN (left_fact->>'numericValue')::NUMERIC = (right_fact->>'numericValue')::NUMERIC
      AND auto_listing_rich_unit_normalized(left_fact->>'unit')
        IS NOT DISTINCT FROM auto_listing_rich_unit_normalized(right_fact->>'unit');
  END IF;
  explicit_fact := CASE WHEN jsonb_typeof(left_fact->'numericValue') = 'number' THEN left_fact ELSE right_fact END;
  derived := auto_listing_rich_fact_derived_numeric(left_fact->>'value');
  RETURN derived IS NOT NULL
    AND (derived->>'numericValue')::NUMERIC = (explicit_fact->>'numericValue')::NUMERIC
    AND derived->>'unit' IS NOT DISTINCT FROM auto_listing_rich_unit_normalized(explicit_fact->>'unit');
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_numeric_binding_count(
  bindings JSONB,
  numeric_text TEXT,
  unit_text TEXT
)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COUNT(*)::INTEGER
  FROM jsonb_array_elements(bindings) AS rows(candidate_binding)
  WHERE (
    jsonb_typeof(candidate_binding->'numericValue') = 'number'
    AND REPLACE(numeric_text, ',', '.')::NUMERIC = (candidate_binding->>'numericValue')::NUMERIC
    AND (
      (jsonb_typeof(candidate_binding->'unit') = 'null' AND unit_text IS NULL)
      OR (jsonb_typeof(candidate_binding->'unit') = 'string' AND unit_text IS NOT NULL
        AND auto_listing_rich_unit_normalized(unit_text) = auto_listing_rich_unit_normalized(candidate_binding->>'unit'))
    )
  ) OR (
    jsonb_typeof(candidate_binding->'numericValue') = 'null'
    AND EXISTS (
      SELECT 1
      FROM regexp_matches(
        candidate_binding->>'value',
        '(^|[^[:alnum:]])(-?[0-9]+([.,][0-9]+)?)([[:space:]]*([[:alpha:]%°]{1,16}))?',
        'g'
      ) AS embedded(captures)
      WHERE REPLACE(embedded.captures[2], ',', '.')::NUMERIC = REPLACE(numeric_text, ',', '.')::NUMERIC
        AND (
          (embedded.captures[5] IS NULL AND unit_text IS NULL)
          OR (embedded.captures[5] IS NOT NULL AND unit_text IS NOT NULL
            AND auto_listing_rich_unit_normalized(embedded.captures[5]) = auto_listing_rich_unit_normalized(unit_text))
        )
    )
  )
$$;

CREATE OR REPLACE FUNCTION auto_listing_rich_text_matches_bindings(text_value TEXT, bindings JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  binding JSONB;
  numeric_match TEXT[];
  fact_token TEXT;
  candidate_token TEXT;
  fact_token_found BOOLEAN;
  normalized_text TEXT;
  normalized_value TEXT;
BEGIN
  IF text_value IS NULL OR text_value = '' OR BTRIM(text_value) <> text_value
    OR OCTET_LENGTH(text_value) > 8192 OR text_value ~ '[[:cntrl:]]'
    OR jsonb_typeof(bindings) IS DISTINCT FROM 'array'
    OR jsonb_array_length(bindings) NOT BETWEEN 1 AND 32 THEN
    RETURN FALSE;
  END IF;

  normalized_text := LOWER(REGEXP_REPLACE(BTRIM(text_value), '[[:space:]]+', ' ', 'g'));
  FOR binding IN SELECT binding_value FROM jsonb_array_elements(bindings) AS rows(binding_value)
  LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
      OR NOT (binding ?& ARRAY['sourceFactId','field','value','numericValue','unit'])
      OR (binding - 'sourceFactId' - 'field' - 'value' - 'numericValue' - 'unit') <> '{}'::JSONB
      OR jsonb_typeof(binding->'sourceFactId') <> 'string'
      OR jsonb_typeof(binding->'field') <> 'string'
      OR jsonb_typeof(binding->'value') <> 'string'
      OR jsonb_typeof(binding->'numericValue') NOT IN ('number','null')
      OR jsonb_typeof(binding->'unit') NOT IN ('string','null') THEN
      RETURN FALSE;
    END IF;

    IF jsonb_typeof(binding->'numericValue') = 'number' THEN
      fact_token_found := FALSE;
      FOR numeric_match IN SELECT captures FROM regexp_matches(
        text_value,
        '(^|[^[:alnum:]])(-?[0-9]+([.,][0-9]+)?)([[:space:]]*([[:alpha:]%°]{1,16}))?',
        'g'
      ) AS matches(captures)
      LOOP
        IF REPLACE(numeric_match[2], ',', '.')::NUMERIC = (binding->>'numericValue')::NUMERIC
          AND ((jsonb_typeof(binding->'unit') = 'null' AND numeric_match[5] IS NULL)
            OR (jsonb_typeof(binding->'unit') = 'string' AND numeric_match[5] IS NOT NULL
              AND auto_listing_rich_unit_normalized(numeric_match[5]) = auto_listing_rich_unit_normalized(binding->>'unit'))) THEN
          fact_token_found := TRUE;
        END IF;
      END LOOP;
      IF NOT fact_token_found THEN RETURN FALSE; END IF;
    ELSE
      normalized_value := LOWER(REGEXP_REPLACE(BTRIM(binding->>'value'), '[[:space:]]+', ' ', 'g'));
      IF POSITION(normalized_value IN normalized_text) = 0 THEN
        FOR fact_token IN SELECT token FROM regexp_split_to_table(normalized_value, '[^[:alnum:]]+') AS tokens(token) WHERE token <> ''
        LOOP
          fact_token_found := FALSE;
          FOR candidate_token IN SELECT token FROM regexp_split_to_table(normalized_text, '[^[:alnum:]]+') AS tokens(token) WHERE token <> ''
          LOOP
            IF (fact_token ~ '^[а-яё]+$' AND CHAR_LENGTH(fact_token) >= 5
                AND candidate_token LIKE SUBSTRING(fact_token FROM 1 FOR GREATEST(4, CHAR_LENGTH(fact_token) - 3)) || '%')
              OR ((fact_token !~ '^[а-яё]+$' OR CHAR_LENGTH(fact_token) < 5) AND candidate_token = fact_token) THEN
              fact_token_found := TRUE;
              EXIT;
            END IF;
          END LOOP;
          IF NOT fact_token_found THEN RETURN FALSE; END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  FOR numeric_match IN SELECT captures FROM regexp_matches(
    text_value,
    '(^|[^[:alnum:]])(-?[0-9]+([.,][0-9]+)?)([[:space:]]*([[:alpha:]%°]{1,16}))?',
    'g'
  ) AS matches(captures)
  LOOP
    IF auto_listing_rich_numeric_binding_count(bindings, numeric_match[2], numeric_match[5]) <> 1 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
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
  checker_fact JSONB;
BEGIN
  IF NOT auto_listing_rich_asset_evidence_valid(value) THEN RETURN FALSE; END IF;
  FOR entry IN SELECT asset_entry FROM jsonb_array_elements(value) AS assets(asset_entry)
  LOOP
    IF entry->>'accountId' <> expected_account_id OR entry->>'jobId' <> expected_job_id
      OR entry->>'itemId' <> expected_item_id OR entry->>'planId' <> expected_plan_id
      OR entry->>'planHash' <> expected_plan_hash OR entry->>'sourceHash' <> expected_source_hash
      OR entry->>'profileId' <> expected_profile_id
      OR (entry->>'profileVersion')::INTEGER <> expected_profile_version
      OR entry->'checkerEvidence'->>'checkerModel' <> expected_checker_model THEN
      RETURN FALSE;
    END IF;
    FOR checker_fact IN SELECT fact_value FROM jsonb_array_elements(entry->'checkerEvidence'->'sourceFacts') AS checker_facts(fact_value)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(source_fact_evidence) AS frozen_facts(fact_value)
        WHERE fact_value->>'factId' = checker_fact->>'factId'
          AND fact_value->'field' = checker_fact->'field'
          AND fact_value->'kind' = checker_fact->'kind'
          AND fact_value->'value' = checker_fact->'value'
          AND fact_value->'sourcePath' = checker_fact->'sourcePath'
          AND auto_listing_rich_fact_numeric_projection_matches(fact_value, checker_fact)
      ) THEN RETURN FALSE; END IF;
    END LOOP;
  END LOOP;
  RETURN TRUE;
END;
$$;
