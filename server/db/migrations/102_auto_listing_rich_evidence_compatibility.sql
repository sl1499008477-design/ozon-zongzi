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
  checker_is_subset BOOLEAN;
  rich_is_subset BOOLEAN;
BEGIN
  IF auto_listing_rich_fact_evidence_valid(source_fact_evidence) IS NOT TRUE
    OR auto_listing_rich_asset_evidence_valid(value) IS NOT TRUE THEN
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

    SELECT NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(entry->'checkerEvidence'->'sourceFacts') AS checker_facts(checker_fact)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(source_fact_evidence) AS rich_facts(rich_fact)
        WHERE rich_fact->>'factId' = checker_fact->>'factId'
          AND rich_fact->'field' = checker_fact->'field'
          AND rich_fact->'kind' = checker_fact->'kind'
          AND rich_fact->'value' = checker_fact->'value'
          AND rich_fact->'sourcePath' = checker_fact->'sourcePath'
          AND auto_listing_rich_fact_numeric_projection_matches(rich_fact, checker_fact)
      )
    ) INTO checker_is_subset;

    SELECT NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(source_fact_evidence) AS rich_facts(rich_fact)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(entry->'checkerEvidence'->'sourceFacts') AS checker_facts(checker_fact)
        WHERE checker_fact->>'factId' = rich_fact->>'factId'
          AND checker_fact->'field' = rich_fact->'field'
          AND checker_fact->'kind' = rich_fact->'kind'
          AND checker_fact->'value' = rich_fact->'value'
          AND checker_fact->'sourcePath' = rich_fact->'sourcePath'
          AND auto_listing_rich_fact_numeric_projection_matches(checker_fact, rich_fact)
      )
    ) INTO rich_is_subset;

    IF NOT (checker_is_subset OR rich_is_subset) THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
