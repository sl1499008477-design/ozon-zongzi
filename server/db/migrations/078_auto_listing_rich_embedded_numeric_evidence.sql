-- Keep the database fact-binding guard aligned with the authoritative JS
-- validator: a complete trusted fact may contain a numeric token even when
-- the fact itself is not a standalone numeric attribute.
CREATE OR REPLACE FUNCTION auto_listing_rich_text_matches_bindings(text_value TEXT, bindings JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  binding JSONB;
  numeric_match TEXT[];
  numeric_match_count INTEGER;
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
      OR jsonb_typeof(binding->'unit') NOT IN ('string','null')
    THEN
      RETURN FALSE;
    END IF;

    IF jsonb_typeof(binding->'numericValue') = 'number' THEN
      fact_token_found := FALSE;
      FOR numeric_match IN
        SELECT captures
        FROM regexp_matches(
          text_value,
          '(^|[^[:alnum:]])(-?[0-9]+([.,][0-9]+)?)([[:space:]]*([[:alpha:]%°]{1,16}))?',
          'g'
        ) AS matches(captures)
      LOOP
        IF REPLACE(numeric_match[2], ',', '.')::NUMERIC = (binding->>'numericValue')::NUMERIC
          AND (
            (jsonb_typeof(binding->'unit') = 'null' AND numeric_match[5] IS NULL)
            OR
            (jsonb_typeof(binding->'unit') = 'string' AND numeric_match[5] IS NOT NULL
              AND auto_listing_rich_unit_normalized(numeric_match[5]) = auto_listing_rich_unit_normalized(binding->>'unit'))
          )
        THEN
          fact_token_found := TRUE;
        END IF;
      END LOOP;
      IF NOT fact_token_found THEN
        RETURN FALSE;
      END IF;
    ELSE
      normalized_value := LOWER(REGEXP_REPLACE(BTRIM(binding->>'value'), '[[:space:]]+', ' ', 'g'));
      IF POSITION(normalized_value IN normalized_text) = 0 THEN
        FOR fact_token IN
          SELECT token FROM regexp_split_to_table(normalized_value, '[^[:alnum:]]+') AS tokens(token)
          WHERE token <> ''
        LOOP
          fact_token_found := FALSE;
          FOR candidate_token IN
            SELECT token FROM regexp_split_to_table(normalized_text, '[^[:alnum:]]+') AS tokens(token)
            WHERE token <> ''
          LOOP
            IF (fact_token ~ '^[а-яё]+$' AND CHAR_LENGTH(fact_token) >= 5
                AND candidate_token LIKE SUBSTRING(fact_token FROM 1 FOR GREATEST(4, CHAR_LENGTH(fact_token) - 3)) || '%')
              OR ((fact_token !~ '^[а-яё]+$' OR CHAR_LENGTH(fact_token) < 5) AND candidate_token = fact_token)
            THEN
              fact_token_found := TRUE;
              EXIT;
            END IF;
          END LOOP;
          IF NOT fact_token_found THEN
            RETURN FALSE;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  FOR numeric_match IN
    SELECT captures
    FROM regexp_matches(
      text_value,
      '(^|[^[:alnum:]])(-?[0-9]+([.,][0-9]+)?)([[:space:]]*([[:alpha:]%°]{1,16}))?',
      'g'
    ) AS matches(captures)
  LOOP
    SELECT COUNT(*) INTO numeric_match_count
    FROM jsonb_array_elements(bindings) AS rows(candidate_binding)
    WHERE (
      jsonb_typeof(candidate_binding->'numericValue') = 'number'
      AND REPLACE(numeric_match[2], ',', '.')::NUMERIC = (candidate_binding->>'numericValue')::NUMERIC
      AND (
        (jsonb_typeof(candidate_binding->'unit') = 'null' AND numeric_match[5] IS NULL)
        OR
        (jsonb_typeof(candidate_binding->'unit') = 'string' AND numeric_match[5] IS NOT NULL
          AND auto_listing_rich_unit_normalized(numeric_match[5]) = auto_listing_rich_unit_normalized(candidate_binding->>'unit'))
      )
    ) OR (
      jsonb_typeof(candidate_binding->'numericValue') = 'null'
      AND EXISTS (
        SELECT 1
        FROM regexp_matches(
          candidate_binding->>'value',
          '(^|[^[:alnum:]])(-?[0-9]+([.,][0-9]+)?)([[:space:]]*([[:alpha:]%°]{1,16}))?',
          'g'
        ) AS fact_matches(captures)
        WHERE REPLACE(captures[2], ',', '.')::NUMERIC = REPLACE(numeric_match[2], ',', '.')::NUMERIC
          AND (
            (captures[5] IS NULL AND numeric_match[5] IS NULL)
            OR
            (captures[5] IS NOT NULL AND numeric_match[5] IS NOT NULL
              AND auto_listing_rich_unit_normalized(captures[5]) = auto_listing_rich_unit_normalized(numeric_match[5]))
          )
      )
    );
    IF numeric_match_count <> 1 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;
