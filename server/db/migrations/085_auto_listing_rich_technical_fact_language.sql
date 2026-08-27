CREATE OR REPLACE FUNCTION auto_listing_rich_unit_normalized(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE LOWER(BTRIM(value))
    WHEN 'мл' THEN 'ml'
    WHEN 'л' THEN 'l'
    WHEN 'см' THEN 'cm'
    WHEN 'мм' THEN 'mm'
    WHEN 'м' THEN 'm'
    WHEN 'кг' THEN 'kg'
    WHEN 'г' THEN 'g'
    WHEN 'вт' THEN 'w'
    ELSE LOWER(BTRIM(value))
  END
$$;

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
      AND (fact->>'kind' IN ('BRAND','MODEL') OR captures[1] ~ '[0-9]')
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
