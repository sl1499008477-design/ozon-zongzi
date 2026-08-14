-- Account-bound category-strategy sampling evidence. A sample set is editable
-- only while BUILDING; the database validates and hashes the complete aggregate
-- during the single BUILDING -> SEALED update.

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_drafts (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  draft_version BIGINT NOT NULL CHECK (draft_version>0),
  status TEXT NOT NULL CHECK (status IN (
    'COLLECTING','SAMPLES_READY','ANALYZING','DRAFT_READY','PUBLISHED','NEEDS_REVIEW'
  )),
  source_collect_item_id TEXT NOT NULL,
  source_product_draft_id TEXT NOT NULL,
  source_product_draft_version INTEGER NOT NULL CHECK (source_product_draft_version>0),
  expected_source_version TEXT NOT NULL CHECK (
    expected_source_version='draft:' || source_product_draft_version::TEXT
  ),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(updated_at)),
  ended_at TIMESTAMPTZ CHECK (ended_at IS NULL OR ISFINITE(ended_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,id,taxonomy_scope,description_category_id,type_id),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  FOREIGN KEY (account_id,source_collect_item_id)
    REFERENCES collect_items(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (source_collect_item_id,source_product_draft_id,source_product_draft_version)
    REFERENCES product_drafts(collect_item_id,id,version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_category_strategy_one_open_draft_per_scope
  ON auto_listing_category_strategy_drafts(account_id,taxonomy_scope,description_category_id,type_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_account_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'LEGACY_FALLBACK' CHECK (mode IN ('LEGACY_FALLBACK','REQUIRE_EXACT_STRATEGY')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version>0),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(updated_at)),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id)
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_sampling_sessions (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  session_secret_hash TEXT NOT NULL CHECK (session_secret_hash~'^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','CANCELLED')),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (STATEMENT_TIMESTAMP()+INTERVAL '2 hours') CHECK (ISFINITE(expires_at)),
  cancelled_at TIMESTAMPTZ CHECK (cancelled_at IS NULL OR ISFINITE(cancelled_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  CHECK (expires_at=created_at+INTERVAL '2 hours'),
  CHECK ((state='ACTIVE' AND cancelled_at IS NULL) OR (state='CANCELLED' AND cancelled_at IS NOT NULL)),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id)
    REFERENCES auto_listing_category_strategy_drafts(account_id,id,taxonomy_scope,description_category_id,type_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_sample_sets (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BUILDING' CHECK (status IN ('BUILDING','SEALED')),
  sample_set_hash TEXT CHECK (sample_set_hash IS NULL OR sample_set_hash~'^[a-f0-9]{64}$'),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count BETWEEN 0 AND 20),
  sealed_at TIMESTAMPTZ CHECK (sealed_at IS NULL OR ISFINITE(sealed_at)),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_hash,status),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  CHECK (
    (status='BUILDING' AND sample_set_hash IS NULL AND sample_count=0 AND sealed_at IS NULL)
    OR (status='SEALED' AND sample_set_hash IS NOT NULL AND sample_count BETWEEN 5 AND 20 AND sealed_at IS NOT NULL)
  ),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id)
    REFERENCES auto_listing_category_strategy_drafts(account_id,id,taxonomy_scope,description_category_id,type_id)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,session_id)
    REFERENCES auto_listing_category_strategy_sampling_sessions(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_samples (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  sample_set_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9999),
  sku TEXT NOT NULL CHECK (NULLIF(BTRIM(sku),'') IS NOT NULL AND OCTET_LENGTH(sku)<=240),
  source_product_id BIGINT NOT NULL CHECK (source_product_id>0),
  source_product_ref TEXT NOT NULL CHECK (source_product_ref~'^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$'),
  source_product_response_hash TEXT NOT NULL CHECK (source_product_response_hash~'^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,id),
  UNIQUE (account_id,sample_set_id,ordinal),
  UNIQUE (account_id,sample_set_id,sku),
  UNIQUE (account_id,sample_set_id,source_product_id),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id)
    REFERENCES auto_listing_category_strategy_sample_sets(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_sample_images (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  sample_set_id TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  image_id TEXT NOT NULL CHECK (image_id~'^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$'),
  role TEXT NOT NULL CHECK (role IN ('MAIN','DETAIL')),
  ordinal INTEGER NOT NULL CHECK ((role='MAIN' AND ordinal=0) OR (role='DETAIL' AND ordinal BETWEEN 1 AND 5)),
  source_url_host TEXT NOT NULL CHECK (
    OCTET_LENGTH(source_url_host)<=253 AND source_url_host~'^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
  ),
  source_ref_hash TEXT NOT NULL CHECK (source_ref_hash~'^[a-f0-9]{64}$'),
  source_response_hash TEXT NOT NULL CHECK (source_response_hash~'^[a-f0-9]{64}$'),
  source_content_hash TEXT NOT NULL CHECK (source_content_hash~'^[a-f0-9]{64}$'),
  analysis_object_key TEXT NOT NULL CHECK (
    OCTET_LENGTH(analysis_object_key)<=1024 AND POSITION('..' IN analysis_object_key)=0
    AND analysis_object_key~'^[A-Za-z0-9._/-]+$'
    AND LEFT(analysis_object_key,CHAR_LENGTH('category-strategy/'||account_id||'/'||draft_id||'/'||sample_set_id||'/'||sample_id||'/'))
      ='category-strategy/'||account_id||'/'||draft_id||'/'||sample_set_id||'/'||sample_id||'/'
  ),
  analysis_content_hash TEXT NOT NULL CHECK (analysis_content_hash~'^[a-f0-9]{64}$'),
  thumbnail_object_key TEXT NOT NULL CHECK (
    OCTET_LENGTH(thumbnail_object_key)<=1024 AND POSITION('..' IN thumbnail_object_key)=0
    AND thumbnail_object_key~'^[A-Za-z0-9._/-]+$'
    AND LEFT(thumbnail_object_key,CHAR_LENGTH('category-strategy/'||account_id||'/'||draft_id||'/'||sample_set_id||'/'||sample_id||'/'))
      ='category-strategy/'||account_id||'/'||draft_id||'/'||sample_set_id||'/'||sample_id||'/'
  ),
  thumbnail_content_hash TEXT NOT NULL CHECK (thumbnail_content_hash~'^[a-f0-9]{64}$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 16384),
  captured_at TIMESTAMPTZ NOT NULL CHECK (ISFINITE(captured_at)),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,sample_id,role,ordinal),
  UNIQUE (account_id,sample_id,image_id),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_id)
    REFERENCES auto_listing_category_strategy_samples(account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_analysis_attempts (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  sample_set_id TEXT NOT NULL,
  sample_set_hash TEXT NOT NULL CHECK (sample_set_hash~'^[a-f0-9]{64}$'),
  sample_set_status TEXT NOT NULL DEFAULT 'SEALED' CHECK (sample_set_status='SEALED'),
  analysis_input_hash TEXT NOT NULL CHECK (analysis_input_hash~'^[a-f0-9]{64}$'),
  model_config_snapshot JSONB NOT NULL CHECK (JSONB_TYPEOF(model_config_snapshot)='object' AND OCTET_LENGTH(model_config_snapshot::TEXT)<=65536),
  model_config_hash TEXT NOT NULL CHECK (model_config_hash~'^[a-f0-9]{64}$'),
  cost_confirmed BOOLEAN NOT NULL CHECK (cost_confirmed=TRUE),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,sample_set_hash,analysis_input_hash),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,sample_set_id,sample_set_hash,sample_set_status)
    REFERENCES auto_listing_category_strategy_sample_sets(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_hash,status)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_analysis_results (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  description_category_id BIGINT NOT NULL CHECK (description_category_id>0),
  type_id BIGINT NOT NULL CHECK (type_id>0),
  attempt_id TEXT NOT NULL,
  sample_set_id TEXT NOT NULL,
  sample_set_hash TEXT NOT NULL CHECK (sample_set_hash~'^[a-f0-9]{64}$'),
  analysis_input_hash TEXT NOT NULL CHECK (analysis_input_hash~'^[a-f0-9]{64}$'),
  raw_response JSONB NOT NULL CHECK (JSONB_TYPEOF(raw_response)='object' AND OCTET_LENGTH(raw_response::TEXT)<=4194304),
  raw_response_hash TEXT NOT NULL CHECK (raw_response_hash~'^[a-f0-9]{64}$'),
  guidance JSONB NOT NULL CHECK (JSONB_TYPEOF(guidance)='object' AND OCTET_LENGTH(guidance::TEXT)<=1048576),
  guidance_hash TEXT NOT NULL CHECK (guidance_hash~'^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,draft_id,taxonomy_scope,description_category_id,type_id,id),
  UNIQUE (account_id,attempt_id),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,attempt_id,sample_set_id,sample_set_hash,analysis_input_hash)
    REFERENCES auto_listing_category_strategy_analysis_attempts(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id,sample_set_id,sample_set_hash,analysis_input_hash)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_listing_category_strategy_events (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=512),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT,
  taxonomy_scope TEXT,
  description_category_id BIGINT,
  type_id BIGINT,
  event_type TEXT NOT NULL CHECK (event_type IN ('ACCOUNT_SETTINGS_CHANGED','PUBLISHED','DRAFT_EVENT')),
  settings_version BIGINT,
  analysis_result_id TEXT,
  published_strategy_version_id TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (JSONB_TYPEOF(event_payload)='object' AND OCTET_LENGTH(event_payload::TEXT)<=65536),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240),
  request_hash TEXT NOT NULL CHECK (request_hash~'^[a-f0-9]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,idempotency_key),
  CHECK (actor_account_id=account_id),
  CHECK (
    (event_type='ACCOUNT_SETTINGS_CHANGED' AND draft_id IS NULL AND taxonomy_scope IS NULL
      AND description_category_id IS NULL AND type_id IS NULL AND settings_version IS NOT NULL
      AND analysis_result_id IS NULL AND published_strategy_version_id IS NULL)
    OR (event_type='PUBLISHED' AND draft_id IS NOT NULL AND taxonomy_scope='OZON:DEFAULT'
      AND description_category_id>0 AND type_id>0 AND settings_version IS NULL
      AND analysis_result_id IS NOT NULL AND published_strategy_version_id IS NOT NULL)
    OR (event_type='DRAFT_EVENT' AND draft_id IS NOT NULL AND taxonomy_scope='OZON:DEFAULT'
      AND description_category_id>0 AND type_id>0 AND settings_version IS NULL
      AND analysis_result_id IS NULL AND published_strategy_version_id IS NULL)
  ),
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id)
    REFERENCES auto_listing_category_strategy_drafts(account_id,id,taxonomy_scope,description_category_id,type_id)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id,draft_id,taxonomy_scope,description_category_id,type_id,analysis_result_id)
    REFERENCES auto_listing_category_strategy_analysis_results(account_id,draft_id,taxonomy_scope,description_category_id,type_id,id)
    ON DELETE CASCADE,
  FOREIGN KEY (account_id,published_strategy_version_id)
    REFERENCES ai_content_strategy_versions(account_id,id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_draft_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.status='PUBLISHED'
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_sample_sets WHERE account_id=OLD.account_id AND draft_id=OLD.id AND status='SEALED')
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_analysis_attempts WHERE account_id=OLD.account_id AND draft_id=OLD.id)
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_analysis_results WHERE account_id=OLD.account_id AND draft_id=OLD.id)
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_events WHERE account_id=OLD.account_id AND draft_id=OLD.id)
    THEN
      RAISE EXCEPTION 'draft with immutable evidence cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE' AND ROW(
    NEW.id,NEW.account_id,NEW.taxonomy_scope,NEW.description_category_id,NEW.type_id,
    NEW.source_collect_item_id,NEW.source_product_draft_id,NEW.source_product_draft_version,
    NEW.expected_source_version,NEW.idempotency_key,NEW.request_hash,NEW.actor_account_id,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.taxonomy_scope,OLD.description_category_id,OLD.type_id,
    OLD.source_collect_item_id,OLD.source_product_draft_id,OLD.source_product_draft_version,
    OLD.expected_source_version,OLD.idempotency_key,OLD.request_hash,OLD.actor_account_id,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'draft source identity is immutable' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM collect_items item
    JOIN product_drafts product_draft
      ON product_draft.collect_item_id=item.id
     AND product_draft.id=item.current_draft_id
     AND product_draft.version=NEW.source_product_draft_version
   WHERE item.account_id=NEW.account_id
     AND item.id=NEW.source_collect_item_id
     AND product_draft.id=NEW.source_product_draft_id
     AND NEW.expected_source_version='draft:' || product_draft.version::TEXT
  ) THEN
    RAISE EXCEPTION 'draft source is not the exact current tenant draft' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_draft_integrity
