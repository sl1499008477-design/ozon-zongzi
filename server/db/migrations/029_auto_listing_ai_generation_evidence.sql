ALTER TABLE ai_generation_assets
  ADD COLUMN IF NOT EXISTS plan_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_hash TEXT,
  ADD COLUMN IF NOT EXISTS strategy_hash TEXT,
  ADD COLUMN IF NOT EXISTS config_hash TEXT,
  ADD COLUMN IF NOT EXISTS visual_groups_hash TEXT,
  ADD COLUMN IF NOT EXISTS prompt_template_version TEXT,
  ADD COLUMN IF NOT EXISTS source_asset_evidence JSONB,
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

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
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_lease_status_check CHECK (lease_token IS NULL OR status = 'GENERATING');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ai_generation_assets_accepted_plan_input_idx
  ON ai_generation_assets(account_id, plan_id, input_hash)
  WHERE status = 'ACCEPTED';

CREATE INDEX IF NOT EXISTS ai_generation_assets_active_lease_idx
  ON ai_generation_assets(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash, lease_expires_at)
  WHERE status = 'GENERATING' AND lease_token IS NOT NULL;
