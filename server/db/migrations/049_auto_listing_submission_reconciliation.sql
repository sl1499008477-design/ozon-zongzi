-- Durable, tenant-scoped reconciliation for auto-listing submissions.
-- This migration is additive: existing submission and auto-listing evidence is
-- preserved and every reconciliation transition remains auditable.

CREATE UNIQUE INDEX IF NOT EXISTS submission_jobs_account_id_id_key
  ON submission_jobs(account_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_submission_links_reconcile_binding_key
  ON auto_listing_submission_links(
    account_id,job_id,auto_listing_item_id,id,submission_job_id
  );

CREATE TABLE IF NOT EXISTS auto_listing_submission_reconcile_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  auto_listing_item_id TEXT NOT NULL,
  submission_link_id TEXT NOT NULL,
  submission_job_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','LEASED','COMPLETED','DEAD')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 1000),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW() CHECK (ISFINITE(next_run_at)),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,submission_link_id),
  UNIQUE (account_id,id),
  FOREIGN KEY (account_id,job_id,auto_listing_item_id,submission_link_id,submission_job_id)
    REFERENCES auto_listing_submission_links(
      account_id,job_id,auto_listing_item_id,id,submission_job_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,submission_job_id)
    REFERENCES submission_jobs(account_id,id) ON DELETE RESTRICT,
  CHECK (state <> 'DEAD' OR last_error_code IS NOT NULL),
  CHECK (
    (state = 'LEASED'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND ISFINITE(lease_expires_at))
    OR (state <> 'LEASED'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS auto_listing_submission_reconcile_tasks_runnable_idx
  ON auto_listing_submission_reconcile_tasks(state,next_run_at,lease_expires_at,created_at)
  WHERE state IN ('PENDING','LEASED');

CREATE TABLE IF NOT EXISTS auto_listing_submission_reconcile_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  reconcile_task_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('CREATED','LEASED','RESCHEDULED','COMPLETED','DEAD')
  ),
  from_state TEXT CHECK (
    from_state IS NULL OR from_state IN ('PENDING','LEASED','COMPLETED','DEAD')
  ),
  to_state TEXT NOT NULL CHECK (
    to_state IN ('PENDING','LEASED','COMPLETED','DEAD')
  ),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1000),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id), '') IS NOT NULL),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(evidence) = 'object' AND OCTET_LENGTH(evidence::TEXT) <= 4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id,reconcile_task_id)
    REFERENCES auto_listing_submission_reconcile_tasks(account_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS auto_listing_submission_reconcile_events_task_idx
  ON auto_listing_submission_reconcile_events(account_id,reconcile_task_id,created_at,id);

CREATE OR REPLACE FUNCTION auto_listing_reconcile_task_identity_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.auto_listing_item_id IS DISTINCT FROM OLD.auto_listing_item_id
    OR NEW.submission_link_id IS DISTINCT FROM OLD.submission_link_id
    OR NEW.submission_job_id IS DISTINCT FROM OLD.submission_job_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at
    OR (NEW.state = 'DEAD' AND NEW.last_error_code IS NULL)
    OR NOT (
      (OLD.state = 'PENDING' AND NEW.state = 'LEASED'
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.lease_expires_at > STATEMENT_TIMESTAMP())
      OR (OLD.state = 'LEASED' AND NEW.state = 'LEASED'
        AND OLD.lease_expires_at <= STATEMENT_TIMESTAMP()
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.lease_expires_at > STATEMENT_TIMESTAMP())
      OR (OLD.state = 'LEASED' AND NEW.state IN ('PENDING','COMPLETED','DEAD')
        AND NEW.attempt_count = OLD.attempt_count)
      OR (OLD.state = 'PENDING' AND NEW.state = 'DEAD'
        AND NEW.attempt_count = OLD.attempt_count)
    )
  THEN
    RAISE EXCEPTION 'invalid auto-listing reconciliation task mutation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_submission_reconcile_tasks_protected
  ON auto_listing_submission_reconcile_tasks;
CREATE TRIGGER auto_listing_submission_reconcile_tasks_protected
BEFORE UPDATE OR DELETE ON auto_listing_submission_reconcile_tasks
FOR EACH ROW EXECUTE FUNCTION auto_listing_reconcile_task_identity_is_immutable();

CREATE OR REPLACE FUNCTION auto_listing_reject_reconcile_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing reconciliation events are append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_submission_reconcile_events_append_only
  ON auto_listing_submission_reconcile_events;
CREATE TRIGGER auto_listing_submission_reconcile_events_append_only
BEFORE UPDATE OR DELETE ON auto_listing_submission_reconcile_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_reconcile_event_mutation();
