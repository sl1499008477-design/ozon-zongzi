-- Versioned publication policy and exact immutable evidence. Existing V1 rows
-- stay untouched and readable; operators must bump the explicit policy version
-- before retiring or replacing a public base URL/prefix.

ALTER TABLE auto_listing_asset_publications
  DROP CONSTRAINT IF EXISTS auto_listing_asset_publications_publication_version_check;

ALTER TABLE auto_listing_asset_publications
  ADD CONSTRAINT auto_listing_asset_publication_version_format_check
  CHECK (publication_version ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$');

ALTER TABLE auto_listing_asset_publications
  DROP CONSTRAINT IF EXISTS auto_listing_asset_publicatio_account_id_asset_id_content_h_key;

ALTER TABLE auto_listing_asset_publications
  ADD CONSTRAINT auto_listing_asset_publication_asset_version_key
  UNIQUE (account_id,asset_id,content_hash,publication_version);

ALTER TABLE auto_listing_asset_publications
  DROP CONSTRAINT IF EXISTS auto_listing_asset_publication_account_id_public_object_key_key;

ALTER TABLE auto_listing_asset_publications
  ADD CONSTRAINT auto_listing_asset_publication_object_version_key
  UNIQUE (account_id,public_object_key,publication_version);

CREATE OR REPLACE FUNCTION auto_listing_validate_asset_publication_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Lock the item row so its active plan cannot change between validation and
  -- committing the immutable publication evidence.
  PERFORM 1
  FROM auto_listing_job_items AS item
  WHERE item.account_id = NEW.account_id
    AND item.job_id = NEW.job_id
    AND item.id = NEW.item_id
    AND item.active_content_plan_id = NEW.plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset publication plan is not current' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM ai_generation_assets AS asset
  WHERE asset.account_id = NEW.account_id
    AND asset.job_id = NEW.job_id
    AND asset.item_id = NEW.item_id
    AND asset.plan_id = NEW.plan_id
    AND asset.id = NEW.asset_id
    AND asset.status = 'ACCEPTED'
    AND asset.object_key_version = 'ATTEMPT_V2'
    AND NEW.visual_group_key = asset.visual_group_key
    AND NEW.slot_key = asset.slot_key
    AND NEW.role = asset.role
    AND NEW.content_hash = asset.content_hash
    AND NEW.content_type = asset.content_type
    AND NEW.size_bytes = asset.size_bytes
    AND NEW.width = asset.width
    AND NEW.height = asset.height
    AND NEW.private_object_key = asset.object_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset publication evidence does not match accepted asset' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_asset_publications_insert_integrity
  ON auto_listing_asset_publications;

CREATE TRIGGER auto_listing_asset_publications_insert_integrity
BEFORE INSERT ON auto_listing_asset_publications
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_asset_publication_insert();
