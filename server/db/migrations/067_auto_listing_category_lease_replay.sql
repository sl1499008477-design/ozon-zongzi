-- A late idempotency replay owns no graph.  Record the exact winning job
-- without allowing the replaying lease to look like the graph's committer.

-- This migration is one transaction under db/migrate.mjs.  Freeze both sides
-- before inspecting historical 066 rows so a writer cannot race the preflight.
LOCK TABLE auto_listing_jobs,auto_listing_category_preparation_leases
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM auto_listing_category_preparation_leases lease
      LEFT JOIN auto_listing_jobs job
        ON job.account_id=lease.account_id AND job.id=lease.finalized_job_id
     WHERE lease.finalized_job_id IS NOT NULL
       AND (lease.outcome IS DISTINCT FROM 'COMMITTED'
         OR job.id IS NULL
         OR job.category_preparation_lease_id IS DISTINCT FROM lease.id)
  ) OR EXISTS (
    SELECT 1
      FROM auto_listing_jobs job
      LEFT JOIN auto_listing_category_preparation_leases lease
        ON lease.account_id=job.account_id AND lease.id=job.category_preparation_lease_id
     WHERE job.category_preparation_lease_id IS NOT NULL
       AND (lease.id IS NULL
         OR lease.outcome IS DISTINCT FROM 'COMMITTED'
         OR lease.finalized_job_id IS DISTINCT FROM job.id)
  ) THEN
    RAISE EXCEPTION 'historical category lease/job binding requires manual repair'
      USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE auto_listing_category_preparation_leases
  ADD COLUMN replayed_job_id TEXT,
  ADD CONSTRAINT auto_listing_category_preparation_lease_replayed_job_fk
    FOREIGN KEY (account_id,replayed_job_id)
    REFERENCES auto_listing_jobs(account_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auto_listing_category_preparation_leases
  DROP CONSTRAINT auto_listing_category_preparation_leases_outcome_check;

ALTER TABLE auto_listing_category_preparation_leases
  ADD CONSTRAINT auto_listing_category_preparation_leases_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('COMMITTED','REPLAYED','FAILED','CONFLICT','TIMEOUT','CRASHED'));

-- 066 was not released independently, but make this forward migration safe if
-- a deployment observed the old release response-loss window.
ALTER TABLE auto_listing_category_preparation_leases
  DISABLE TRIGGER auto_listing_category_preparation_leases_transition_guard;
UPDATE auto_listing_category_preparation_leases
   SET outcome='FAILED',updated_at=clock_timestamp()
 WHERE state='RELEASED' AND outcome='COMMITTED' AND finalized_job_id IS NULL;
ALTER TABLE auto_listing_category_preparation_leases
  ENABLE TRIGGER auto_listing_category_preparation_leases_transition_guard;

