ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS recovery_point TEXT;

ALTER TABLE auto_listing_events
  ADD COLUMN IF NOT EXISTS transition_version INTEGER CHECK (transition_version > 0);

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_events_item_transition_version_key
  ON auto_listing_events(item_id, transition_version)
  WHERE item_id IS NOT NULL AND transition_version IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'auto_listing_job_items_recovery_point_check'
       AND conrelid = 'auto_listing_job_items'::regclass
  ) THEN
    ALTER TABLE auto_listing_job_items
      ADD CONSTRAINT auto_listing_job_items_recovery_point_check
      CHECK (recovery_point IS NULL OR recovery_point IN ('PLANNING', 'GENERATION', 'UPLOAD'));
  END IF;
END;
$$;
