-- Persist account-bound category-strategy sampling evidence.  Every scoped
-- child carries the exact Ozon taxonomy identity; no store identity is used.

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  draft_version BIGINT NOT NULL CHECK (draft_version > 0),
  status TEXT NOT NULL CHECK (status IN (
    'COLLECTING','SAMPLES_READY','ANALYZING','DRAFT_READY','PUBLISHED','NEEDS_REVIEW'
  )),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(updated_at)),
  ended_at TIMESTAMPTZ CHECK (ended_at IS NULL OR ISFINITE(ended_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,id,taxonomy_scope,description_category_id,type_id),
  UNIQUE (account_id,idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_category_strategy_one_open_draft_per_scope
  ON auto_listing_category_strategy_drafts(account_id,taxonomy_scope,description_category_id,type_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_account_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'LEGACY_FALLBACK' CHECK (mode IN ('LEGACY_FALLBACK','REQUIRE_EXACT_STRATEGY')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(updated_at)),
  UNIQUE (account_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_sampling_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  expires_at TIMESTAMPTZ NOT NULL CHECK (ISFINITE(expires_at)),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id)
    REFERENCES auto_listing_category_strategy_drafts(account_id,id,taxonomy_scope,description_category_id,type_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_sample_sets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  session_id TEXT NOT NULL,
  sample_set_hash TEXT NOT NULL CHECK (sample_set_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_hash),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id)
    REFERENCES auto_listing_category_strategy_drafts(account_id,id,taxonomy_scope,description_category_id,type_id)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id)
    REFERENCES auto_listing_category_strategy_sampling_sessions(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_samples (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  sample_set_id TEXT NOT NULL,
  sku TEXT NOT NULL CHECK (NULLIF(BTRIM(sku),'') IS NOT NULL),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,id),
  UNIQUE (account_id,sample_set_id,sku),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id)
    REFERENCES auto_listing_category_strategy_sample_sets(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_sample_images (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  sample_set_id TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  image_id TEXT NOT NULL CHECK (NULLIF(BTRIM(image_id),'') IS NOT NULL),
  role TEXT NOT NULL CHECK (role IN ('MAIN','DETAIL')),
  ordinal INTEGER NOT NULL CHECK ((role='MAIN' AND ordinal=0) OR (role='DETAIL' AND ordinal>0)),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,sample_id,role,ordinal),
  UNIQUE (account_id,sample_id,image_id),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id)
    REFERENCES auto_listing_category_strategy_samples(account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_analysis_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  sample_set_id TEXT NOT NULL,
  sample_set_hash TEXT NOT NULL CHECK (sample_set_hash ~ '^[a-f0-9]{64}$'),
  analysis_input_hash TEXT NOT NULL CHECK (analysis_input_hash ~ '^[a-f0-9]{64}$'),
  model_config_snapshot JSONB NOT NULL CHECK (JSONB_TYPEOF(model_config_snapshot)='object'),
  model_config_hash TEXT NOT NULL CHECK (model_config_hash ~ '^[a-f0-9]{64}$'),
  cost_confirmed BOOLEAN NOT NULL CHECK (cost_confirmed=TRUE),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,sample_set_hash,analysis_input_hash),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_set_hash)
    REFERENCES auto_listing_category_strategy_sample_sets(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_hash)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_analysis_results (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  attempt_id TEXT NOT NULL,
  sample_set_id TEXT NOT NULL,
  sample_set_hash TEXT NOT NULL CHECK (sample_set_hash ~ '^[a-f0-9]{64}$'),
  analysis_input_hash TEXT NOT NULL CHECK (analysis_input_hash ~ '^[a-f0-9]{64}$'),
  raw_response JSONB NOT NULL CHECK (JSONB_TYPEOF(raw_response)='object'),
  raw_response_hash TEXT NOT NULL CHECK (raw_response_hash ~ '^[a-f0-9]{64}$'),
  guidance JSONB NOT NULL CHECK (JSONB_TYPEOF(guidance)='object'),
  guidance_hash TEXT NOT NULL CHECK (guidance_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,attempt_id),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,sample_set_hash,analysis_input_hash)
    REFERENCES auto_listing_category_strategy_analysis_attempts(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,sample_set_hash,analysis_input_hash)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT,
  taxonomy_scope TEXT,
  description_category_id BIGINT,
  type_id BIGINT,
  event_type TEXT NOT NULL CHECK (event_type IN ('ACCOUNT_SETTINGS_CHANGED','PUBLISHED','DRAFT_EVENT')),
  settings_version BIGINT,
  analysis_result_id TEXT,
  published_strategy_version_id TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (JSONB_TYPEOF(event_payload)='object'),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,idempotency_key),
  CHECK (
    (event_type='ACCOUNT_SETTINGS_CHANGED' AND draft_id IS NULL AND taxonomy_scope IS NULL
      AND description_category_id IS NULL AND type_id IS NULL AND settings_version IS NOT NULL
      AND analysis_result_id IS NULL AND published_strategy_version_id IS NULL)
    OR (event_type='PUBLISHED' AND draft_id IS NOT NULL AND taxonomy_scope='OZON:DEFAULT'
      AND description_category_id > 0 AND type_id > 0 AND settings_version IS NULL
      AND analysis_result_id IS NOT NULL AND published_strategy_version_id IS NOT NULL)
    OR (event_type='DRAFT_EVENT' AND draft_id IS NOT NULL AND taxonomy_scope='OZON:DEFAULT'
      AND description_category_id > 0 AND type_id > 0 AND settings_version IS NULL
      AND analysis_result_id IS NULL AND published_strategy_version_id IS NULL)
  ),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id)
    REFERENCES auto_listing_category_strategy_drafts(account_id,id,taxonomy_scope,description_category_id,type_id)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id,analysis_result_id)
    REFERENCES auto_listing_category_strategy_analysis_results(account_id,id)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id,published_strategy_version_id)
    REFERENCES ai_content_strategy_versions(account_id,id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_reject_expired_session()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at <= STATEMENT_TIMESTAMP() THEN
    RAISE EXCEPTION 'sampling session must expire after database time' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_session_database_expiry
BEFORE INSERT OR UPDATE ON auto_listing_category_strategy_sampling_sessions
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_reject_expired_session();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_sample_image_ordinal_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  next_detail_ordinal INTEGER;
BEGIN
  IF NEW.role='MAIN' THEN
    IF NEW.ordinal<>0 THEN
      RAISE EXCEPTION 'main image ordinal must be zero' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM auto_listing_category_strategy_sample_images image
       WHERE image.account_id=NEW.account_id AND image.sample_id=NEW.sample_id
         AND image.role='MAIN' AND image.ordinal=0
    ) THEN
      RAISE EXCEPTION 'detail images require an immutable main image' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(MAX(image.ordinal),0)+1 INTO next_detail_ordinal
      FROM auto_listing_category_strategy_sample_images image
     WHERE image.account_id=NEW.account_id AND image.sample_id=NEW.sample_id AND image.role='DETAIL';
    IF NEW.ordinal<>next_detail_ordinal THEN
      RAISE EXCEPTION 'detail image ordinals must be contiguous' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_sample_image_ordinal
