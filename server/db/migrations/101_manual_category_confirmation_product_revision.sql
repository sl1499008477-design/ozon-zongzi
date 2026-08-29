-- Manual category confirmation freezes the exact product-draft revision it used.
-- The previous three-column foreign key pointed at the mutable product_drafts
-- row and blocked every later legitimate draft version update.

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid=
       'collect_ozon_category_manual_confirmation_evidence'::REGCLASS
       AND constraint_row.confrelid='product_drafts'::REGCLASS
       AND constraint_row.contype='f'
       AND pg_get_constraintdef(constraint_row.oid) LIKE
         'FOREIGN KEY (collect_item_id, trigger_product_draft_id, trigger_product_draft_version)%'
  LOOP
    EXECUTE format(
      'ALTER TABLE collect_ozon_category_manual_confirmation_evidence DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE collect_ozon_category_manual_confirmation_evidence
  ADD CONSTRAINT collect_manual_confirmation_product_draft_fkey
  FOREIGN KEY (collect_item_id,trigger_product_draft_id)
  REFERENCES product_drafts(collect_item_id,id) ON DELETE CASCADE;

ALTER TABLE collect_ozon_category_manual_confirmation_evidence
  ADD CONSTRAINT collect_manual_confirmation_product_revision_fkey
  FOREIGN KEY (trigger_product_draft_id,trigger_product_draft_version)
  REFERENCES product_draft_revisions(draft_id,version) ON DELETE CASCADE;