BEFORE INSERT OR UPDATE OR DELETE ON auto_listing_category_strategy_drafts
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_draft_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_session_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'sampling session cleanup requires its parent' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'ACTIVE' OR NEW.cancelled_at IS NOT NULL
      OR NEW.created_at<>STATEMENT_TIMESTAMP()
      OR NEW.expires_at<>NEW.created_at+INTERVAL '2 hours' THEN
      RAISE EXCEPTION 'sampling session lifetime is database fixed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.id,NEW.account_id,NEW.draft_id,NEW.taxonomy_scope,NEW.description_category_id,NEW.type_id,
    NEW.session_secret_hash,NEW.idempotency_key,NEW.correlation_id,NEW.request_hash,
    NEW.actor_account_id,NEW.created_at,NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.draft_id,OLD.taxonomy_scope,OLD.description_category_id,OLD.type_id,
    OLD.session_secret_hash,OLD.idempotency_key,OLD.correlation_id,OLD.request_hash,
    OLD.actor_account_id,OLD.created_at,OLD.expires_at
  ) OR OLD.state<>'ACTIVE' OR NEW.state<>'CANCELLED' THEN
    RAISE EXCEPTION 'sampling session identity or lifetime is immutable' USING ERRCODE='23514';
  END IF;
  NEW.cancelled_at=STATEMENT_TIMESTAMP();
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_session_integrity
BEFORE INSERT OR UPDATE OR DELETE ON auto_listing_category_strategy_sampling_sessions
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_session_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_canonical_sample_set_hash(
  owner_account_id TEXT,
  owner_sample_set_id TEXT
)
RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT ENCODE(SHA256(CONVERT_TO(COALESCE(STRING_AGG(
    LPAD(sample.ordinal::TEXT,4,'0') || ':'
      || ENCODE(SHA256(CONVERT_TO(sample.sku,'UTF8')),'hex') || ':'
      || COALESCE((
        SELECT STRING_AGG(
          LPAD(image.ordinal::TEXT,2,'0') || ':' || image.role || ':' || image.image_id,
          ',' ORDER BY image.ordinal
        )
        FROM auto_listing_category_strategy_sample_images image
        WHERE image.account_id=sample.account_id AND image.sample_id=sample.id
      ),''),
    E'\n' ORDER BY sample.ordinal
  ),''),'UTF8')),'hex')
  FROM auto_listing_category_strategy_samples sample
  WHERE sample.account_id=owner_account_id AND sample.sample_set_id=owner_sample_set_id
