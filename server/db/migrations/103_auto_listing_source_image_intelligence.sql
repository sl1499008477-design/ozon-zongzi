-- Persist immutable, account-scoped source-image intelligence evidence.
-- Historical plans, SOURCE_V1 objects and V1/V2 Outbox rows remain valid.

CREATE TABLE auto_listing_source_image_analysis_runs (
  id TEXT PRIMARY KEY CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  intelligence_contract_version TEXT NOT NULL CHECK (
    intelligence_contract_version = 'AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1'
  ),
  source_snapshot_hash TEXT NOT NULL CHECK (source_snapshot_hash ~ '^[a-f0-9]{64}$'),
  source_asset_set_hash TEXT NOT NULL CHECK (source_asset_set_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  prompt_template_version TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(prompt_template_version)),
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 2147483647),
  model_name TEXT NOT NULL CHECK (NULLIF(BTRIM(model_name),'') IS NOT NULL AND OCTET_LENGTH(model_name) <= 240),
  expected_asset_count INTEGER NOT NULL CHECK (expected_asset_count BETWEEN 1 AND 10000),
  terminal_asset_count INTEGER NOT NULL DEFAULT 0 CHECK (
    terminal_asset_count BETWEEN 0 AND expected_asset_count
  ),
  status TEXT NOT NULL CHECK (status IN (
    'MATERIALIZING','ANALYZING','RECONCILING','ACCEPTED','CONFIRMATION_REQUIRED','FAILED'
  )),
  parent_run_id TEXT,
  derivation_kind TEXT NOT NULL CHECK (derivation_kind IN ('INITIAL','MANUAL_DECISION')),
  decision_set JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (
    JSONB_TYPEOF(decision_set)='array' AND JSONB_ARRAY_LENGTH(decision_set) BETWEEN 0 AND 10000
    AND OCTET_LENGTH(decision_set::TEXT) <= 1048576
  ),
  decision_set_hash TEXT NOT NULL CHECK (decision_set_hash ~ '^[a-f0-9]{64}$'),
  summary JSONB,
  summary_hash TEXT,
  summary_input_hash TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  completed_at TIMESTAMPTZ CHECK (completed_at IS NULL OR ISFINITE(completed_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,job_id,item_id,id),
  UNIQUE (account_id,job_id,item_id,expected_status_version,input_hash),
  FOREIGN KEY (account_id,job_id) REFERENCES auto_listing_jobs(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id,source_snapshot_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id,snapshot_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,profile_id,profile_version)
    REFERENCES ai_gateway_profiles(account_id,id,config_version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, job_id, item_id, parent_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id, job_id, item_id, id) ON DELETE RESTRICT,
  CHECK (
    (derivation_kind='INITIAL' AND parent_run_id IS NULL)
    OR (derivation_kind='MANUAL_DECISION' AND parent_run_id IS NOT NULL AND parent_run_id<>id)
  ),
  CHECK (
    (status IN ('MATERIALIZING','ANALYZING','RECONCILING')
      AND summary IS NULL AND summary_hash IS NULL AND summary_input_hash IS NULL
      AND failure_code IS NULL AND completed_at IS NULL)
    OR (status IN ('ACCEPTED','CONFIRMATION_REQUIRED')
      AND terminal_asset_count=expected_asset_count
      AND JSONB_TYPEOF(summary)='object' AND OCTET_LENGTH(summary::TEXT)<=524288
      AND summary_hash ~ '^[a-f0-9]{64}$' AND summary_input_hash ~ '^[a-f0-9]{64}$'
      AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (status='FAILED' AND summary IS NULL AND summary_hash IS NULL AND summary_input_hash IS NULL
      AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX auto_listing_source_image_analysis_runs_item_created_idx
  ON auto_listing_source_image_analysis_runs(account_id,job_id,item_id,created_at,id);

CREATE TABLE auto_listing_source_image_assessments (
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  analysis_run_id TEXT NOT NULL,
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  source_asset_id TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(source_asset_id)),
  source_ordinal INTEGER CHECK (source_ordinal IS NULL OR source_ordinal BETWEEN 0 AND 9999),
  record_status TEXT NOT NULL CHECK (record_status IN ('MATERIALIZED','ACCEPTED')),
  source_ref_hash TEXT CHECK (source_ref_hash IS NULL OR source_ref_hash ~ '^[a-f0-9]{64}$'),
  object_key TEXT CHECK (object_key IS NULL OR (NULLIF(BTRIM(object_key),'') IS NOT NULL AND OCTET_LENGTH(object_key)<=2048)),
  content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  content_type TEXT CHECK (content_type IS NULL OR content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 8388608),
  materialized_at TIMESTAMPTZ CHECK (materialized_at IS NULL OR ISFINITE(materialized_at)),
  terminal_status TEXT CHECK (terminal_status IS NULL OR terminal_status IN (
    'ANALYZED','DUPLICATE_REUSED','DOWNLOAD_FAILED','UNSUPPORTED_MEDIA','CONFIRMATION_REQUIRED'
  )),
  analysis_batch_id TEXT CHECK (analysis_batch_id IS NULL OR auto_listing_ai_runtime_safe_identifier(analysis_batch_id)),
  batch_input_hash TEXT CHECK (batch_input_hash IS NULL OR batch_input_hash ~ '^[a-f0-9]{64}$'),
  batch_result_hash TEXT CHECK (batch_result_hash IS NULL OR batch_result_hash ~ '^[a-f0-9]{64}$'),
  input_hash TEXT CHECK (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$'),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  assessment JSONB CHECK (
    assessment IS NULL OR (JSONB_TYPEOF(assessment)='object' AND OCTET_LENGTH(assessment::TEXT)<=524288)
  ),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  accepted_at TIMESTAMPTZ CHECK (accepted_at IS NULL OR ISFINITE(accepted_at)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  PRIMARY KEY (account_id,job_id,item_id,analysis_run_id,source_asset_id),
  FOREIGN KEY (account_id,job_id,item_id,analysis_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE CASCADE,
  CHECK (
    (record_status='MATERIALIZED' AND source_ordinal IS NOT NULL AND source_ref_hash IS NOT NULL
      AND object_key IS NOT NULL AND content_hash IS NOT NULL AND content_type IS NOT NULL
      AND size_bytes IS NOT NULL AND materialized_at IS NOT NULL AND terminal_status IS NULL
      AND analysis_batch_id IS NULL AND batch_input_hash IS NULL AND batch_result_hash IS NULL
      AND input_hash IS NULL AND result_hash IS NULL AND assessment IS NULL AND error_code IS NULL AND accepted_at IS NULL)
    OR (record_status='ACCEPTED' AND terminal_status IS NOT NULL AND result_hash IS NOT NULL AND accepted_at IS NOT NULL
      AND ((terminal_status IN ('DOWNLOAD_FAILED','UNSUPPORTED_MEDIA')
        AND analysis_batch_id IS NULL AND batch_input_hash IS NULL AND batch_result_hash IS NULL
        AND input_hash IS NULL AND assessment IS NULL AND error_code IS NOT NULL)
      OR (terminal_status IN ('ANALYZED','DUPLICATE_REUSED','CONFIRMATION_REQUIRED')
        AND source_ordinal IS NOT NULL AND object_key IS NOT NULL AND content_hash IS NOT NULL
        AND analysis_batch_id IS NOT NULL AND batch_input_hash IS NOT NULL AND batch_result_hash IS NOT NULL
        AND input_hash IS NOT NULL AND JSONB_TYPEOF(assessment)='object' AND error_code IS NULL)))
  )
);

CREATE UNIQUE INDEX auto_listing_source_image_assessments_run_ordinal_key
  ON auto_listing_source_image_assessments(account_id,job_id,item_id,analysis_run_id,source_ordinal)
  WHERE source_ordinal IS NOT NULL;
CREATE INDEX auto_listing_source_image_assessments_batch_idx
  ON auto_listing_source_image_assessments(account_id,job_id,item_id,analysis_run_id,analysis_batch_id);

CREATE TABLE auto_listing_source_image_decisions (
  id TEXT PRIMARY KEY CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  analysis_run_id TEXT NOT NULL,
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  source_asset_id TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(source_asset_id)),
  decision TEXT NOT NULL CHECK (decision IN ('PRODUCT_MARKING','EXTERNAL_OVERLAY_EXCLUDE','UNRESOLVED_EXCLUDE')),
  idempotency_key TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(idempotency_key)),
  decision_hash TEXT NOT NULL CHECK (decision_hash ~ '^[a-f0-9]{64}$'),
  derived_decision_set_hash TEXT NOT NULL CHECK (derived_decision_set_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,idempotency_key),
  UNIQUE (account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id),
  FOREIGN KEY (account_id,job_id,item_id,analysis_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,job_id,item_id,analysis_run_id,source_asset_id)
    REFERENCES auto_listing_source_image_assessments(account_id,job_id,item_id,analysis_run_id,source_asset_id) ON DELETE RESTRICT
);

CREATE TABLE auto_listing_image_group_checks (
  id TEXT PRIMARY KEY CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  source_image_analysis_run_id TEXT NOT NULL,
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  visual_group_key TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(visual_group_key)),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('CHECKING','ACCEPTED','REJECTED','FAILED')),
  result JSONB CHECK (result IS NULL OR (JSONB_TYPEOF(result)='object' AND OCTET_LENGTH(result::TEXT)<=524288)),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  completed_at TIMESTAMPTZ CHECK (completed_at IS NULL OR ISFINITE(completed_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,job_id,item_id,plan_id,visual_group_key,input_hash),
  FOREIGN KEY (account_id,job_id,item_id,plan_id)
    REFERENCES ai_content_plans(account_id,job_id,item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,job_id,item_id,source_image_analysis_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT,
  CHECK (
    (status='CHECKING' AND result_hash IS NULL AND result IS NULL AND error_code IS NULL AND completed_at IS NULL)
    OR (status IN ('ACCEPTED','REJECTED') AND result_hash IS NOT NULL AND JSONB_TYPEOF(result)='object'
      AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status='FAILED' AND result_hash IS NULL AND result IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION auto_listing_source_image_run_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'source image analysis runs are append only' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    OLD.status IN ('ACCEPTED','CONFIRMATION_REQUIRED','FAILED')
    OR ROW(NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.source_snapshot_id,
      NEW.expected_status_version,NEW.intelligence_contract_version,NEW.source_snapshot_hash,
      NEW.source_asset_set_hash,NEW.input_hash,NEW.prompt_template_version,NEW.profile_id,
      NEW.profile_version,NEW.model_name,NEW.expected_asset_count,NEW.parent_run_id,
      NEW.derivation_kind,NEW.decision_set,NEW.decision_set_hash,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.source_snapshot_id,
      OLD.expected_status_version,OLD.intelligence_contract_version,OLD.source_snapshot_hash,
      OLD.source_asset_set_hash,OLD.input_hash,OLD.prompt_template_version,OLD.profile_id,
      OLD.profile_version,OLD.model_name,OLD.expected_asset_count,OLD.parent_run_id,
      OLD.derivation_kind,OLD.decision_set,OLD.decision_set_hash,OLD.created_at)
  ) THEN RAISE EXCEPTION 'source image analysis identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auto_listing_source_image_run_guard
BEFORE UPDATE OR DELETE ON auto_listing_source_image_analysis_runs
FOR EACH ROW EXECUTE FUNCTION auto_listing_source_image_run_guard();

CREATE OR REPLACE FUNCTION auto_listing_source_image_assessment_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.record_status='ACCEPTED') THEN
    RAISE EXCEPTION 'accepted source image assessments are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.account_id,NEW.job_id,NEW.item_id,NEW.analysis_run_id,
    NEW.expected_status_version,NEW.source_asset_id,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.account_id,OLD.job_id,OLD.item_id,OLD.analysis_run_id,
    OLD.expected_status_version,OLD.source_asset_id,OLD.created_at) THEN
    RAISE EXCEPTION 'source image assessment identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auto_listing_source_image_assessment_guard
BEFORE UPDATE OR DELETE ON auto_listing_source_image_assessments
FOR EACH ROW EXECUTE FUNCTION auto_listing_source_image_assessment_guard();

CREATE OR REPLACE FUNCTION auto_listing_source_image_append_only_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source image decision evidence is append only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER auto_listing_source_image_decision_append_only
BEFORE UPDATE OR DELETE ON auto_listing_source_image_decisions
FOR EACH ROW EXECUTE FUNCTION auto_listing_source_image_append_only_guard();
CREATE OR REPLACE FUNCTION auto_listing_image_group_check_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status IN ('ACCEPTED','REJECTED','FAILED')
    OR ROW(NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.plan_id,
      NEW.source_image_analysis_run_id,NEW.expected_status_version,NEW.visual_group_key,
      NEW.input_hash,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.plan_id,
      OLD.source_image_analysis_run_id,OLD.expected_status_version,OLD.visual_group_key,
      OLD.input_hash,OLD.created_at)
  THEN RAISE EXCEPTION 'image group check evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auto_listing_image_group_check_terminal_immutable
BEFORE UPDATE OR DELETE ON auto_listing_image_group_checks
FOR EACH ROW EXECUTE FUNCTION auto_listing_image_group_check_guard();

ALTER TABLE auto_listing_job_items
  ADD COLUMN current_source_image_analysis_run_id TEXT;
ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_current_source_image_run_fk
  FOREIGN KEY (account_id,job_id,id,current_source_image_analysis_run_id)
  REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT NOT VALID;

-- Source materialization now has a closed owner union. Existing plan-owned rows
-- keep parent_plan_id and SOURCE_V1; analysis rows use source_analysis_run_id and SOURCE_V2.
ALTER TABLE auto_listing_source_materialization_attempts
  ADD COLUMN source_analysis_run_id TEXT,
  ALTER COLUMN parent_plan_id DROP NOT NULL;
ALTER TABLE auto_listing_source_object_cleanup_obligations
  ADD COLUMN source_analysis_run_id TEXT,
  ALTER COLUMN parent_plan_id DROP NOT NULL;

DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conrelid::regclass AS table_name,conname
      FROM pg_constraint
     WHERE contype='c'
       AND conrelid IN (
         'auto_listing_source_materialization_attempts'::regclass,
         'auto_listing_source_object_cleanup_obligations'::regclass
       )
       AND (pg_get_constraintdef(oid) ILIKE '%object_key_version%'
         OR pg_get_constraintdef(oid) ILIKE '%auto_listing_source_materialization_object_key_valid%')
  LOOP
    EXECUTE FORMAT('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.table_name,constraint_row.conname);
  END LOOP;
END;
$$;

ALTER TABLE auto_listing_source_materialization_attempts
  ADD CONSTRAINT auto_listing_source_materialization_owner_check CHECK (
    ((parent_plan_id IS NOT NULL)::INTEGER + (source_analysis_run_id IS NOT NULL)::INTEGER) = 1
  ) NOT VALID;
ALTER TABLE auto_listing_source_object_cleanup_obligations
  ADD CONSTRAINT auto_listing_source_cleanup_owner_check CHECK (
    ((parent_plan_id IS NOT NULL)::INTEGER + (source_analysis_run_id IS NOT NULL)::INTEGER) = 1
  ) NOT VALID;

CREATE OR REPLACE FUNCTION auto_listing_source_materialization_object_key_valid(
  row_account_id TEXT,row_job_id TEXT,row_item_id TEXT,row_parent_plan_id TEXT,row_source_analysis_run_id TEXT,
  row_source_asset_id TEXT,row_source_ref_hash TEXT,row_input_hash TEXT,row_attempt_no INTEGER,
  row_object_key_version TEXT,row_object_key TEXT,row_content_hash TEXT,row_content_type TEXT
) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT row_source_ref_hash ~ '^[a-f0-9]{64}$' AND row_input_hash ~ '^[a-f0-9]{64}$'
    AND row_content_hash ~ '^[a-f0-9]{64}$' AND row_attempt_no BETWEEN 1 AND 3
    AND row_content_type IN ('image/png','image/jpeg','image/webp') AND OCTET_LENGTH(row_object_key)<=2048
    AND (
      (row_object_key_version='SOURCE_V1' AND row_parent_plan_id IS NOT NULL AND row_source_analysis_run_id IS NULL
        AND row_object_key='auto-listing/source/v1/'
          || auto_listing_source_materialization_key_segment(row_account_id) || '/'
          || auto_listing_source_materialization_key_segment(row_job_id) || '/'
          || auto_listing_source_materialization_key_segment(row_item_id) || '/'
          || auto_listing_source_materialization_key_segment(row_parent_plan_id) || '/'
          || auto_listing_source_materialization_key_segment(row_source_asset_id) || '/'
          || row_source_ref_hash || '/attempt-' || row_attempt_no || '/' || row_input_hash || '/'
          || row_content_hash || CASE row_content_type WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' END)
      OR
      (row_object_key_version='SOURCE_V2' AND row_parent_plan_id IS NULL AND row_source_analysis_run_id IS NOT NULL
        AND row_object_key='auto-listing/source/v2/'
          || auto_listing_source_materialization_key_segment(row_account_id) || '/'
          || auto_listing_source_materialization_key_segment(row_job_id) || '/'
          || auto_listing_source_materialization_key_segment(row_item_id) || '/analysis-run/'
          || auto_listing_source_materialization_key_segment(row_source_analysis_run_id) || '/'
          || auto_listing_source_materialization_key_segment(row_source_asset_id) || '/'
          || row_source_ref_hash || '/attempt-' || row_attempt_no || '/' || row_input_hash || '/'
          || row_content_hash || CASE row_content_type WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/webp' THEN '.webp' END)
    )
$$;

ALTER TABLE auto_listing_source_materialization_attempts
  DROP CONSTRAINT IF EXISTS auto_listing_source_materialization_lifecycle_check;
ALTER TABLE auto_listing_source_materialization_attempts
  ADD CONSTRAINT auto_listing_source_materialization_lifecycle_check CHECK (
    (status='MATERIALIZING' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND object_key_version IS NULL AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL
      AND width IS NULL AND height IS NULL AND size_bytes IS NULL AND accepted_at IS NULL
      AND error_code IS NULL AND error_retryable IS NULL)
    OR (status IN ('STORED','ACCEPTED') AND ((status='STORED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND accepted_at IS NULL) OR (status='ACCEPTED' AND lease_owner IS NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL AND accepted_at IS NOT NULL))
      AND auto_listing_source_materialization_object_key_valid(account_id,job_id,item_id,parent_plan_id,
        source_analysis_run_id,source_asset_id,source_ref_hash,input_hash,attempt_no,object_key_version,
        object_key,content_hash,content_type) IS TRUE AND width>0 AND height>0
      AND width::BIGINT*height::BIGINT<=40000000 AND size_bytes BETWEEN 1 AND 8388608
      AND error_code IS NULL AND error_retryable IS NULL)
    OR (status='FAILED' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND accepted_at IS NULL AND error_code ~ '^[A-Z][A-Z0-9_]{0,119}$' AND error_retryable IS NOT NULL
      AND ((object_key_version IS NULL AND object_key IS NULL AND content_hash IS NULL AND content_type IS NULL
        AND width IS NULL AND height IS NULL AND size_bytes IS NULL)
      OR (auto_listing_source_materialization_object_key_valid(account_id,job_id,item_id,parent_plan_id,
        source_analysis_run_id,source_asset_id,source_ref_hash,input_hash,attempt_no,object_key_version,
        object_key,content_hash,content_type) IS TRUE AND width>0 AND height>0
        AND width::BIGINT*height::BIGINT<=40000000 AND size_bytes BETWEEN 1 AND 8388608)))
  ) NOT VALID;

ALTER TABLE auto_listing_source_object_cleanup_obligations
  ADD CONSTRAINT auto_listing_source_cleanup_object_key_check CHECK (
    auto_listing_source_materialization_object_key_valid(account_id,job_id,item_id,parent_plan_id,
      source_analysis_run_id,source_asset_id,source_ref_hash,input_hash,attempt_no,object_key_version,
      object_key,content_hash,content_type) IS TRUE
  ) NOT VALID;

ALTER TABLE auto_listing_source_materialization_attempts
  ADD CONSTRAINT auto_listing_source_materialization_analysis_run_fk
    FOREIGN KEY (account_id, job_id, item_id, source_analysis_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id, job_id, item_id, id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT auto_listing_source_materialization_analysis_scope_asset_key
    UNIQUE (account_id,job_id,item_id,source_analysis_run_id,source_asset_id,id);
ALTER TABLE auto_listing_source_object_cleanup_obligations
  ADD CONSTRAINT auto_listing_source_cleanup_analysis_run_fk
    FOREIGN KEY (account_id,job_id,item_id,source_analysis_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT auto_listing_source_cleanup_analysis_materialization_asset_fk
    FOREIGN KEY (account_id,job_id,item_id,source_analysis_run_id,source_asset_id,materialization_attempt_id)
    REFERENCES auto_listing_source_materialization_attempts(
      account_id,job_id,item_id,source_analysis_run_id,source_asset_id,id
    ) ON DELETE RESTRICT NOT VALID;

DROP INDEX IF EXISTS auto_listing_source_materialization_active_input_key;
DROP INDEX IF EXISTS auto_listing_source_materialization_accepted_input_key;
CREATE UNIQUE INDEX auto_listing_source_materialization_active_input_key
  ON auto_listing_source_materialization_attempts(
    account_id,job_id,item_id,parent_plan_id,source_analysis_run_id,source_asset_id,input_hash
  ) NULLS NOT DISTINCT WHERE status IN ('MATERIALIZING','STORED');
CREATE UNIQUE INDEX auto_listing_source_materialization_accepted_input_key
  ON auto_listing_source_materialization_attempts(
    account_id,job_id,item_id,parent_plan_id,source_analysis_run_id,source_asset_id,input_hash
  ) NULLS NOT DISTINCT WHERE status='ACCEPTED';

-- Bind the new planning contract to one accepted intelligence run and hash.
ALTER TABLE ai_content_plans
  ADD COLUMN source_image_analysis_run_id TEXT,
  ADD COLUMN source_image_intelligence_hash TEXT,
  ADD CONSTRAINT ai_content_plans_source_image_intelligence_pair_check CHECK (
    (source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (source_image_analysis_run_id IS NOT NULL AND source_image_intelligence_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;
ALTER TABLE auto_listing_content_plan_attempts
  ADD COLUMN source_image_analysis_run_id TEXT,
  ADD COLUMN source_image_intelligence_hash TEXT;
ALTER TABLE auto_listing_content_plan_diagnostic_runs
  ADD COLUMN source_image_analysis_run_id TEXT,
  ADD COLUMN source_image_intelligence_hash TEXT;
ALTER TABLE auto_listing_content_plan_responses
  ADD COLUMN source_image_analysis_run_id TEXT,
  ADD COLUMN source_image_intelligence_hash TEXT;

DO $$
DECLARE target_table REGCLASS; constraint_row RECORD;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'auto_listing_job_items'::regclass,'ai_content_plans'::regclass,
    'auto_listing_content_plan_attempts'::regclass,'auto_listing_content_plan_diagnostic_runs'::regclass,
    'auto_listing_content_plan_responses'::regclass
  ] LOOP
    FOR constraint_row IN SELECT conname FROM pg_constraint WHERE conrelid=target_table AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%planning_contract%'
    LOOP EXECUTE FORMAT('ALTER TABLE %s DROP CONSTRAINT %I',target_table,constraint_row.conname); END LOOP;
  END LOOP;
END;
$$;

ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_planning_contract_check CHECK (
    planning_contract IN ('LEGACY_FULL_PLAN_V3','FIXED_SKELETON_V1','FIXED_SKELETON_SOURCE_IMAGE_V1')
  ) NOT VALID;
ALTER TABLE ai_content_plans
  ADD CONSTRAINT ai_content_plans_planning_contract_check CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_SOURCE_IMAGE_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NOT NULL AND source_image_intelligence_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;
ALTER TABLE auto_listing_content_plan_attempts
  ADD CONSTRAINT auto_listing_content_plan_attempt_contract_check CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_SOURCE_IMAGE_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NOT NULL AND source_image_intelligence_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;
ALTER TABLE auto_listing_content_plan_diagnostic_runs
  ADD CONSTRAINT auto_listing_content_plan_diagnostic_contract_check CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_SOURCE_IMAGE_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NOT NULL AND source_image_intelligence_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;
ALTER TABLE auto_listing_content_plan_responses
  ADD CONSTRAINT auto_listing_content_plan_response_contract_check CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NULL AND source_image_intelligence_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_SOURCE_IMAGE_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$'
      AND source_image_analysis_run_id IS NOT NULL AND source_image_intelligence_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;

ALTER TABLE ai_content_plans
  ADD CONSTRAINT ai_content_plans_source_image_run_fk FOREIGN KEY (
    account_id,job_id,item_id,source_image_analysis_run_id
  ) REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE auto_listing_content_plan_attempts
  ADD CONSTRAINT auto_listing_content_plan_attempt_source_image_run_fk FOREIGN KEY (
    account_id,job_id,item_id,source_image_analysis_run_id
  ) REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE auto_listing_content_plan_diagnostic_runs
  ADD CONSTRAINT auto_listing_content_plan_diagnostic_source_image_run_fk FOREIGN KEY (
    account_id,job_id,item_id,source_image_analysis_run_id
  ) REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE auto_listing_content_plan_responses
  ADD CONSTRAINT auto_listing_content_plan_response_source_image_run_fk FOREIGN KEY (
    account_id,job_id,item_id,source_image_analysis_run_id
  ) REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION auto_listing_content_plan_contract_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auto_listing_job_items item
    LEFT JOIN auto_listing_source_image_analysis_runs run
      ON run.account_id=item.account_id AND run.job_id=item.job_id AND run.item_id=item.id
      AND run.id=NEW.source_image_analysis_run_id
    WHERE item.account_id=NEW.account_id AND item.job_id=NEW.job_id AND item.id=NEW.item_id
      AND item.snapshot_id=NEW.source_snapshot_id AND item.planning_contract=NEW.planning_contract
      AND (NEW.planning_contract<>'FIXED_SKELETON_SOURCE_IMAGE_V1'
        OR (item.current_source_image_analysis_run_id=NEW.source_image_analysis_run_id
          AND run.status='ACCEPTED' AND run.summary_hash=NEW.source_image_intelligence_hash))
  ) THEN RAISE EXCEPTION 'content plan contract is not the frozen item contract' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_content_plan_attempt_stage_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auto_listing_job_items item
    LEFT JOIN auto_listing_source_image_analysis_runs run
      ON run.account_id=item.account_id AND run.job_id=item.job_id AND run.item_id=item.id
      AND run.id=NEW.source_image_analysis_run_id
    WHERE item.account_id=NEW.account_id AND item.job_id=NEW.job_id AND item.id=NEW.item_id
      AND item.snapshot_id=NEW.source_snapshot_id AND item.planning_contract=NEW.planning_contract
      AND (NEW.planning_contract<>'FIXED_SKELETON_SOURCE_IMAGE_V1'
        OR (item.current_source_image_analysis_run_id=NEW.source_image_analysis_run_id
          AND run.status='ACCEPTED' AND run.summary_hash=NEW.source_image_intelligence_hash))
  ) THEN RAISE EXCEPTION 'content plan attempt contract is not the frozen item contract' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT ((NEW.status='PLANNING' AND NEW.planner_stage IN ('BUILDING_SKELETON','FILLING_COPY','VALIDATING_COPY'))
      OR (NEW.status='ACCEPTED' AND NEW.planner_stage='COMPLETED')
      OR (NEW.status='FAILED' AND NEW.planner_stage='FAILED'))
    THEN RAISE EXCEPTION 'content plan attempt initial stage is invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.source_snapshot_id,NEW.profile_id,
    NEW.profile_version,NEW.input_hash,NEW.attempt_no,NEW.planning_contract,NEW.skeleton_hash,
    NEW.source_image_analysis_run_id,NEW.source_image_intelligence_hash) IS DISTINCT FROM
    ROW(OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.source_snapshot_id,OLD.profile_id,
    OLD.profile_version,OLD.input_hash,OLD.attempt_no,OLD.planning_contract,OLD.skeleton_hash,
    OLD.source_image_analysis_run_id,OLD.source_image_intelligence_hash)
  THEN RAISE EXCEPTION 'content plan attempt identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.status IN ('ACCEPTED','FAILED') OR OLD.planner_stage IN ('COMPLETED','FAILED')
  THEN RAISE EXCEPTION 'terminal content plan attempt is immutable' USING ERRCODE='23514'; END IF;
  IF NOT ((OLD.planner_stage='BUILDING_SKELETON' AND NEW.planner_stage IN ('FILLING_COPY','FAILED'))
    OR (OLD.planner_stage='FILLING_COPY' AND NEW.planner_stage IN ('VALIDATING_COPY','FAILED'))
    OR (OLD.planner_stage='VALIDATING_COPY' AND NEW.planner_stage IN ('COMPLETED','FAILED'))
    OR (OLD.planning_contract='LEGACY_FULL_PLAN_V3' AND OLD.planner_stage='FILLING_COPY' AND NEW.planner_stage='COMPLETED')
    OR (OLD.planner_stage=NEW.planner_stage AND OLD.status=NEW.status))
  THEN RAISE EXCEPTION 'content plan attempt stage transition is invalid' USING ERRCODE='23514'; END IF;
  IF NOT ((NEW.status='PLANNING' AND NEW.planner_stage IN ('BUILDING_SKELETON','FILLING_COPY','VALIDATING_COPY'))
    OR (NEW.status='ACCEPTED' AND NEW.planner_stage='COMPLETED') OR (NEW.status='FAILED' AND NEW.planner_stage='FAILED'))
  THEN RAISE EXCEPTION 'content plan attempt status does not match stage' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_content_plan_diagnostic_run_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM auto_listing_jobs WHERE account_id=OLD.account_id AND id=OLD.job_id)
    THEN RAISE EXCEPTION 'diagnostic run is append only' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'RUNNING' OR NOT EXISTS (
      SELECT 1 FROM auto_listing_job_items item
      LEFT JOIN auto_listing_source_image_analysis_runs run ON run.account_id=item.account_id
        AND run.job_id=item.job_id AND run.item_id=item.id AND run.id=NEW.source_image_analysis_run_id
      WHERE item.account_id=NEW.account_id AND item.job_id=NEW.job_id AND item.id=NEW.item_id
        AND item.snapshot_id=NEW.source_snapshot_id AND item.planning_contract=NEW.planning_contract
        AND (NEW.planning_contract<>'FIXED_SKELETON_SOURCE_IMAGE_V1'
          OR (item.current_source_image_analysis_run_id=NEW.source_image_analysis_run_id
            AND run.status='ACCEPTED' AND run.summary_hash=NEW.source_image_intelligence_hash))
    ) THEN RAISE EXCEPTION 'diagnostic run contract is invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.source_snapshot_id,NEW.expected_status_version,
    NEW.profile_id,NEW.profile_version,NEW.planning_contract,NEW.input_hash,NEW.skeleton_hash,
    NEW.source_image_analysis_run_id,NEW.source_image_intelligence_hash,NEW.idempotency_key,
    NEW.request_hash,NEW.correlation_id,NEW.actor_account_id,NEW.cost_confirmed,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.source_snapshot_id,
    OLD.expected_status_version,OLD.profile_id,OLD.profile_version,OLD.planning_contract,OLD.input_hash,
    OLD.skeleton_hash,OLD.source_image_analysis_run_id,OLD.source_image_intelligence_hash,
    OLD.idempotency_key,OLD.request_hash,OLD.correlation_id,OLD.actor_account_id,OLD.cost_confirmed,OLD.created_at)
    OR OLD.status<>'RUNNING' OR NEW.status NOT IN ('ACCEPTED','REJECTED','FAILED')
  THEN RAISE EXCEPTION 'diagnostic run transition is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_auto_listing_content_plan_response_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM auto_listing_content_plan_attempts attempt
      WHERE attempt.account_id=NEW.account_id AND attempt.job_id=NEW.job_id AND attempt.item_id=NEW.item_id
        AND attempt.source_snapshot_id=NEW.source_snapshot_id AND attempt.id=NEW.attempt_id
        AND attempt.profile_id=NEW.profile_id AND attempt.profile_version=NEW.profile_version
        AND attempt.planning_contract=NEW.planning_contract AND attempt.input_hash=NEW.input_hash
        AND attempt.skeleton_hash IS NOT DISTINCT FROM NEW.skeleton_hash
        AND attempt.source_image_analysis_run_id IS NOT DISTINCT FROM NEW.source_image_analysis_run_id
        AND attempt.source_image_intelligence_hash IS NOT DISTINCT FROM NEW.source_image_intelligence_hash)
    THEN RAISE EXCEPTION 'content plan response attempt identity mismatch' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM auto_listing_content_plan_diagnostic_runs run
      WHERE run.account_id=NEW.account_id AND run.job_id=NEW.job_id AND run.item_id=NEW.item_id
        AND run.source_snapshot_id=NEW.source_snapshot_id AND run.id=NEW.diagnostic_run_id
        AND run.profile_id=NEW.profile_id AND run.profile_version=NEW.profile_version
        AND run.planning_contract=NEW.planning_contract AND run.input_hash=NEW.input_hash
        AND run.skeleton_hash IS NOT DISTINCT FROM NEW.skeleton_hash
        AND run.source_image_analysis_run_id IS NOT DISTINCT FROM NEW.source_image_analysis_run_id
        AND run.source_image_intelligence_hash IS NOT DISTINCT FROM NEW.source_image_intelligence_hash
        AND run.status='RUNNING')
    THEN RAISE EXCEPTION 'content plan response diagnostic identity mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- V1/V2 retain their exact phase/target contract. V3 adds only the source
-- analysis and group-check phases with their stable target identifiers.
CREATE OR REPLACE FUNCTION auto_listing_ai_outbox_payload_valid(
  value JSONB,row_contract_version TEXT,row_account_id TEXT,row_item_id TEXT,row_phase TEXT,
  row_phase_target_id TEXT,row_expected_status_version INTEGER,row_correlation_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key_count INTEGER; canonical_value TEXT; target_key TEXT;
BEGIN
  IF value IS NULL OR JSONB_TYPEOF(value) IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
  SELECT COUNT(*) INTO key_count FROM JSONB_OBJECT_KEYS(value);
  IF NOT (value ?& ARRAY['contractVersion','accountId','itemId','phase','expectedStatusVersion','correlationId'])
    OR JSONB_TYPEOF(value->'contractVersion') IS DISTINCT FROM 'string'
    OR JSONB_TYPEOF(value->'accountId') IS DISTINCT FROM 'string'
    OR JSONB_TYPEOF(value->'itemId') IS DISTINCT FROM 'string'
    OR JSONB_TYPEOF(value->'phase') IS DISTINCT FROM 'string'
    OR JSONB_TYPEOF(value->'correlationId') IS DISTINCT FROM 'string'
    OR value->>'contractVersion'<>row_contract_version OR value->>'accountId'<>row_account_id
    OR value->>'itemId'<>row_item_id OR value->>'phase'<>row_phase
    OR JSONB_TYPEOF(value->'expectedStatusVersion') IS DISTINCT FROM 'number'
    OR (value->>'expectedStatusVersion') !~ '^[1-9][0-9]*$'
    OR (value->>'expectedStatusVersion')::INTEGER<>row_expected_status_version
    OR value->>'correlationId'<>row_correlation_id
    OR NOT auto_listing_ai_runtime_safe_identifier(value->>'accountId')
    OR NOT auto_listing_ai_runtime_safe_identifier(value->>'itemId')
    OR NOT auto_listing_ai_runtime_safe_identifier(value->>'correlationId')
  THEN RETURN FALSE; END IF;
  canonical_value := '{"accountId":' || TO_JSONB(value->>'accountId')::TEXT
    || ',"contractVersion":' || TO_JSONB(value->>'contractVersion')::TEXT
    || ',"correlationId":' || TO_JSONB(value->>'correlationId')::TEXT
    || ',"expectedStatusVersion":' || (value->>'expectedStatusVersion')
    || ',"itemId":' || TO_JSONB(value->>'itemId')::TEXT
    || ',"phase":' || TO_JSONB(value->>'phase')::TEXT;

  IF row_contract_version IN ('V1', 'V2') THEN
    IF row_phase='MATERIALIZE_SOURCE_ASSET' THEN target_key := 'sourceAssetId';
    ELSIF row_phase='GENERATE_IMAGE_SLOT' THEN target_key := 'slotKey';
    ELSE target_key := NULL; END IF;
  ELSIF row_contract_version='V3' THEN
    CASE row_phase
      WHEN 'MATERIALIZE_SOURCE_ASSET' THEN target_key := 'sourceAssetId';
      WHEN 'ANALYZE_SOURCE_IMAGE_BATCH' THEN target_key := 'analysisBatchId';
      WHEN 'RECONCILE_SOURCE_IMAGE_ANALYSIS' THEN target_key := 'analysisRunId';
      WHEN 'GENERATE_IMAGE_SLOT' THEN target_key := 'slotKey';
      WHEN 'CHECK_IMAGE_GROUP' THEN target_key := 'visualGroupKey';
      ELSE target_key := NULL;
    END CASE;
  ELSE RETURN FALSE; END IF;
  IF target_key IS NULL THEN
    canonical_value := canonical_value || '}';
    RETURN OCTET_LENGTH(canonical_value)<=2048 AND key_count=6 AND row_phase_target_id IS NULL
      AND NOT (value ?| ARRAY['sourceAssetId','analysisBatchId','analysisRunId','slotKey','visualGroupKey']);
  END IF;
  canonical_value := canonical_value || ',' || TO_JSONB(target_key)::TEXT || ':' || TO_JSONB(value->>target_key)::TEXT || '}';
  RETURN OCTET_LENGTH(canonical_value)<=2048 AND key_count=7 AND value ? target_key
    AND JSONB_TYPEOF(value->target_key)='string' AND value->>target_key=row_phase_target_id
    AND auto_listing_ai_runtime_safe_identifier(value->>target_key);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$;

ALTER TABLE auto_listing_ai_outbox
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_contract_version_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_new_contract_check,
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_publication_lifecycle_check;
ALTER TABLE auto_listing_ai_outbox
  ADD CONSTRAINT auto_listing_ai_outbox_contract_version_check CHECK (
    contract_version IS NULL OR contract_version IN ('V1', 'V2', 'V3')
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_new_contract_check CHECK (
    contract_version IS NULL OR ((
      contract_version IN ('V1','V2','V3') AND state IN ('PENDING','PROCESSING','COMPLETED','DEAD')
      AND ((contract_version IN ('V1','V2') AND phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET',
        'FINALIZE_MATERIALIZED_PLAN','GENERATE_IMAGE_SLOT','GENERATE_RICH_CONTENT'))
      OR (contract_version='V3' AND phase IN ('MATERIALIZE_SOURCE_ASSET','ANALYZE_SOURCE_IMAGE_BATCH',
        'RECONCILE_SOURCE_IMAGE_ANALYSIS','PLAN_CONTENT','FINALIZE_MATERIALIZED_PLAN',
        'GENERATE_IMAGE_SLOT','CHECK_IMAGE_GROUP','GENERATE_RICH_CONTENT')))
      AND event_type=phase AND expected_status_version BETWEEN 1 AND 2147483647
      AND auto_listing_ai_runtime_safe_identifier(id) AND dedupe_key ~ '^[a-f0-9]{64}$'
      AND auto_listing_ai_runtime_safe_identifier(correlation_id)
      AND auto_listing_ai_outbox_payload_valid(payload,contract_version,account_id,item_id,phase,
        phase_target_id,expected_status_version,correlation_id) IS TRUE
      AND last_error_safe IS NULL AND (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$')
    ) IS TRUE)
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_ai_outbox_publication_lifecycle_check CHECK (
    contract_version IS NULL OR (
      (state='PENDING' AND publication_id IS NULL AND published_at IS NULL AND dispatch_queued_at IS NULL
        AND dead_at IS NULL AND next_retry_at IS NOT NULL)
      OR (state='PROCESSING' AND (
        (dispatch_contract_version IS NULL AND publication_id IS NULL AND published_at IS NULL AND dispatch_queued_at IS NULL)
        OR (dispatch_contract_version='CHANNEL_WORK_V1' AND publication_id=dedupe_key || ':' || dispatch_generation
          AND dispatch_queued_at IS NOT NULL)
      ) AND dead_at IS NULL AND next_retry_at IS NOT NULL)
      OR (state='COMPLETED' AND (
        (dispatch_contract_version IS NULL AND publication_id=dedupe_key AND published_at IS NOT NULL AND dispatch_queued_at IS NULL)
        OR (dispatch_contract_version='CHANNEL_WORK_V1' AND publication_id=dedupe_key || ':' || dispatch_generation
          AND dispatch_queued_at IS NOT NULL AND published_at IS NOT NULL)
      ) AND dead_at IS NULL AND last_error_code IS NULL AND next_retry_at IS NULL)
      OR (state='DEAD' AND publication_id IS NULL AND published_at IS NULL AND dead_at IS NOT NULL
        AND last_error_code IS NOT NULL AND next_retry_at IS NULL)
    )
  ) NOT VALID;

DROP INDEX IF EXISTS auto_listing_ai_outbox_runtime_pending_idx;
CREATE INDEX auto_listing_ai_outbox_runtime_pending_idx
  ON auto_listing_ai_outbox(account_id,next_retry_at,created_at,id)
  WHERE contract_version IN ('V1', 'V2', 'V3') AND state = 'PENDING';
DROP INDEX IF EXISTS auto_listing_ai_outbox_runtime_lease_idx;
CREATE INDEX auto_listing_ai_outbox_runtime_lease_idx
  ON auto_listing_ai_outbox(account_id,lease_expires_at,id)
  WHERE contract_version IN ('V1', 'V2', 'V3') AND state = 'PROCESSING';