ALTER TABLE auto_listing_category_preparation_leases
  ADD CONSTRAINT auto_listing_category_preparation_lease_job_outcome_check CHECK (
    COALESCE(outcome='COMMITTED',FALSE) = (finalized_job_id IS NOT NULL)
    AND COALESCE(outcome='REPLAYED',FALSE) = (replayed_job_id IS NOT NULL)
    AND NOT (finalized_job_id IS NOT NULL AND replayed_job_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION guard_auto_listing_category_preparation_lease_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id
    OR NEW.holder_backend_pid<>OLD.holder_backend_pid
    OR NEW.holder_backend_started_at<>OLD.holder_backend_started_at
    OR NEW.acquired_at<>OLD.acquired_at OR NEW.expires_at<>OLD.expires_at
    OR OLD.state<>'ACTIVE' OR NEW.state='ACTIVE'
    OR NEW.released_at IS NULL OR NEW.outcome IS NULL
    OR NEW.updated_at<OLD.updated_at
    OR OLD.finalized_job_id IS NOT NULL OR OLD.replayed_job_id IS NOT NULL
    OR ((NEW.outcome='COMMITTED') <> (NEW.finalized_job_id IS NOT NULL))
    OR ((NEW.outcome='REPLAYED') <> (NEW.replayed_job_id IS NOT NULL))
    OR (NEW.finalized_job_id IS NOT NULL AND NEW.replayed_job_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'invalid auto-listing category preparation lease transition'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION assert_auto_listing_category_lease_job_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  lease_row auto_listing_category_preparation_leases%ROWTYPE;
BEGIN
  lease_row := NEW;
  IF lease_row.outcome NOT IN ('COMMITTED','REPLAYED') THEN
    RETURN NEW;
  END IF;
  IF lease_row.outcome='COMMITTED'
    AND NOT EXISTS (
      SELECT 1 FROM auto_listing_jobs job
       WHERE job.account_id=lease_row.account_id
         AND job.id=lease_row.finalized_job_id
         AND job.category_preparation_lease_id=lease_row.id
    )
  THEN
    RAISE EXCEPTION 'committed category lease does not own its finalized job'
      USING ERRCODE='23514';
  END IF;
  IF lease_row.outcome='REPLAYED'
    AND NOT EXISTS (
      SELECT 1 FROM auto_listing_jobs job
       WHERE job.account_id=lease_row.account_id
         AND job.id=lease_row.replayed_job_id
         AND job.category_preparation_lease_id IS NOT NULL
         AND job.category_preparation_lease_id<>lease_row.id
    )
  THEN
    RAISE EXCEPTION 'replayed category lease cannot own its replayed job'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER auto_listing_category_lease_job_binding_guard
AFTER INSERT OR UPDATE ON auto_listing_category_preparation_leases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_auto_listing_category_lease_job_binding();

CREATE OR REPLACE FUNCTION assert_auto_listing_job_category_lease_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  lease_row auto_listing_category_preparation_leases%ROWTYPE;
BEGIN
  FOR lease_row IN
    SELECT lease.* FROM auto_listing_category_preparation_leases lease
     WHERE lease.account_id=NEW.account_id
       AND (lease.finalized_job_id=NEW.id OR lease.replayed_job_id=NEW.id)
  LOOP
    IF lease_row.outcome='COMMITTED'
      AND NEW.category_preparation_lease_id IS DISTINCT FROM lease_row.id
    THEN
      RAISE EXCEPTION 'finalized job does not own its committed category lease'
        USING ERRCODE='23514';
    END IF;
    IF lease_row.outcome='REPLAYED'
      AND (NEW.category_preparation_lease_id IS NULL
        OR NEW.category_preparation_lease_id=lease_row.id)
    THEN
      RAISE EXCEPTION 'replayed job cannot be owned by the replaying category lease'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER auto_listing_jobs_category_lease_binding_guard
AFTER INSERT OR UPDATE ON auto_listing_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_auto_listing_job_category_lease_binding();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM auto_listing_category_preparation_leases lease
      LEFT JOIN auto_listing_jobs job
        ON job.account_id=lease.account_id AND job.id=lease.finalized_job_id
     WHERE lease.outcome='COMMITTED'
       AND (lease.finalized_job_id IS NULL
         OR job.category_preparation_lease_id IS DISTINCT FROM lease.id)
  ) OR EXISTS (
    SELECT 1
      FROM auto_listing_category_preparation_leases lease
      LEFT JOIN auto_listing_jobs job
        ON job.account_id=lease.account_id AND job.id=lease.replayed_job_id
     WHERE lease.outcome='REPLAYED'
       AND (lease.replayed_job_id IS NULL
         OR job.category_preparation_lease_id IS NULL
         OR job.category_preparation_lease_id=lease.id)
  ) OR EXISTS (
    SELECT 1
      FROM auto_listing_jobs job
      LEFT JOIN auto_listing_category_preparation_leases lease
        ON lease.account_id=job.account_id AND lease.id=job.category_preparation_lease_id
     WHERE job.category_preparation_lease_id IS NOT NULL
       AND (lease.outcome IS DISTINCT FROM 'COMMITTED'
         OR lease.finalized_job_id IS DISTINCT FROM job.id)
  ) THEN
    RAISE EXCEPTION 'category lease/job binding validation failed'
      USING ERRCODE='23514';
  END IF;
END;
$$;