$$;

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_sample_set_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actual_count INTEGER;
  actual_hash TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'sample set is append only' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'BUILDING' OR NEW.sample_set_hash IS NOT NULL OR NEW.sample_count<>0 OR NEW.sealed_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM auto_listing_category_strategy_sampling_sessions session
         WHERE session.account_id=NEW.account_id AND session.draft_id=NEW.draft_id
           AND session.taxonomy_scope=NEW.taxonomy_scope
           AND session.description_category_id=NEW.description_category_id AND session.type_id=NEW.type_id
           AND session.id=NEW.session_id AND session.state='ACTIVE'
           AND session.expires_at>STATEMENT_TIMESTAMP()
      ) THEN
      RAISE EXCEPTION 'sample set requires an active unexpired exact session' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.id,NEW.account_id,NEW.draft_id,NEW.taxonomy_scope,NEW.description_category_id,NEW.type_id,
    NEW.session_id,NEW.idempotency_key,NEW.correlation_id,NEW.request_hash,NEW.actor_account_id,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.draft_id,OLD.taxonomy_scope,OLD.description_category_id,OLD.type_id,
    OLD.session_id,OLD.idempotency_key,OLD.correlation_id,OLD.request_hash,OLD.actor_account_id,OLD.created_at
  ) OR OLD.status<>'BUILDING' OR NEW.status<>'SEALED' THEN
    RAISE EXCEPTION 'sample set transition is invalid' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*)::INTEGER INTO actual_count
    FROM auto_listing_category_strategy_samples sample
   WHERE sample.account_id=OLD.account_id AND sample.sample_set_id=OLD.id;
  IF actual_count NOT BETWEEN 5 AND 20 OR EXISTS (
    SELECT 1 FROM auto_listing_category_strategy_samples sample
     WHERE sample.account_id=OLD.account_id AND sample.sample_set_id=OLD.id
       AND (
         (SELECT COUNT(*) FROM auto_listing_category_strategy_sample_images image
           WHERE image.account_id=sample.account_id AND image.sample_id=sample.id AND image.role='MAIN')<>1
         OR (SELECT COUNT(*) FROM auto_listing_category_strategy_sample_images image
           WHERE image.account_id=sample.account_id AND image.sample_id=sample.id AND image.role='DETAIL')>5
         OR COALESCE((SELECT MAX(image.ordinal) FROM auto_listing_category_strategy_sample_images image
           WHERE image.account_id=sample.account_id AND image.sample_id=sample.id AND image.role='DETAIL'),0)
           <>(SELECT COUNT(*) FROM auto_listing_category_strategy_sample_images image
           WHERE image.account_id=sample.account_id AND image.sample_id=sample.id AND image.role='DETAIL')
       )
  ) THEN
    RAISE EXCEPTION 'sample set is incomplete' USING ERRCODE='23514';
  END IF;
  actual_hash=auto_listing_category_strategy_canonical_sample_set_hash(OLD.account_id,OLD.id);
  IF NEW.sample_set_hash IS DISTINCT FROM actual_hash THEN
    RAISE EXCEPTION 'sample set canonical hash mismatch' USING ERRCODE='23514';
  END IF;
  NEW.sample_count=actual_count;
  NEW.sealed_at=STATEMENT_TIMESTAMP();
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_sample_set_integrity
BEFORE INSERT OR UPDATE OR DELETE ON auto_listing_category_strategy_sample_sets
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_sample_set_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_sample_insert_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  sample_set_status TEXT;
BEGIN
  SELECT sample_set.status INTO sample_set_status
    FROM auto_listing_category_strategy_sample_sets sample_set
   WHERE sample_set.account_id=NEW.account_id AND sample_set.id=NEW.sample_set_id
   FOR UPDATE;
  IF sample_set_status='SEALED' THEN
    RAISE EXCEPTION 'sealed sample set rejects new samples' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auto_listing_category_strategy_samples sample
     WHERE sample.account_id=NEW.account_id AND sample.sample_set_id=NEW.sample_set_id
       AND (sample.sku=NEW.sku OR sample.ordinal=NEW.ordinal OR sample.source_product_id=NEW.source_product_id)
  ) THEN
    RAISE EXCEPTION 'sample set identities must be unique' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_sample_insert
