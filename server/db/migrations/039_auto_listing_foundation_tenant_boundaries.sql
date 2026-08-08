-- Refuse to validate composite tenant boundaries over polluted historical rows.
-- This migration never rewrites ownership evidence automatically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auto_listing_job_items item
    JOIN auto_listing_jobs job ON job.id = item.job_id
    WHERE item.account_id IS DISTINCT FROM job.account_id
  ) THEN
    RAISE EXCEPTION 'auto-listing historical tenant boundary violation: item job account';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM auto_listing_job_items item
    JOIN auto_listing_source_snapshots snapshot ON snapshot.id = item.snapshot_id
    WHERE item.account_id IS DISTINCT FROM snapshot.account_id
  ) THEN
    RAISE EXCEPTION 'auto-listing historical tenant boundary violation: item snapshot account';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM auto_listing_job_items item
    JOIN stores store ON store.id = item.target_store_id
    WHERE item.account_id IS DISTINCT FROM store.owner_account_id
  ) THEN
    RAISE EXCEPTION 'auto-listing historical tenant boundary violation: item store account';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM auto_listing_job_items item
    JOIN warehouses warehouse ON warehouse.id = item.target_warehouse_id
    WHERE item.target_store_id IS DISTINCT FROM warehouse.store_id
  ) THEN
    RAISE EXCEPTION 'auto-listing historical tenant boundary violation: item warehouse store';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM auto_listing_events event
    JOIN auto_listing_jobs job ON job.id = event.job_id
    WHERE event.account_id IS DISTINCT FROM job.account_id
  ) THEN
    RAISE EXCEPTION 'auto-listing historical tenant boundary violation: event job account';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM auto_listing_events event
    JOIN auto_listing_job_items item ON item.id = event.item_id
    WHERE event.item_id IS NOT NULL
      AND (event.account_id IS DISTINCT FROM item.account_id
        OR event.job_id IS DISTINCT FROM item.job_id)
  ) THEN
    RAISE EXCEPTION 'auto-listing historical tenant boundary violation: event item scope';
  END IF;
END;
$$;

ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_account_job_scope_fkey
  FOREIGN KEY (account_id,job_id)
  REFERENCES auto_listing_jobs(account_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_account_snapshot_scope_fkey
  FOREIGN KEY (account_id,snapshot_id)
  REFERENCES auto_listing_source_snapshots(account_id,id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_account_store_scope_fkey
  FOREIGN KEY (account_id,target_store_id)
  REFERENCES stores(owner_account_id,id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_store_warehouse_scope_fkey
  FOREIGN KEY (target_store_id,target_warehouse_id)
  REFERENCES warehouses(store_id,id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE auto_listing_events
  ADD CONSTRAINT auto_listing_events_account_job_scope_fkey
  FOREIGN KEY (account_id,job_id)
  REFERENCES auto_listing_jobs(account_id,id) ON DELETE CASCADE NOT VALID;
ALTER TABLE auto_listing_events
  ADD CONSTRAINT auto_listing_events_account_job_item_scope_fkey
  FOREIGN KEY (account_id,job_id,item_id)
  REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE CASCADE NOT VALID;

ALTER TABLE auto_listing_job_items
  VALIDATE CONSTRAINT auto_listing_job_items_account_job_scope_fkey;
ALTER TABLE auto_listing_job_items
  VALIDATE CONSTRAINT auto_listing_job_items_account_snapshot_scope_fkey;
ALTER TABLE auto_listing_job_items
  VALIDATE CONSTRAINT auto_listing_job_items_account_store_scope_fkey;
ALTER TABLE auto_listing_job_items
  VALIDATE CONSTRAINT auto_listing_job_items_store_warehouse_scope_fkey;
ALTER TABLE auto_listing_events
  VALIDATE CONSTRAINT auto_listing_events_account_job_scope_fkey;
ALTER TABLE auto_listing_events
  VALIDATE CONSTRAINT auto_listing_events_account_job_item_scope_fkey;
