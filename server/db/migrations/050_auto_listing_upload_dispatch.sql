-- Durable dispatch for every transition into UPLOAD_QUEUED.  The task is
-- tenant-bound and survives web/worker process restarts.

ALTER TABLE auto_listing_user_commands
  DROP CONSTRAINT IF EXISTS auto_listing_user_commands_action_check;
ALTER TABLE auto_listing_user_commands
  ADD CONSTRAINT auto_listing_user_commands_action_check
  CHECK (action IN ('CANCEL','REGENERATE','APPROVE_UPLOAD'));

CREATE TABLE IF NOT EXISTS auto_listing_upload_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  expected_status_version INTEGER NOT NULL
    CHECK (expected_status_version > 0 AND expected_status_version < 2147483647),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id), '') IS NOT NULL),
  enqueue_reason TEXT NOT NULL
    CHECK (enqueue_reason IN ('REVIEW_APPROVED','DIRECT_READY','SAFE_RETRY')),
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','LEASED','COMPLETED','DEAD')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW() CHECK (ISFINITE(next_run_at)),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('SUBMITTED','HANDED_OFF','STALE','BLOCKED')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,id),
  UNIQUE (account_id,item_id,expected_status_version),
  FOREIGN KEY (account_id,job_id,item_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE RESTRICT,
  CHECK (actor_account_id = account_id),
  CHECK (state <> 'DEAD' OR last_error_code IS NOT NULL),
  CHECK (
    (state = 'LEASED'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL AND ISFINITE(lease_expires_at))
    OR (state <> 'LEASED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS auto_listing_upload_tasks_runnable_idx
  ON auto_listing_upload_tasks(account_id,state,next_run_at,lease_expires_at,created_at,id)
  WHERE state IN ('PENDING','LEASED');

CREATE TABLE IF NOT EXISTS auto_listing_upload_task_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  upload_task_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('CREATED','LEASED','RESCHEDULED','COMPLETED','DEAD')),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('PENDING','LEASED','COMPLETED','DEAD')),
  to_state TEXT NOT NULL CHECK (to_state IN ('PENDING','LEASED','COMPLETED','DEAD')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1000),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id), '') IS NOT NULL),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(evidence) = 'object' AND OCTET_LENGTH(evidence::TEXT) <= 4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id,upload_task_id)
    REFERENCES auto_listing_upload_tasks(account_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS auto_listing_upload_task_events_task_idx
  ON auto_listing_upload_task_events(account_id,upload_task_id,created_at,id);

CREATE OR REPLACE FUNCTION auto_listing_upload_task_identity_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id
    OR NEW.expected_status_version IS DISTINCT FROM OLD.expected_status_version
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.enqueue_reason IS DISTINCT FROM OLD.enqueue_reason
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at
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
    )
  THEN
    RAISE EXCEPTION 'invalid auto-listing upload task mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_upload_tasks_protected ON auto_listing_upload_tasks;
CREATE TRIGGER auto_listing_upload_tasks_protected
BEFORE UPDATE OR DELETE ON auto_listing_upload_tasks
FOR EACH ROW EXECUTE FUNCTION auto_listing_upload_task_identity_is_immutable();

CREATE OR REPLACE FUNCTION auto_listing_upload_task_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing upload task events are append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_upload_task_events_append_only_trigger
  ON auto_listing_upload_task_events;
CREATE TRIGGER auto_listing_upload_task_events_append_only_trigger
BEFORE UPDATE OR DELETE ON auto_listing_upload_task_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_upload_task_events_append_only();