BEFORE INSERT ON auto_listing_category_strategy_sample_images
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_sample_image_ordinal_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- A direct evidence mutation is never valid.  A draft/account cascade has
  -- trigger depth above one and is the deliberate parent-only cleanup path.
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'category strategy evidence is append only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_sample_set_append_only
BEFORE UPDATE OR DELETE ON auto_listing_category_strategy_sample_sets
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_session_parent_cleanup_only
BEFORE DELETE ON auto_listing_category_strategy_sampling_sessions
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_sample_append_only
BEFORE UPDATE OR DELETE ON auto_listing_category_strategy_samples
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_sample_image_append_only
BEFORE UPDATE OR DELETE ON auto_listing_category_strategy_sample_images
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_analysis_attempt_append_only
BEFORE UPDATE OR DELETE ON auto_listing_category_strategy_analysis_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_analysis_result_append_only
BEFORE UPDATE OR DELETE ON auto_listing_category_strategy_analysis_results
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_event_append_only
BEFORE UPDATE OR DELETE ON auto_listing_category_strategy_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE TRIGGER auto_listing_category_strategy_settings_parent_cleanup_only
BEFORE DELETE ON auto_listing_category_strategy_account_settings
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_append_only();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_settings_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.version<>OLD.version+1
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'category strategy setting identity is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO auto_listing_category_strategy_events (
    id,account_id,event_type,settings_version,event_payload,idempotency_key,
    correlation_id,request_hash,actor_account_id
  ) VALUES (
    'category-strategy-settings:' || NEW.account_id || ':' || NEW.version,
    NEW.account_id,'ACCOUNT_SETTINGS_CHANGED',NEW.version,
    JSONB_BUILD_OBJECT('mode',NEW.mode),
    NEW.idempotency_key || ':audit:' || NEW.version,
    NEW.correlation_id,NEW.request_hash,NEW.actor_account_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_settings_audit_event
AFTER INSERT OR UPDATE ON auto_listing_category_strategy_account_settings
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_settings_audit();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_create_default_settings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auto_listing_category_strategy_account_settings (
    account_id,idempotency_key,correlation_id,request_hash,actor_account_id
  ) VALUES (
    NEW.id,'category-strategy-settings-bootstrap:' || NEW.id,
    'category-strategy-settings-bootstrap:' || NEW.id,
    REPEAT('0',64),NEW.id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_account_default_settings
AFTER INSERT ON accounts
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_create_default_settings();

INSERT INTO auto_listing_category_strategy_account_settings (
  account_id,idempotency_key,correlation_id,request_hash,actor_account_id
)
SELECT account.id,
  'category-strategy-settings-bootstrap:' || account.id,
  'category-strategy-settings-bootstrap:' || account.id,
  REPEAT('0',64),account.id
FROM accounts account
ON CONFLICT (account_id) DO NOTHING;
