-- Hide an administrator-removed category-strategy draft while retaining its
-- immutable samples, analysis, publication history, and audit evidence.

ALTER TABLE auto_listing_category_strategy_drafts
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE auto_listing_category_strategy_drafts
    ADD CONSTRAINT auto_listing_category_strategy_removed_at_valid
    CHECK (removed_at IS NULL OR (ISFINITE(removed_at) AND ended_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS auto_listing_category_strategy_visible_drafts
  ON auto_listing_category_strategy_drafts(account_id,updated_at DESC,id DESC)
  WHERE removed_at IS NULL;

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
