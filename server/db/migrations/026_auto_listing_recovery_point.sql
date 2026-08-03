ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS recovery_point TEXT;

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
