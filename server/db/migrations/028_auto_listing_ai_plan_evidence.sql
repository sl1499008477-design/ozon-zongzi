ALTER TABLE ai_content_plans
  ADD COLUMN IF NOT EXISTS visual_groups_hash TEXT,
  ADD COLUMN IF NOT EXISTS visual_groups JSONB,
  ADD COLUMN IF NOT EXISTS regeneration JSONB,
  ADD COLUMN IF NOT EXISTS gateway_request_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_content_plans_visual_groups_hash_format_check'
      AND conrelid = 'ai_content_plans'::regclass
  ) THEN
    ALTER TABLE ai_content_plans
      ADD CONSTRAINT ai_content_plans_visual_groups_hash_format_check
      CHECK (visual_groups_hash IS NULL OR visual_groups_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_content_plans_visual_groups_type_check'
      AND conrelid = 'ai_content_plans'::regclass
  ) THEN
    ALTER TABLE ai_content_plans
      ADD CONSTRAINT ai_content_plans_visual_groups_type_check
      CHECK (visual_groups IS NULL OR jsonb_typeof(visual_groups) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_content_plans_regeneration_type_check'
      AND conrelid = 'ai_content_plans'::regclass
  ) THEN
    ALTER TABLE ai_content_plans
      ADD CONSTRAINT ai_content_plans_regeneration_type_check
      CHECK (regeneration IS NULL OR jsonb_typeof(regeneration) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_content_plans_gateway_request_id_safe_check'
      AND conrelid = 'ai_content_plans'::regclass
  ) THEN
    ALTER TABLE ai_content_plans
      ADD CONSTRAINT ai_content_plans_gateway_request_id_safe_check
      CHECK (gateway_request_id IS NULL OR (CHAR_LENGTH(gateway_request_id) BETWEEN 1 AND 240 AND gateway_request_id = BTRIM(gateway_request_id)));
  END IF;
END;
$$;
