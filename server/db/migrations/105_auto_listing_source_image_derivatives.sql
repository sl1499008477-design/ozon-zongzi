-- Persist immutable cleanup attempts that turn one logical source asset into
-- a separately verified, reusable appearance derivative.

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT constraint_definition.oid,constraint_definition.conname
      FROM pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid='auto_listing_source_image_analysis_runs'::REGCLASS
       AND constraint_definition.contype='c'
       AND pg_get_constraintdef(constraint_definition.oid) LIKE '%intelligence_contract_version%'
  LOOP
    EXECUTE format(
      'ALTER TABLE auto_listing_source_image_analysis_runs DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END $$;
ALTER TABLE auto_listing_source_image_analysis_runs
  ADD CONSTRAINT auto_listing_source_image_analysis_contract_check CHECK (
    intelligence_contract_version IN (
      'AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1',
      'AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2'
    )
  ) NOT VALID;

CREATE TABLE auto_listing_source_image_derivatives (
  id TEXT PRIMARY KEY CHECK (auto_listing_ai_runtime_safe_identifier(id)),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  analysis_run_id TEXT NOT NULL,
  source_asset_id TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(source_asset_id)),
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  derivative_attempt_id TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(derivative_attempt_id)),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  original_content_hash TEXT NOT NULL CHECK (original_content_hash ~ '^[a-f0-9]{64}$'),
  overlay_decision_hash TEXT NOT NULL CHECK (overlay_decision_hash ~ '^[a-f0-9]{64}$'),
  prompt_version TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(prompt_version)),
  status TEXT NOT NULL CHECK (status IN (
    'RESERVED','GENERATED','ACCEPTED','REJECTED','FAILED'
  )),
  lease_token TEXT NOT NULL CHECK (auto_listing_ai_runtime_safe_identifier(lease_token)),
  generated_object_key TEXT CHECK (
    generated_object_key IS NULL OR (
      generated_object_key LIKE 'auto-listing/source-derivative/v1/%'
      AND OCTET_LENGTH(generated_object_key)<=2048
    )
  ),
  generated_content_hash TEXT CHECK (generated_content_hash IS NULL OR generated_content_hash ~ '^[a-f0-9]{64}$'),
  generated_content_type TEXT CHECK (
    generated_content_type IS NULL OR generated_content_type IN ('image/png','image/jpeg','image/webp')
  ),
  generated_width INTEGER CHECK (generated_width IS NULL OR generated_width>0),
  generated_height INTEGER CHECK (generated_height IS NULL OR generated_height>0),
  generated_size_bytes INTEGER CHECK (generated_size_bytes IS NULL OR generated_size_bytes BETWEEN 1 AND 8388608),
  edit_gateway_request_id TEXT CHECK (
    edit_gateway_request_id IS NULL OR auto_listing_ai_runtime_safe_identifier(edit_gateway_request_id)
  ),
  edit_model_evidence JSONB CHECK (
    edit_model_evidence IS NULL OR (
      JSONB_TYPEOF(edit_model_evidence)='object' AND OCTET_LENGTH(edit_model_evidence::TEXT)<=16384
    )
  ),
  edit_gateway_connection_id TEXT,
  edit_gateway_connection_version INTEGER,
  check_result JSONB CHECK (
    check_result IS NULL OR (JSONB_TYPEOF(check_result)='object' AND OCTET_LENGTH(check_result::TEXT)<=524288)
  ),
  cleanup_evidence_hash TEXT CHECK (cleanup_evidence_hash IS NULL OR cleanup_evidence_hash ~ '^[a-f0-9]{64}$'),
  checker_gateway_request_id TEXT CHECK (
    checker_gateway_request_id IS NULL OR auto_listing_ai_runtime_safe_identifier(checker_gateway_request_id)
  ),
  checker_model_evidence JSONB CHECK (
    checker_model_evidence IS NULL OR (
      JSONB_TYPEOF(checker_model_evidence)='object' AND OCTET_LENGTH(checker_model_evidence::TEXT)<=16384
    )
  ),
  checker_gateway_connection_id TEXT,
  checker_gateway_connection_version INTEGER,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  generated_at TIMESTAMPTZ CHECK (generated_at IS NULL OR ISFINITE(generated_at)),
  completed_at TIMESTAMPTZ CHECK (completed_at IS NULL OR ISFINITE(completed_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,derivative_attempt_id),
  UNIQUE (account_id,analysis_run_id,source_asset_id,input_hash,attempt_no),
  FOREIGN KEY (account_id,job_id) REFERENCES auto_listing_jobs(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id,analysis_run_id)
    REFERENCES auto_listing_source_image_analysis_runs(account_id,job_id,item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,job_id,item_id,analysis_run_id,source_asset_id)
    REFERENCES auto_listing_source_image_assessments(
      account_id,job_id,item_id,analysis_run_id,source_asset_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,edit_gateway_connection_id,edit_gateway_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id,id,version) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,checker_gateway_connection_id,checker_gateway_connection_version)
    REFERENCES ai_gateway_connection_versions(account_id,id,version) ON DELETE RESTRICT,
  CHECK (
    (edit_gateway_connection_id IS NULL AND edit_gateway_connection_version IS NULL)
    OR (edit_gateway_connection_id IS NOT NULL
      AND edit_gateway_connection_version IS NOT NULL
      AND edit_gateway_connection_version BETWEEN 1 AND 2147483647)
  ),
  CHECK (
    (checker_gateway_connection_id IS NULL AND checker_gateway_connection_version IS NULL)
    OR (checker_gateway_connection_id IS NOT NULL
      AND checker_gateway_connection_version IS NOT NULL
      AND checker_gateway_connection_version BETWEEN 1 AND 2147483647)
  ),
  CHECK (generated_width IS NULL OR generated_height IS NULL
    OR generated_width::BIGINT*generated_height::BIGINT<=40000000),
  CHECK (
    (status='RESERVED'
      AND generated_object_key IS NULL AND generated_content_hash IS NULL AND generated_content_type IS NULL
      AND generated_width IS NULL AND generated_height IS NULL AND generated_size_bytes IS NULL
      AND edit_gateway_request_id IS NULL AND edit_model_evidence IS NULL
      AND edit_gateway_connection_id IS NULL AND edit_gateway_connection_version IS NULL
      AND check_result IS NULL AND cleanup_evidence_hash IS NULL AND checker_gateway_request_id IS NULL
      AND checker_model_evidence IS NULL AND checker_gateway_connection_id IS NULL
      AND checker_gateway_connection_version IS NULL AND failure_code IS NULL
      AND generated_at IS NULL AND completed_at IS NULL)
    OR (status='GENERATED'
      AND generated_object_key IS NOT NULL AND generated_content_hash IS NOT NULL
      AND generated_content_type IS NOT NULL AND generated_width IS NOT NULL
      AND generated_height IS NOT NULL AND generated_size_bytes IS NOT NULL
      AND edit_gateway_request_id IS NOT NULL AND JSONB_TYPEOF(edit_model_evidence)='object'
      AND check_result IS NULL AND cleanup_evidence_hash IS NULL AND checker_gateway_request_id IS NULL
      AND checker_model_evidence IS NULL AND checker_gateway_connection_id IS NULL
      AND checker_gateway_connection_version IS NULL AND failure_code IS NULL
      AND generated_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('ACCEPTED','REJECTED')
      AND generated_object_key IS NOT NULL AND generated_content_hash IS NOT NULL
      AND generated_content_type IS NOT NULL AND generated_width IS NOT NULL
      AND generated_height IS NOT NULL AND generated_size_bytes IS NOT NULL
      AND edit_gateway_request_id IS NOT NULL AND JSONB_TYPEOF(edit_model_evidence)='object'
      AND JSONB_TYPEOF(check_result)='object' AND cleanup_evidence_hash IS NOT NULL
      AND checker_gateway_request_id IS NOT NULL AND JSONB_TYPEOF(checker_model_evidence)='object'
      AND failure_code IS NULL AND generated_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX auto_listing_source_image_derivatives_one_accepted
  ON auto_listing_source_image_derivatives(
    account_id, job_id, item_id, analysis_run_id, source_asset_id
  )
  WHERE status='ACCEPTED';

CREATE INDEX auto_listing_source_image_derivatives_run_status_idx
  ON auto_listing_source_image_derivatives(account_id,job_id,item_id,analysis_run_id,status,source_asset_id);

CREATE OR REPLACE FUNCTION auto_listing_source_image_derivative_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'source image derivatives cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF OLD.status IN ('ACCEPTED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'terminal source image derivatives are immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.analysis_run_id,NEW.source_asset_id,
      NEW.expected_status_version,NEW.derivative_attempt_id,NEW.input_hash,NEW.attempt_no,
      NEW.original_content_hash,NEW.overlay_decision_hash,NEW.prompt_version,NEW.lease_token,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.analysis_run_id,OLD.source_asset_id,
      OLD.expected_status_version,OLD.derivative_attempt_id,OLD.input_hash,OLD.attempt_no,
      OLD.original_content_hash,OLD.overlay_decision_hash,OLD.prompt_version,OLD.lease_token,OLD.created_at)
  THEN RAISE EXCEPTION 'source image derivative identity is immutable' USING ERRCODE='23514'; END IF;
  IF NOT ((OLD.status='RESERVED' AND NEW.status IN ('GENERATED','FAILED'))
    OR (OLD.status='GENERATED' AND NEW.status IN ('ACCEPTED','REJECTED','FAILED')))
  THEN RAISE EXCEPTION 'source image derivative transition is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auto_listing_source_image_derivative_immutable
BEFORE UPDATE OR DELETE ON auto_listing_source_image_derivatives
FOR EACH ROW EXECUTE FUNCTION auto_listing_source_image_derivative_guard();

-- V3 gains two derivative-targeted phases. Historical V1/V2 phase contracts
-- remain byte-for-byte compatible.
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

  IF row_contract_version IN ('V1','V2') THEN
    IF row_phase='MATERIALIZE_SOURCE_ASSET' THEN target_key := 'sourceAssetId';
    ELSIF row_phase='GENERATE_IMAGE_SLOT' THEN target_key := 'slotKey';
    ELSE target_key := NULL; END IF;
  ELSIF row_contract_version='V3' THEN
    CASE row_phase
      WHEN 'MATERIALIZE_SOURCE_ASSET' THEN target_key := 'sourceAssetId';
      WHEN 'ANALYZE_SOURCE_IMAGE_BATCH' THEN target_key := 'analysisBatchId';
      WHEN 'CLEAN_SOURCE_IMAGE_OVERLAY' THEN target_key := 'derivativeAttemptId';
      WHEN 'CHECK_SOURCE_IMAGE_CLEANUP' THEN target_key := 'derivativeAttemptId';
      WHEN 'RECONCILE_SOURCE_IMAGE_ANALYSIS' THEN target_key := 'analysisRunId';
      WHEN 'GENERATE_IMAGE_SLOT' THEN target_key := 'slotKey';
      WHEN 'CHECK_IMAGE_GROUP' THEN target_key := 'visualGroupKey';
      ELSE target_key := NULL;
    END CASE;
  ELSE RETURN FALSE; END IF;
  IF row_phase IN ('CLEAN_SOURCE_IMAGE_OVERLAY','CHECK_SOURCE_IMAGE_CLEANUP') THEN
    canonical_value := canonical_value || ',"analysisRunId":' || TO_JSONB(value->>'analysisRunId')::TEXT
      || ',' || TO_JSONB(target_key)::TEXT || ':' || TO_JSONB(value->>target_key)::TEXT || '}';
    RETURN OCTET_LENGTH(canonical_value)<=2048 AND key_count=8
      AND value ? 'analysisRunId' AND JSONB_TYPEOF(value->'analysisRunId')='string'
      AND auto_listing_ai_runtime_safe_identifier(value->>'analysisRunId')
      AND value ? target_key AND JSONB_TYPEOF(value->target_key)='string'
      AND value->>target_key=row_phase_target_id
      AND auto_listing_ai_runtime_safe_identifier(value->>target_key)
      AND NOT (value ?| ARRAY['sourceAssetId','analysisBatchId','slotKey','visualGroupKey']);
  END IF;
  IF target_key IS NULL THEN
    canonical_value := canonical_value || '}';
    RETURN OCTET_LENGTH(canonical_value)<=2048 AND key_count=6 AND row_phase_target_id IS NULL
      AND NOT (value ?| ARRAY['sourceAssetId','analysisBatchId','analysisRunId','derivativeAttemptId','slotKey','visualGroupKey']);
  END IF;
  canonical_value := canonical_value || ',' || TO_JSONB(target_key)::TEXT || ':' || TO_JSONB(value->>target_key)::TEXT || '}';
  RETURN OCTET_LENGTH(canonical_value)<=2048 AND key_count=7 AND value ? target_key
    AND JSONB_TYPEOF(value->target_key)='string' AND value->>target_key=row_phase_target_id
    AND auto_listing_ai_runtime_safe_identifier(value->>target_key);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$;

ALTER TABLE auto_listing_ai_outbox
  DROP CONSTRAINT IF EXISTS auto_listing_ai_outbox_new_contract_check;
ALTER TABLE auto_listing_ai_outbox
  ADD CONSTRAINT auto_listing_ai_outbox_new_contract_check CHECK (
    contract_version IS NULL OR ((
      contract_version IN ('V1','V2','V3') AND state IN ('PENDING','PROCESSING','COMPLETED','DEAD')
      AND ((contract_version IN ('V1','V2') AND phase IN ('PLAN_CONTENT','MATERIALIZE_SOURCE_ASSET',
        'FINALIZE_MATERIALIZED_PLAN','GENERATE_IMAGE_SLOT','GENERATE_RICH_CONTENT'))
      OR (contract_version='V3' AND phase IN ('MATERIALIZE_SOURCE_ASSET','ANALYZE_SOURCE_IMAGE_BATCH',
        'CLEAN_SOURCE_IMAGE_OVERLAY','CHECK_SOURCE_IMAGE_CLEANUP','RECONCILE_SOURCE_IMAGE_ANALYSIS',
        'PLAN_CONTENT','FINALIZE_MATERIALIZED_PLAN','GENERATE_IMAGE_SLOT','CHECK_IMAGE_GROUP','GENERATE_RICH_CONTENT')))
      AND event_type=phase AND expected_status_version BETWEEN 1 AND 2147483647
      AND auto_listing_ai_runtime_safe_identifier(id) AND dedupe_key ~ '^[a-f0-9]{64}$'
      AND auto_listing_ai_runtime_safe_identifier(correlation_id)
      AND auto_listing_ai_outbox_payload_valid(payload,contract_version,account_id,item_id,phase,
        phase_target_id,expected_status_version,correlation_id) IS TRUE
      AND last_error_safe IS NULL AND (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$')
    ) IS TRUE)
  ) NOT VALID;
