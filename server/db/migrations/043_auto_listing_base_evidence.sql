-- Compatibility bridge for development databases that applied 038 before the
-- complete V1 listing-base contract gained store, pricing and category evidence.
ALTER TABLE auto_listing_listing_bases
  ADD COLUMN IF NOT EXISTS target_store_id TEXT,
  ADD COLUMN IF NOT EXISTS pricing_evidence JSONB,
  ADD COLUMN IF NOT EXISTS rich_content_attribute_supported BOOLEAN,
  ADD COLUMN IF NOT EXISTS listing_base_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='auto_listing_listing_bases'::regclass
       AND conname='auto_listing_listing_bases_target_store_fkey'
  ) THEN
    ALTER TABLE auto_listing_listing_bases
      ADD CONSTRAINT auto_listing_listing_bases_target_store_fkey
      FOREIGN KEY (account_id,target_store_id)
      REFERENCES stores(owner_account_id,id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_require_complete_listing_base_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_store_id IS NULL
    OR NEW.pricing_evidence IS NULL
    OR jsonb_typeof(NEW.pricing_evidence) <> 'object'
    OR NEW.pricing_evidence->>'currency' <> 'RUB'
    OR COALESCE(NEW.pricing_evidence->>'evidenceHash','') !~ '^[a-f0-9]{64}$'
    OR NEW.rich_content_attribute_supported IS NULL
    OR NEW.listing_base_version IS DISTINCT FROM 'AUTO_LISTING_LISTING_BASE_V1'
  THEN
    RAISE EXCEPTION 'new auto-listing listing bases require complete V1 evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_listing_bases_complete_v1
BEFORE INSERT ON auto_listing_listing_bases
FOR EACH ROW EXECUTE FUNCTION auto_listing_require_complete_listing_base_v1();
