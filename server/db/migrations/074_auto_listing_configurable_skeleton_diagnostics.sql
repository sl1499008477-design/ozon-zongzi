-- Freeze the selected planning contract and preserve bounded planning evidence.
-- Existing rows remain legacy; new fixed-skeleton rows must carry an exact hash.

ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3';

ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_planning_contract_check CHECK (
    planning_contract IN ('LEGACY_FULL_PLAN_V3','FIXED_SKELETON_V1')
  ) NOT VALID;

ALTER TABLE ai_content_plans
  ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3',
  ADD COLUMN IF NOT EXISTS skeleton_hash TEXT;

ALTER TABLE ai_content_plans
  ADD CONSTRAINT ai_content_plans_planning_contract_check CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID;

ALTER TABLE auto_listing_content_plan_attempts
  ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3',
  ADD COLUMN IF NOT EXISTS skeleton_hash TEXT,
  ADD COLUMN IF NOT EXISTS planner_stage TEXT;

-- The 032 terminal guard correctly rejects every UPDATE of an ACCEPTED or
-- FAILED attempt. Suspend only that trigger for this deterministic additive
-- backfill, then restore it before installing the stricter 074 stage guard.
DROP TRIGGER IF EXISTS auto_listing_content_plan_attempts_terminal_immutable
  ON auto_listing_content_plan_attempts;

UPDATE auto_listing_content_plan_attempts
   SET planner_stage=CASE status
     WHEN 'ACCEPTED' THEN 'COMPLETED'
     WHEN 'FAILED' THEN 'FAILED'
     ELSE 'FILLING_COPY'
   END
 WHERE planner_stage IS NULL;

CREATE TRIGGER auto_listing_content_plan_attempts_terminal_immutable
BEFORE UPDATE OR DELETE ON auto_listing_content_plan_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_runtime_reject_terminal_attempt_mutation();

ALTER TABLE auto_listing_content_plan_attempts
  ALTER COLUMN planner_stage SET DEFAULT 'FILLING_COPY',
  ALTER COLUMN planner_stage SET NOT NULL,
  ADD CONSTRAINT auto_listing_content_plan_attempt_contract_check CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT auto_listing_content_plan_attempt_stage_check CHECK (
    planner_stage IN (
      'BUILDING_SKELETON','FILLING_COPY','VALIDATING_COPY','COMPLETED','FAILED'
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_attempts_evidence_owner_key
  ON auto_listing_content_plan_attempts(account_id,job_id,item_id,source_snapshot_id,id);

CREATE OR REPLACE FUNCTION auto_listing_content_plan_attempt_stage_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM auto_listing_job_items item
     WHERE item.account_id=NEW.account_id
       AND item.job_id=NEW.job_id
       AND item.id=NEW.item_id
       AND item.snapshot_id=NEW.source_snapshot_id
       AND item.planning_contract=NEW.planning_contract
  ) THEN
    RAISE EXCEPTION 'content plan attempt contract is not the frozen item contract' USING ERRCODE='23514';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NOT (
      (NEW.status='PLANNING' AND NEW.planner_stage IN (
        'BUILDING_SKELETON','FILLING_COPY','VALIDATING_COPY'
      ))
      OR (NEW.status='ACCEPTED' AND NEW.planner_stage='COMPLETED')
      OR (NEW.status='FAILED' AND NEW.planner_stage='FAILED')
    ) THEN
      RAISE EXCEPTION 'content plan attempt initial stage is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.source_snapshot_id,
    NEW.profile_id,NEW.profile_version,NEW.input_hash,NEW.attempt_no,
    NEW.planning_contract,NEW.skeleton_hash
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.source_snapshot_id,
    OLD.profile_id,OLD.profile_version,OLD.input_hash,OLD.attempt_no,
    OLD.planning_contract,OLD.skeleton_hash
  ) THEN
    RAISE EXCEPTION 'content plan attempt identity is immutable' USING ERRCODE='23514';
  END IF;

  IF OLD.status IN ('ACCEPTED','FAILED')
    OR OLD.planner_stage IN ('COMPLETED','FAILED') THEN
    RAISE EXCEPTION 'terminal content plan attempt is immutable' USING ERRCODE='23514';
  END IF;

  IF NOT (
    (OLD.planner_stage='BUILDING_SKELETON' AND NEW.planner_stage IN ('FILLING_COPY','FAILED'))
    OR (OLD.planner_stage='FILLING_COPY' AND NEW.planner_stage IN ('VALIDATING_COPY','FAILED'))
    OR (OLD.planner_stage='VALIDATING_COPY' AND NEW.planner_stage IN ('COMPLETED','FAILED'))
    OR (OLD.planning_contract='LEGACY_FULL_PLAN_V3'
        AND OLD.planner_stage='FILLING_COPY' AND NEW.planner_stage='COMPLETED')
    OR (OLD.planner_stage=NEW.planner_stage AND OLD.status=NEW.status)
  ) THEN
    RAISE EXCEPTION 'content plan attempt stage transition is invalid' USING ERRCODE='23514';
  END IF;

  IF NOT (
    (NEW.status='PLANNING' AND NEW.planner_stage IN (
      'BUILDING_SKELETON','FILLING_COPY','VALIDATING_COPY'
    ))
    OR (NEW.status='ACCEPTED' AND NEW.planner_stage='COMPLETED')
    OR (NEW.status='FAILED' AND NEW.planner_stage='FAILED')
  ) THEN
    RAISE EXCEPTION 'content plan attempt status does not match stage' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_content_plan_attempt_stage_guard
