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
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_identity_hash TEXT,
  ADD COLUMN IF NOT EXISTS generation_size TEXT,
  ADD COLUMN IF NOT EXISTS final_input_bound_at TIMESTAMPTZ;

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
      (status = 'GENERATING' AND NULLIF(BTRIM(lease_token), '') IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'GENERATING' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_attempt_binding_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_attempt_binding_check CHECK (
      (status = 'PENDING' AND attempt_identity_hash IS NULL AND generation_size IS NULL AND final_input_bound_at IS NULL)
      OR (
        attempt_identity_hash IS NOT NULL AND attempt_identity_hash ~ '^[a-f0-9]{64}$'
        AND generation_size IS NOT NULL AND generation_size ~ '^[1-9][0-9]*x[1-9][0-9]*$'
        AND (
          (final_input_bound_at IS NULL AND input_hash = attempt_identity_hash AND status IN ('GENERATING', 'FAILED'))
          OR (final_input_bound_at IS NOT NULL AND input_hash ~ '^[a-f0-9]{64}$')
        )
        AND (status NOT IN ('ACCEPTED', 'REJECTED') OR final_input_bound_at IS NOT NULL)
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_generation_assets_new_accepted_evidence_check' AND conrelid = 'ai_generation_assets'::regclass) THEN
    ALTER TABLE ai_generation_assets ADD CONSTRAINT ai_generation_assets_new_accepted_evidence_check CHECK (
      status <> 'ACCEPTED' OR (
        input_hash ~ '^[a-f0-9]{64}$'
        AND attempt_identity_hash IS NOT NULL AND attempt_identity_hash ~ '^[a-f0-9]{64}$'
        AND generation_size IS NOT NULL AND generation_size ~ '^[1-9][0-9]*x[1-9][0-9]*$'
        AND final_input_bound_at IS NOT NULL
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

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_attempt_identity_attempt_key
  ON ai_generation_assets(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, attempt_identity_hash, attempt_no)
  WHERE attempt_identity_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_active_attempt_identity_key
  ON ai_generation_assets(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, attempt_identity_hash)
  WHERE status = 'GENERATING';

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_bound_input_key
  ON ai_generation_assets(account_id, job_id, item_id, plan_id, visual_group_key, slot_key, input_hash)
  WHERE status = 'ACCEPTED' OR (status = 'GENERATING' AND final_input_bound_at IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS ai_content_plans_account_job_item_id_key
  ON ai_content_plans(account_id, job_id, item_id, id);

CREATE TABLE IF NOT EXISTS auto_listing_asset_cleanup_obligations (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  visual_group_key TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  attempt_identity_hash TEXT NOT NULL CHECK (attempt_identity_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL,
  original_error_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  CHECK (NULLIF(BTRIM(id), '') IS NOT NULL AND LENGTH(id) <= 240 AND id !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(job_id), '') IS NOT NULL AND LENGTH(job_id) <= 240 AND job_id !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(item_id), '') IS NOT NULL AND LENGTH(item_id) <= 240 AND item_id !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(plan_id), '') IS NOT NULL AND LENGTH(plan_id) <= 240 AND plan_id !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(visual_group_key), '') IS NOT NULL AND LENGTH(visual_group_key) <= 240 AND visual_group_key !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(slot_key), '') IS NOT NULL AND LENGTH(slot_key) <= 240 AND slot_key !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(object_key), '') IS NOT NULL AND object_key !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL AND LENGTH(reason) <= 240 AND reason !~ '[[:cntrl:]]'),
  CHECK (NULLIF(BTRIM(original_error_code), '') IS NOT NULL AND LENGTH(original_error_code) <= 240 AND original_error_code !~ '[[:cntrl:]]'),
  UNIQUE (account_id, object_key),
  FOREIGN KEY (account_id, job_id, item_id, plan_id)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS auto_listing_asset_cleanup_pending_idx
  ON auto_listing_asset_cleanup_obligations(account_id, status, next_retry_at, id);
