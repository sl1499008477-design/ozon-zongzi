ALTER TABLE ai_generation_assets
  ADD COLUMN IF NOT EXISTS plan_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_hash TEXT,
  ADD COLUMN IF NOT EXISTS strategy_hash TEXT,
  ADD COLUMN IF NOT EXISTS config_hash TEXT,
  ADD COLUMN IF NOT EXISTS visual_groups_hash TEXT,
  ADD COLUMN IF NOT EXISTS prompt_template_version TEXT,
  ADD COLUMN IF NOT EXISTS source_asset_evidence JSONB,
  ADD COLUMN IF NOT EXISTS checker_request_id TEXT,
  ADD COLUMN IF NOT EXISTS model_evidence JSONB,
  ADD COLUMN IF NOT EXISTS regeneration JSONB,
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION auto_listing_generation_source_evidence_complete(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry JSONB;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(value) NOT BETWEEN 1 AND 7 THEN
    RETURN FALSE;
  END IF;
  IF (
    SELECT COUNT(DISTINCT item->>'assetId')
    FROM jsonb_array_elements(value) AS items(item)
  ) <> jsonb_array_length(value) THEN
    RETURN FALSE;
  END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(value) AS items(item)
  LOOP
    IF jsonb_typeof(entry) <> 'object'
      OR NOT (entry ?& ARRAY['assetId', 'contentHash', 'contentType', 'width', 'height', 'size'])
      OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(entry) AS keys(key)
        WHERE key <> ALL (ARRAY['assetId', 'contentHash', 'contentType', 'width', 'height', 'size'])
      )
      OR NULLIF(BTRIM(entry->>'assetId'), '') IS NULL
      OR COALESCE(entry->>'contentHash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(jsonb_typeof(entry->'contentType'), 'null') <> 'string'
      OR COALESCE(entry->>'contentType', '') NOT IN ('image/png', 'image/jpeg', 'image/webp')
      OR jsonb_typeof(entry->'width') <> 'number' OR COALESCE(entry->>'width', '') !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(entry->'height') <> 'number' OR COALESCE(entry->>'height', '') !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(entry->'size') <> 'number' OR COALESCE(entry->>'size', '') !~ '^[1-9][0-9]*$'
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_plan_hash_format_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_plan_hash_format_check CHECK (plan_hash IS NULL OR plan_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_source_hash_format_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_source_hash_format_check CHECK (source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_strategy_hash_format_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_strategy_hash_format_check CHECK (strategy_hash IS NULL OR strategy_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_config_hash_format_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_config_hash_format_check CHECK (config_hash IS NULL OR config_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_visual_groups_hash_format_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_visual_groups_hash_format_check CHECK (visual_groups_hash IS NULL OR visual_groups_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_source_asset_evidence_type_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_source_asset_evidence_type_check CHECK (source_asset_evidence IS NULL OR jsonb_typeof(source_asset_evidence) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_lease_pair_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_lease_pair_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_lease_status_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_lease_status_check CHECK (
      (status = 'GENERATING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'GENERATING' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_new_accepted_evidence_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_new_accepted_evidence_check CHECK (
      status <> 'ACCEPTED' OR (
        input_hash ~ '^[a-f0-9]{64}$'
        AND prompt_hash ~ '^[a-f0-9]{64}$'
        AND plan_hash IS NOT NULL AND plan_hash ~ '^[a-f0-9]{64}$'
        AND source_hash IS NOT NULL AND source_hash ~ '^[a-f0-9]{64}$'
        AND strategy_hash IS NOT NULL AND strategy_hash ~ '^[a-f0-9]{64}$'
        AND config_hash IS NOT NULL AND config_hash ~ '^[a-f0-9]{64}$'
        AND visual_groups_hash IS NOT NULL AND visual_groups_hash ~ '^[a-f0-9]{64}$'
        AND NULLIF(BTRIM(prompt_template_version), '') IS NOT NULL
        AND auto_listing_generation_source_evidence_complete(source_asset_evidence)
        AND NULLIF(BTRIM(gateway_request_id), '') IS NOT NULL
        AND NULLIF(BTRIM(checker_request_id), '') IS NOT NULL
        AND model_evidence IS NOT NULL AND jsonb_typeof(model_evidence) = 'object' AND model_evidence <> '{}'::JSONB
        AND (regeneration IS NULL OR jsonb_typeof(regeneration) = 'object')
        AND NULLIF(BTRIM(object_key), '') IS NOT NULL
        AND content_hash ~ '^[a-f0-9]{64}$'
        AND content_type = 'image/png'
        AND width IS NOT NULL AND width > 0
        AND height IS NOT NULL AND height > 0
        AND size_bytes IS NOT NULL AND size_bytes > 0
        AND jsonb_typeof(checker_result) = 'object' AND checker_result <> '{}'::JSONB
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_new_rejected_requests_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_new_rejected_requests_check CHECK (
      status <> 'REJECTED' OR (
        NULLIF(BTRIM(gateway_request_id), '') IS NOT NULL
        AND NULLIF(BTRIM(checker_request_id), '') IS NOT NULL
      )
    ) NOT VALID;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ai_generation_assets_accepted_plan_input_idx
  ON ai_generation_assets(account_id, plan_id, input_hash)
  WHERE status = 'ACCEPTED';

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_active_scope_key
  ON ai_generation_assets(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash)
  WHERE status = 'GENERATING';
