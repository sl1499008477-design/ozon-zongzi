-- The graph transaction takes over the category safety boundary from the
-- preparation session.  Lease finalization and job binding are one commit.

ALTER TABLE auto_listing_jobs
  ADD CONSTRAINT auto_listing_jobs_account_id_id_unique UNIQUE (account_id,id);

ALTER TABLE auto_listing_category_preparation_leases
  ADD COLUMN holder_backend_started_at TIMESTAMPTZ,
  ADD COLUMN finalized_job_id TEXT,
  ADD CONSTRAINT auto_listing_category_preparation_lease_finalized_job_fk
    FOREIGN KEY (account_id,finalized_job_id)
    REFERENCES auto_listing_jobs(account_id,id) DEFERRABLE INITIALLY DEFERRED;

UPDATE auto_listing_category_preparation_leases lease
   SET holder_backend_started_at=COALESCE(
     (SELECT activity.backend_start FROM pg_stat_activity activity
       WHERE activity.pid=lease.holder_backend_pid AND activity.datname=current_database()),
     lease.acquired_at
   );

ALTER TABLE auto_listing_category_preparation_leases
  ALTER COLUMN holder_backend_started_at SET NOT NULL;

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
    OR (OLD.finalized_job_id IS NOT NULL AND NEW.finalized_job_id<>OLD.finalized_job_id)
    OR (NEW.finalized_job_id IS NOT NULL AND NEW.outcome<>'COMMITTED')
  THEN
    RAISE EXCEPTION 'invalid auto-listing category preparation lease transition'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE auto_listing_jobs
  ADD COLUMN category_preparation_lease_id TEXT;

CREATE UNIQUE INDEX auto_listing_jobs_category_preparation_lease_unique
  ON auto_listing_jobs(account_id,category_preparation_lease_id)
  WHERE category_preparation_lease_id IS NOT NULL;

ALTER TABLE auto_listing_jobs
  ADD CONSTRAINT auto_listing_jobs_category_preparation_lease_fk
    FOREIGN KEY (account_id,category_preparation_lease_id)
    REFERENCES auto_listing_category_preparation_leases(account_id,id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION finalize_auto_listing_category_graph_handoff()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  lease_row auto_listing_category_preparation_leases%ROWTYPE;
BEGIN
  IF NEW.category_preparation_lease_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO lease_row
    FROM auto_listing_category_preparation_leases
   WHERE account_id=NEW.account_id AND id=NEW.category_preparation_lease_id
   FOR UPDATE;
  IF lease_row.id IS NULL OR lease_row.state<>'ACTIVE'
    OR lease_row.expires_at<=clock_timestamp()
    OR lease_row.finalized_job_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_stat_activity activity
       WHERE activity.pid=lease_row.holder_backend_pid
         AND activity.datname=current_database()
         AND activity.backend_start=lease_row.holder_backend_started_at
    )
    OR EXISTS (
      SELECT 1 FROM auto_listing_category_preparation_lease_items lease_item
       WHERE lease_item.account_id=lease_row.account_id AND lease_item.lease_id=lease_row.id
         AND NOT EXISTS (
           SELECT 1 FROM pg_locks held_lock
            WHERE held_lock.pid IN (lease_row.holder_backend_pid,pg_backend_pid())
              AND held_lock.locktype='advisory' AND held_lock.mode='ShareLock'
              AND held_lock.granted IS TRUE AND held_lock.objsubid=1
              AND ((held_lock.classid::BIGINT << 32) | held_lock.objid::BIGINT)
                = account_ozon_shared_category_lease_key(
                  lease_item.account_id,lease_item.shared_category_id
                )
         )
    )
  THEN
    RAISE EXCEPTION 'auto-listing category preparation lease cannot commit'
      USING ERRCODE='23514';
  END IF;
  UPDATE auto_listing_category_preparation_leases
     SET state='RELEASED',outcome='COMMITTED',finalized_job_id=NEW.id,
         released_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE account_id=NEW.account_id AND id=NEW.category_preparation_lease_id
     AND state='ACTIVE' AND expires_at>clock_timestamp()
     AND finalized_job_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auto-listing category preparation lease cannot commit'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER auto_listing_jobs_category_handoff_commit_guard
AFTER INSERT ON auto_listing_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finalize_auto_listing_category_graph_handoff();
