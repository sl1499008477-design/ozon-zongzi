-- Explicit administrator recovery for the same immutable reconciliation task.
-- Attempt history remains append-only in events while the current generation restarts at zero.

ALTER TABLE auto_listing_submission_reconcile_tasks
  ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='auto_listing_submission_reconcile_tasks_recovery_count_check'
       AND conrelid='auto_listing_submission_reconcile_tasks'::regclass
  ) THEN
    ALTER TABLE auto_listing_submission_reconcile_tasks
      ADD CONSTRAINT auto_listing_submission_reconcile_tasks_recovery_count_check
      CHECK (recovery_count BETWEEN 0 AND 1000);
  END IF;
END;
$$;

ALTER TABLE auto_listing_submission_reconcile_events
  DROP CONSTRAINT IF EXISTS auto_listing_submission_reconcile_events_event_type_check;
ALTER TABLE auto_listing_submission_reconcile_events
  ADD CONSTRAINT auto_listing_submission_reconcile_events_event_type_check CHECK (
    event_type IN ('CREATED','LEASED','RESCHEDULED','COMPLETED','DEAD','RECOVERED')
  );

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
      (NEW.recovery_count = OLD.recovery_count AND (
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
      ))
      OR (OLD.state = 'DEAD' AND NEW.state = 'PENDING'
        AND NEW.attempt_count = 0
        AND NEW.recovery_count = OLD.recovery_count + 1
        AND NEW.last_error_code IS NULL
        AND NEW.next_run_at <= STATEMENT_TIMESTAMP())
    )
  THEN
    RAISE EXCEPTION 'invalid auto-listing reconciliation task mutation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_reconciliation_recovery_audit_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.action = 'AUTO_LISTING_RECONCILIATION_TASK_RECOVERED'
    OR (TG_OP = 'UPDATE' AND NEW.action = 'AUTO_LISTING_RECONCILIATION_TASK_RECOVERED')
  THEN
    RAISE EXCEPTION 'auto-listing reconciliation recovery audits are append-only'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_reconciliation_recovery_audit_append_only_trigger
  ON audit_events;
CREATE TRIGGER auto_listing_reconciliation_recovery_audit_append_only_trigger
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_reconciliation_recovery_audit_append_only();