BEFORE INSERT ON auto_listing_category_strategy_samples
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_sample_insert_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_sample_image_insert_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  next_detail_ordinal INTEGER;
  sample_set_status TEXT;
BEGIN
  SELECT sample_set.status INTO sample_set_status
    FROM auto_listing_category_strategy_sample_sets sample_set
   WHERE sample_set.account_id=NEW.account_id AND sample_set.id=NEW.sample_set_id
   FOR UPDATE;
  IF sample_set_status='SEALED' THEN
    RAISE EXCEPTION 'sealed sample set rejects new images' USING ERRCODE='23514';
  END IF;
  IF NEW.role='MAIN' THEN
    IF NEW.ordinal<>0 OR EXISTS (
      SELECT 1 FROM auto_listing_category_strategy_sample_images image
       WHERE image.account_id=NEW.account_id AND image.sample_id=NEW.sample_id
         AND (image.image_id=NEW.image_id OR (image.role=NEW.role AND image.ordinal=NEW.ordinal))
    ) THEN
      RAISE EXCEPTION 'main image ordinal must be zero' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.ordinal>5 OR EXISTS (
      SELECT 1 FROM auto_listing_category_strategy_sample_images image
       WHERE image.account_id=NEW.account_id AND image.sample_id=NEW.sample_id
         AND (image.image_id=NEW.image_id OR (image.role=NEW.role AND image.ordinal=NEW.ordinal))
    ) OR NOT EXISTS (
      SELECT 1 FROM auto_listing_category_strategy_sample_images image
       WHERE image.account_id=NEW.account_id AND image.sample_id=NEW.sample_id
         AND image.role='MAIN' AND image.ordinal=0
    ) THEN
      RAISE EXCEPTION 'detail image requires main and has a five image ceiling' USING ERRCODE='23514';
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

