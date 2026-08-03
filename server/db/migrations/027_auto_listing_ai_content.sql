CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_jobs_account_id_id_key
  ON auto_listing_jobs(account_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_jobs_account_id_strategy_key
  ON auto_listing_jobs(account_id, id, strategy_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_account_id_id_key
  ON auto_listing_job_items(account_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_account_job_id_id_key
  ON auto_listing_job_items(account_id, job_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_account_job_id_snapshot_key
  ON auto_listing_job_items(account_id, job_id, id, snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_source_snapshots_account_id_id_key
  ON auto_listing_source_snapshots(account_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_content_strategy_versions_account_id_id_key
  ON ai_content_strategy_versions(account_id, id);

CREATE TABLE IF NOT EXISTS ai_gateway_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_env_name TEXT NOT NULL,
  text_protocol TEXT NOT NULL
    CHECK (text_protocol IN ('SUB2API_RESPONSES')),
  image_protocol TEXT NOT NULL
    CHECK (image_protocol IN ('SUB2API_RESPONSES_IMAGE_TOOL', 'SUB2API_OPENAI_IMAGES')),
  text_model TEXT NOT NULL,
  image_model TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  capability_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  capability_checked_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, id, config_version)
);

CREATE TABLE IF NOT EXISTS ai_content_plans (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  strategy_version_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  strategy_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  planner_model TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  prompt_template_version TEXT NOT NULL,
  plan JSONB NOT NULL DEFAULT '{}'::JSONB,
  plan_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, item_id, input_hash),
  UNIQUE (account_id, job_id, item_id, id, profile_id, profile_version),
  FOREIGN KEY (account_id, job_id)
    REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, strategy_version_id)
    REFERENCES auto_listing_jobs(account_id, id, strategy_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, source_snapshot_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id, snapshot_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, source_snapshot_id)
    REFERENCES auto_listing_source_snapshots(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, strategy_version_id)
    REFERENCES ai_content_strategy_versions(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, profile_id, profile_version)
    REFERENCES ai_gateway_profiles(account_id, id, config_version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ai_generation_assets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  visual_group_key TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('MAIN', 'SELLING_POINT', 'DETAIL', 'SCENE', 'SPECIFICATION', 'INFOGRAPHIC')),
  input_hash TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'GENERATING', 'ACCEPTED', 'REJECTED', 'FAILED')),
  gateway_request_id TEXT,
  model_name TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  prompt_hash TEXT NOT NULL,
  object_key TEXT,
  content_hash TEXT,
  content_type TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  checker_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT,
  error_retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  CHECK (status <> 'ACCEPTED' OR (
    NULLIF(BTRIM(object_key), '') IS NOT NULL
    AND NULLIF(BTRIM(content_hash), '') IS NOT NULL
    AND NULLIF(BTRIM(content_type), '') IS NOT NULL
    AND width IS NOT NULL
    AND width > 0
    AND height IS NOT NULL
    AND height > 0
    AND jsonb_typeof(checker_result) = 'object'
    AND checker_result <> '{}'::JSONB
    AND accepted_at IS NOT NULL
  )),
  CHECK (status = 'ACCEPTED' OR accepted_at IS NULL),
  CHECK (status IN ('REJECTED', 'FAILED') OR (error_code IS NULL AND error_retryable IS NULL)),
  CHECK (status NOT IN ('REJECTED', 'FAILED') OR (
    NULLIF(BTRIM(error_code), '') IS NOT NULL AND error_retryable IS NOT NULL
  )),
  UNIQUE (item_id, slot_key, input_hash, attempt_no),
  FOREIGN KEY (account_id, job_id)
    REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, plan_id, profile_id, profile_version)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id, profile_id, profile_version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ai_rich_content_results (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  model_name TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  prompt_template_version TEXT NOT NULL,
  rich_content JSONB NOT NULL DEFAULT '{}'::JSONB,
  output_hash TEXT NOT NULL,
  checker_result JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'GENERATING', 'ACCEPTED', 'REJECTED', 'FAILED')),
  error_code TEXT,
  error_retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  CHECK (status <> 'ACCEPTED' OR (
    jsonb_typeof(rich_content) = 'object'
    AND rich_content <> '{}'::JSONB
    AND NULLIF(BTRIM(output_hash), '') IS NOT NULL
    AND NULLIF(BTRIM(source_hash), '') IS NOT NULL
    AND NULLIF(BTRIM(asset_hash), '') IS NOT NULL
    AND jsonb_typeof(checker_result) = 'object'
    AND checker_result <> '{}'::JSONB
    AND accepted_at IS NOT NULL
  )),
  CHECK (status = 'ACCEPTED' OR accepted_at IS NULL),
  CHECK (status IN ('REJECTED', 'FAILED') OR (error_code IS NULL AND error_retryable IS NULL)),
  CHECK (status NOT IN ('REJECTED', 'FAILED') OR (
    NULLIF(BTRIM(error_code), '') IS NOT NULL AND error_retryable IS NOT NULL
  )),
  UNIQUE (item_id, input_hash, attempt_no),
  FOREIGN KEY (account_id, job_id)
    REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, plan_id, profile_id, profile_version)
    REFERENCES ai_content_plans(account_id, job_id, item_id, id, profile_id, profile_version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS auto_listing_ai_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  slot_key TEXT,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'LEASED', 'SUCCEEDED', 'DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((state = 'LEASED'
    AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
    AND lease_expires_at IS NOT NULL)
    OR (state <> 'LEASED'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL)),
  FOREIGN KEY (account_id, job_id)
    REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id)
    REFERENCES auto_listing_job_items(account_id, job_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION auto_listing_reject_ai_content_plan_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI content plans are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_protect_referenced_ai_gateway_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ai_content_plans
    WHERE account_id = OLD.account_id
      AND profile_id = OLD.id
      AND profile_version = OLD.config_version
  ) AND (
    NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.base_url IS DISTINCT FROM OLD.base_url
    OR NEW.api_key_env_name IS DISTINCT FROM OLD.api_key_env_name
    OR NEW.text_protocol IS DISTINCT FROM OLD.text_protocol
    OR NEW.image_protocol IS DISTINCT FROM OLD.image_protocol
    OR NEW.text_model IS DISTINCT FROM OLD.text_model
    OR NEW.image_model IS DISTINCT FROM OLD.image_model
    OR NEW.config_version IS DISTINCT FROM OLD.config_version
  ) THEN
    RAISE EXCEPTION 'referenced AI gateway profile configuration is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_reject_terminal_generation_asset_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('ACCEPTED', 'REJECTED', 'FAILED') THEN
    RAISE EXCEPTION 'terminal AI generation assets are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_reject_terminal_rich_content_result_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('ACCEPTED', 'REJECTED', 'FAILED') THEN
    RAISE EXCEPTION 'terminal AI rich-content results are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'ai_gateway_profiles_referenced_config_immutable'
      AND tgrelid = 'ai_gateway_profiles'::regclass
  ) THEN
    CREATE TRIGGER ai_gateway_profiles_referenced_config_immutable
    BEFORE UPDATE ON ai_gateway_profiles
    FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_referenced_ai_gateway_profile();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'ai_content_plans_immutable'
      AND tgrelid = 'ai_content_plans'::regclass
  ) THEN
    CREATE TRIGGER ai_content_plans_immutable
    BEFORE UPDATE OR DELETE ON ai_content_plans
    FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_ai_content_plan_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'ai_generation_assets_terminal_immutable'
      AND tgrelid = 'ai_generation_assets'::regclass
  ) THEN
    CREATE TRIGGER ai_generation_assets_terminal_immutable
    BEFORE UPDATE OR DELETE ON ai_generation_assets
    FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_terminal_generation_asset_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'ai_rich_content_results_terminal_immutable'
      AND tgrelid = 'ai_rich_content_results'::regclass
  ) THEN
    CREATE TRIGGER ai_rich_content_results_terminal_immutable
    BEFORE UPDATE OR DELETE ON ai_rich_content_results
    FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_terminal_rich_content_result_mutation();
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_generation_assets_accepted_slot_input_key
  ON ai_generation_assets(item_id, slot_key, input_hash)
  WHERE status = 'ACCEPTED';
CREATE UNIQUE INDEX IF NOT EXISTS ai_rich_content_results_accepted_item_input_key
  ON ai_rich_content_results(item_id, input_hash)
  WHERE status = 'ACCEPTED';
CREATE INDEX IF NOT EXISTS ai_generation_assets_item_status_idx
  ON ai_generation_assets(account_id, item_id, status, created_at);
CREATE INDEX IF NOT EXISTS ai_rich_content_results_item_status_idx
  ON ai_rich_content_results(account_id, item_id, status, created_at);
CREATE INDEX IF NOT EXISTS auto_listing_ai_outbox_pending_available_idx
  ON auto_listing_ai_outbox(available_at, created_at)
  WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS auto_listing_ai_outbox_lease_expiry_idx
  ON auto_listing_ai_outbox(lease_expires_at)
  WHERE state = 'LEASED';
