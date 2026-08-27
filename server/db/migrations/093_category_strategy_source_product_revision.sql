-- A category-strategy draft freezes the source product-draft revision it used.
-- The previous three-column FK pointed at the mutable product_drafts row, so a
-- later legitimate version update was blocked even though the frozen revision
-- already exists in product_draft_revisions.

ALTER TABLE auto_listing_category_strategy_drafts
  DROP CONSTRAINT IF EXISTS auto_listing_category_strateg_source_collect_item_id_sourc_fkey;

ALTER TABLE auto_listing_category_strategy_drafts
  ADD CONSTRAINT auto_listing_category_strategy_source_product_fkey
  FOREIGN KEY (source_collect_item_id,source_product_draft_id)
  REFERENCES product_drafts(collect_item_id,id) ON DELETE RESTRICT;

ALTER TABLE auto_listing_category_strategy_drafts
  ADD CONSTRAINT auto_listing_category_strategy_source_revision_fkey
  FOREIGN KEY (source_product_draft_id,source_product_draft_version)
  REFERENCES product_draft_revisions(draft_id,version) ON DELETE RESTRICT;