CREATE TRIGGER auto_listing_category_strategy_sample_image_insert
BEFORE INSERT ON auto_listing_category_strategy_sample_images
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_sample_image_insert_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_analysis_attempt_insert_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auto_listing_category_strategy_sample_sets sample_set
     WHERE sample_set.account_id=NEW.account_id AND sample_set.draft_id=NEW.draft_id
       AND sample_set.taxonomy_scope=NEW.taxonomy_scope
       AND sample_set.description_category_id=NEW.description_category_id AND sample_set.type_id=NEW.type_id
       AND sample_set.id=NEW.sample_set_id AND sample_set.status='SEALED'
       AND sample_set.sample_set_hash=NEW.sample_set_hash
  ) THEN
    RAISE EXCEPTION 'analysis requires the exact sealed sample set' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_analysis_attempt_insert
BEFORE INSERT ON auto_listing_category_strategy_analysis_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_analysis_attempt_insert_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_event_insert_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='ACCOUNT_SETTINGS_CHANGED' AND pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'settings history is written only by the settings transition' USING ERRCODE='23514';
  END IF;
  IF NEW.event_type='PUBLISHED' AND (
    NOT EXISTS (
      SELECT 1 FROM auto_listing_category_strategy_analysis_results result
       WHERE result.account_id=NEW.account_id AND result.draft_id=NEW.draft_id
         AND result.taxonomy_scope=NEW.taxonomy_scope
         AND result.description_category_id=NEW.description_category_id AND result.type_id=NEW.type_id
         AND result.id=NEW.analysis_result_id
    ) OR NOT EXISTS (
      SELECT 1 FROM ai_content_strategy_versions strategy
       WHERE strategy.account_id=NEW.account_id AND strategy.id=NEW.published_strategy_version_id
         AND strategy.status='PUBLISHED'
    )
  ) THEN
    RAISE EXCEPTION 'published event lineage is not exact' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_event_insert
