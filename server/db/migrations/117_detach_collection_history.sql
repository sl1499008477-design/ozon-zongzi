-- Strategy source snapshots and business history outlive collection records.
ALTER TABLE auto_listing_category_strategy_drafts ADD COLUMN source_snapshot JSONB;
CREATE OR REPLACE FUNCTION auto_listing_category_strategy_draft_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.status='PUBLISHED'
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_sample_sets WHERE account_id=OLD.account_id AND draft_id=OLD.id AND status='SEALED')
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_analysis_attempts WHERE account_id=OLD.account_id AND draft_id=OLD.id)
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_analysis_results WHERE account_id=OLD.account_id AND draft_id=OLD.id)
      OR EXISTS (SELECT 1 FROM auto_listing_category_strategy_events WHERE account_id=OLD.account_id AND draft_id=OLD.id)
    THEN
      RAISE EXCEPTION 'draft with immutable evidence cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE' AND ROW(
    NEW.id,NEW.account_id,NEW.taxonomy_scope,NEW.description_category_id,NEW.type_id,
    NEW.source_collect_item_id,NEW.source_product_draft_id,NEW.source_product_draft_version,
    NEW.expected_source_version,NEW.idempotency_key,NEW.request_hash,NEW.actor_account_id,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.taxonomy_scope,OLD.description_category_id,OLD.type_id,
    OLD.source_collect_item_id,OLD.source_product_draft_id,OLD.source_product_draft_version,
    OLD.expected_source_version,OLD.idempotency_key,OLD.request_hash,OLD.actor_account_id,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'draft source identity is immutable' USING ERRCODE='23514';
  END IF;

  IF TG_OP='UPDATE' AND OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'removed draft cannot be restored or re-removed' USING ERRCODE='23514';
  END IF;

  -- The current-source assertion belongs only at the insertion trust boundary.
  -- Historical drafts remain readable and archivable after their source product advances.
  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM collect_items item
    JOIN product_drafts product_draft
      ON product_draft.collect_item_id=item.id
     AND product_draft.id=item.current_draft_id
     AND product_draft.version=NEW.source_product_draft_version
   WHERE item.account_id=NEW.account_id
     AND item.id=NEW.source_collect_item_id
     AND product_draft.id=NEW.source_product_draft_id
     AND NEW.expected_source_version='draft:' || product_draft.version::TEXT
  ) THEN
    RAISE EXCEPTION 'draft source is not the exact current tenant draft' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE auto_listing_category_strategy_drafts s SET source_snapshot=jsonb_build_object(
 'sourceUrl',c.source_url,'productDraft',COALESCE(r.data,d.data),'version',s.source_product_draft_version)
FROM collect_items c,product_drafts d LEFT JOIN product_draft_revisions r ON r.draft_id=d.id
WHERE c.id=s.source_collect_item_id AND c.account_id=s.account_id AND d.id=s.source_product_draft_id
AND r.version=s.source_product_draft_version;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM auto_listing_category_strategy_drafts WHERE source_snapshot IS NULL) THEN
 RAISE EXCEPTION 'Strategy snapshot backfill incomplete'; END IF; END $$;
CREATE FUNCTION capture_category_strategy_source_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot THEN RAISE EXCEPTION 'Strategy source snapshot is immutable'; END IF;
  RETURN NEW;
 END IF;
 SELECT jsonb_build_object('sourceUrl',c.source_url,'productDraft',d.data,'version',d.version)
 INTO NEW.source_snapshot FROM collect_items c JOIN product_drafts d ON d.id=c.current_draft_id
 WHERE c.account_id=NEW.account_id AND c.id=NEW.source_collect_item_id AND c.deleted_at IS NULL
 AND d.id=NEW.source_product_draft_id AND d.version=NEW.source_product_draft_version;
 IF NEW.source_snapshot IS NULL THEN RAISE EXCEPTION 'Strategy source missing or outside account'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_category_strategy_snapshot BEFORE INSERT OR UPDATE ON auto_listing_category_strategy_drafts
FOR EACH ROW EXECUTE FUNCTION capture_category_strategy_source_snapshot();
-- IDs retained below are provenance, not live foreign keys. New writes remain scoped.
DO $$ DECLARE r RECORD; BEGIN
 FOR r IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint WHERE contype='f'
 AND conrelid IN ('auto_listing_category_strategy_drafts'::regclass,'auto_listing_listing_bases'::regclass,'auto_listing_import_rows'::regclass)
 AND confrelid IN ('collect_items'::regclass,'product_drafts'::regclass,'product_draft_revisions'::regclass)
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.conname); END LOOP;
END $$;
CREATE FUNCTION check_business_collection_source() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.collect_item_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.collect_item_id IS NOT DISTINCT FROM OLD.collect_item_id AND NEW.account_id=OLD.account_id THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM collect_items WHERE id=NEW.collect_item_id AND account_id=NEW.account_id AND deleted_at IS NULL) THEN
 RAISE EXCEPTION 'Collection source missing or outside account'; END IF;
 IF TG_TABLE_NAME='auto_listing_listing_bases' THEN
  IF NOT EXISTS(SELECT 1 FROM product_drafts WHERE id=NEW.product_draft_id AND collect_item_id=NEW.collect_item_id) THEN
   RAISE EXCEPTION 'Product draft does not belong to collection source';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_collection_source BEFORE INSERT OR UPDATE ON auto_listing_import_rows FOR EACH ROW EXECUTE FUNCTION check_business_collection_source();
CREATE TRIGGER business_collection_source BEFORE INSERT ON auto_listing_listing_bases FOR EACH ROW EXECUTE FUNCTION check_business_collection_source();
