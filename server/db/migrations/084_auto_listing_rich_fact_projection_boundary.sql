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
    THEN
      RETURN FALSE;
    END IF;
    FOR checker_fact IN
      SELECT fact_value
      FROM jsonb_array_elements(entry->'checkerEvidence'->'sourceFacts') AS checker_facts(fact_value)
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(source_fact_evidence) AS frozen_facts(fact_value)
        WHERE fact_value->>'factId' = checker_fact->>'factId'
          AND fact_value->'field' = checker_fact->'field'
          AND fact_value->'kind' = checker_fact->'kind'
          AND fact_value->'value' = checker_fact->'value'
          AND fact_value->'sourcePath' = checker_fact->'sourcePath'
      ) THEN
        RETURN FALSE;
      END IF;
    END LOOP;
  END LOOP;
  RETURN TRUE;
END;
$$;