BEFORE INSERT OR UPDATE ON auto_listing_content_plan_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_attempt_stage_guard();

CREATE OR REPLACE FUNCTION auto_listing_content_plan_contract_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM auto_listing_job_items item
     WHERE item.account_id=NEW.account_id
       AND item.job_id=NEW.job_id
       AND item.id=NEW.item_id
       AND item.snapshot_id=NEW.source_snapshot_id
       AND item.planning_contract=NEW.planning_contract
  ) THEN
    RAISE EXCEPTION 'content plan contract is not the frozen item contract' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_content_plan_contract_guard
BEFORE INSERT ON ai_content_plans
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_contract_guard();

CREATE TABLE IF NOT EXISTS auto_listing_content_plan_diagnostic_runs (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version BETWEEN 1 AND 2147483647),
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 2147483647),
  planning_contract TEXT NOT NULL CHECK (
    planning_contract IN ('LEGACY_FULL_PLAN_V3','FIXED_SKELETON_V1')
  ),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  skeleton_hash TEXT,
  idempotency_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  correlation_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240
  ),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','ACCEPTED','REJECTED','FAILED')),
  cost_confirmed BOOLEAN NOT NULL CHECK (cost_confirmed=TRUE),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(updated_at)),
  completed_at TIMESTAMPTZ CHECK (completed_at IS NULL OR ISFINITE(completed_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,idempotency_key),
  UNIQUE (account_id,job_id,item_id,source_snapshot_id,id),
  FOREIGN KEY (account_id,job_id)
    REFERENCES auto_listing_jobs(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id,source_snapshot_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id,snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,profile_id,profile_version)
    REFERENCES ai_gateway_profiles(account_id,id,config_version) ON DELETE RESTRICT,
  CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$')
  ),
  CHECK (
    (status='RUNNING' AND failure_code IS NULL AND completed_at IS NULL)
    OR (status IN ('ACCEPTED','REJECTED') AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (status='FAILED' AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS auto_listing_content_plan_diagnostic_runs_item_created_idx
  ON auto_listing_content_plan_diagnostic_runs(account_id,job_id,item_id,created_at,id);

CREATE OR REPLACE FUNCTION auto_listing_content_plan_diagnostic_run_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM auto_listing_jobs
       WHERE account_id=OLD.account_id AND id=OLD.job_id
    ) THEN
      RAISE EXCEPTION 'diagnostic run is append only' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'RUNNING' THEN
      RAISE EXCEPTION 'diagnostic run must start running' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.id,NEW.account_id,NEW.job_id,NEW.item_id,NEW.source_snapshot_id,
    NEW.expected_status_version,NEW.profile_id,NEW.profile_version,
    NEW.planning_contract,NEW.input_hash,NEW.skeleton_hash,NEW.idempotency_key,
    NEW.request_hash,NEW.correlation_id,NEW.actor_account_id,NEW.cost_confirmed,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.job_id,OLD.item_id,OLD.source_snapshot_id,
    OLD.expected_status_version,OLD.profile_id,OLD.profile_version,
    OLD.planning_contract,OLD.input_hash,OLD.skeleton_hash,OLD.idempotency_key,
    OLD.request_hash,OLD.correlation_id,OLD.actor_account_id,OLD.cost_confirmed,OLD.created_at
  ) OR OLD.status<>'RUNNING' OR NEW.status NOT IN ('ACCEPTED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'diagnostic run transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_content_plan_diagnostic_run_guard
BEFORE INSERT OR UPDATE OR DELETE ON auto_listing_content_plan_diagnostic_runs
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_diagnostic_run_guard();

CREATE TABLE IF NOT EXISTS auto_listing_content_plan_responses (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  attempt_id TEXT,
  diagnostic_run_id TEXT,
  planning_contract TEXT NOT NULL CHECK (
    planning_contract IN ('LEGACY_FULL_PLAN_V3','FIXED_SKELETON_V1')
  ),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  skeleton_hash TEXT,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 2147483647),
  model_name TEXT NOT NULL CHECK (
    NULLIF(BTRIM(model_name),'') IS NOT NULL AND OCTET_LENGTH(model_name)<=240
  ),
  prompt_template_version TEXT NOT NULL CHECK (
    NULLIF(BTRIM(prompt_template_version),'') IS NOT NULL
    AND OCTET_LENGTH(prompt_template_version)<=240
  ),
  gateway_request_id TEXT CHECK (
    gateway_request_id IS NULL OR (
      NULLIF(BTRIM(gateway_request_id),'') IS NOT NULL AND OCTET_LENGTH(gateway_request_id)<=240
    )
  ),
  response JSONB NOT NULL CHECK (
    JSONB_TYPEOF(response)='object' AND OCTET_LENGTH(response::TEXT)<=4194304
  ),
  response_hash TEXT NOT NULL CHECK (response_hash ~ '^[a-f0-9]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(received_at)),
  UNIQUE (account_id,id),
  FOREIGN KEY (account_id,job_id,item_id,source_snapshot_id,attempt_id)
    REFERENCES auto_listing_content_plan_attempts(
      account_id,job_id,item_id,source_snapshot_id,id
    ) ON DELETE CASCADE,
  FOREIGN KEY (account_id,job_id,item_id,source_snapshot_id,diagnostic_run_id)
    REFERENCES auto_listing_content_plan_diagnostic_runs(
      account_id,job_id,item_id,source_snapshot_id,id
    ) ON DELETE CASCADE,
  FOREIGN KEY (account_id,profile_id,profile_version)
    REFERENCES ai_gateway_profiles(account_id,id,config_version) ON DELETE RESTRICT,
  CHECK (
    (attempt_id IS NOT NULL AND diagnostic_run_id IS NULL)
    OR (attempt_id IS NULL AND diagnostic_run_id IS NOT NULL)
  ),
  CHECK (
    (planning_contract='LEGACY_FULL_PLAN_V3' AND skeleton_hash IS NULL)
    OR (planning_contract='FIXED_SKELETON_V1' AND skeleton_hash ~ '^[a-f0-9]{64}$')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_responses_attempt_key
  ON auto_listing_content_plan_responses(account_id,attempt_id)
  WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_content_plan_responses_diagnostic_key
  ON auto_listing_content_plan_responses(account_id,diagnostic_run_id)
  WHERE diagnostic_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_listing_content_plan_responses_item_received_idx
  ON auto_listing_content_plan_responses(account_id,job_id,item_id,received_at,id);

CREATE OR REPLACE FUNCTION validate_auto_listing_content_plan_response_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM auto_listing_content_plan_attempts AS attempt
       WHERE attempt.account_id=NEW.account_id
         AND attempt.job_id=NEW.job_id
         AND attempt.item_id=NEW.item_id
         AND attempt.source_snapshot_id=NEW.source_snapshot_id
         AND attempt.id=NEW.attempt_id
         AND attempt.profile_id=NEW.profile_id
         AND attempt.profile_version=NEW.profile_version
         AND attempt.planning_contract=NEW.planning_contract
         AND attempt.input_hash=NEW.input_hash
         AND attempt.skeleton_hash IS NOT DISTINCT FROM NEW.skeleton_hash
    ) THEN
      RAISE EXCEPTION 'content plan response attempt identity mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM auto_listing_content_plan_diagnostic_runs AS run
       WHERE run.account_id=NEW.account_id
         AND run.job_id=NEW.job_id
         AND run.item_id=NEW.item_id
         AND run.source_snapshot_id=NEW.source_snapshot_id
         AND run.id=NEW.diagnostic_run_id
         AND run.profile_id=NEW.profile_id
         AND run.profile_version=NEW.profile_version
         AND run.planning_contract=NEW.planning_contract
         AND run.input_hash=NEW.input_hash
         AND run.skeleton_hash IS NOT DISTINCT FROM NEW.skeleton_hash
         AND run.status='RUNNING'
    ) THEN
      RAISE EXCEPTION 'content plan response diagnostic identity mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_content_plan_response_owner_guard
BEFORE INSERT ON auto_listing_content_plan_responses
FOR EACH ROW EXECUTE FUNCTION validate_auto_listing_content_plan_response_owner();

CREATE TABLE IF NOT EXISTS auto_listing_content_plan_validation_results (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  response_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED','REJECTED')),
  validator_version TEXT NOT NULL CHECK (
    NULLIF(BTRIM(validator_version),'') IS NOT NULL AND OCTET_LENGTH(validator_version)<=240
  ),
  issues JSONB NOT NULL CHECK (
    JSONB_TYPEOF(issues)='array' AND JSONB_ARRAY_LENGTH(issues) BETWEEN 0 AND 100
    AND OCTET_LENGTH(issues::TEXT)<=1048576
  ),
  validated_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(validated_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,response_id),
  FOREIGN KEY (account_id,response_id)
    REFERENCES auto_listing_content_plan_responses(account_id,id) ON DELETE CASCADE,
  CHECK (
    (status='ACCEPTED' AND JSONB_ARRAY_LENGTH(issues)=0)
    OR (status='REJECTED' AND JSONB_ARRAY_LENGTH(issues) BETWEEN 1 AND 100)
  )
);

CREATE OR REPLACE FUNCTION auto_listing_content_plan_evidence_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'content plan response evidence is append only' USING ERRCODE='23514';
  END IF;
  IF OLD.attempt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM auto_listing_content_plan_attempts
     WHERE account_id=OLD.account_id AND id=OLD.attempt_id
  ) THEN
    RAISE EXCEPTION 'content plan response evidence is append only' USING ERRCODE='23514';
  END IF;
  IF OLD.diagnostic_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM auto_listing_content_plan_diagnostic_runs
     WHERE account_id=OLD.account_id AND id=OLD.diagnostic_run_id
  ) THEN
    RAISE EXCEPTION 'content plan response evidence is append only' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER auto_listing_content_plan_evidence_append_only
BEFORE UPDATE OR DELETE ON auto_listing_content_plan_responses
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_evidence_append_only();

CREATE OR REPLACE FUNCTION auto_listing_content_plan_validation_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' OR EXISTS (
    SELECT 1 FROM auto_listing_content_plan_responses
     WHERE account_id=OLD.account_id AND id=OLD.response_id
  ) THEN
    RAISE EXCEPTION 'content plan validation evidence is append only' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER auto_listing_content_plan_validation_append_only
BEFORE UPDATE OR DELETE ON auto_listing_content_plan_validation_results
FOR EACH ROW EXECUTE FUNCTION auto_listing_content_plan_validation_append_only();