BEFORE INSERT ON auto_listing_category_strategy_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_event_insert_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'category strategy evidence is append only' USING ERRCODE='23514';
END;
$$;

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

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_settings_transition_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  history auto_listing_category_strategy_events%ROWTYPE;
BEGIN
  SELECT * INTO history FROM auto_listing_category_strategy_events event
   WHERE event.account_id=NEW.account_id AND event.idempotency_key=NEW.idempotency_key;
  IF FOUND THEN
    IF history.event_type='ACCOUNT_SETTINGS_CHANGED'
      AND history.request_hash=NEW.request_hash
      AND history.event_payload->>'mode'=NEW.mode THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'settings idempotency conflict' USING ERRCODE='23514';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.version<>OLD.version+1
    OR NEW.mode IS NOT DISTINCT FROM OLD.mode
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.actor_account_id<>NEW.account_id THEN
    RAISE EXCEPTION 'settings transition is invalid' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=STATEMENT_TIMESTAMP();
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_strategy_settings_transition
BEFORE UPDATE ON auto_listing_category_strategy_account_settings
FOR EACH ROW EXECUTE FUNCTION auto_listing_category_strategy_settings_transition_guard();

CREATE OR REPLACE FUNCTION auto_listing_category_strategy_settings_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auto_listing_category_strategy_events (
    id,account_id,event_type,settings_version,event_payload,idempotency_key,
    correlation_id,request_hash,actor_account_id
  ) VALUES (
    'category-strategy-settings:' || NEW.account_id || ':' || NEW.version,
    NEW.account_id,'ACCOUNT_SETTINGS_CHANGED',NEW.version,JSONB_BUILD_OBJECT('mode',NEW.mode),
    NEW.idempotency_key,NEW.correlation_id,NEW.request_hash,NEW.actor_account_id
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
    'category-strategy-settings-bootstrap:' || NEW.id,REPEAT('0',64),NEW.id
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
