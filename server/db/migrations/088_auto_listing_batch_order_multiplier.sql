ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS source_order INTEGER;

WITH ranked AS (
  SELECT id,account_id,job_id,
         ROW_NUMBER() OVER (PARTITION BY account_id,job_id ORDER BY created_at,id)::INTEGER AS source_order
    FROM auto_listing_job_items
)
UPDATE auto_listing_job_items AS item
   SET source_order=ranked.source_order
  FROM ranked
 WHERE item.account_id=ranked.account_id AND item.job_id=ranked.job_id AND item.id=ranked.id
   AND item.source_order IS NULL;

ALTER TABLE auto_listing_job_items
  ALTER COLUMN source_order SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='auto_listing_job_items_source_order_check') THEN
    ALTER TABLE auto_listing_job_items
      ADD CONSTRAINT auto_listing_job_items_source_order_check CHECK (source_order > 0);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_batch_order_uq
  ON auto_listing_job_items(account_id,job_id,source_order);

ALTER TABLE auto_listing_preferences
  ADD COLUMN IF NOT EXISTS price_multiplier_micros BIGINT NOT NULL DEFAULT 1000000
    CHECK (price_multiplier_micros > 0);
