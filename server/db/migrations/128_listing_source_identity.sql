-- Keep the source platform next to the source SKU, independently of collect-box deletion.
-- Empty legacy identities remain unknown; target offer/product IDs are never source SKUs.
ALTER TABLE submission_items ADD COLUMN source TEXT NOT NULL DEFAULT '';

UPDATE submission_items i
SET source=CASE WHEN lower(c.source) IN ('ozon','auto_listing_excel_sku') THEN 'ozon' ELSE lower(c.source) END
FROM submission_jobs j
JOIN collect_items c ON c.id=j.collect_item_id AND c.account_id=j.account_id
WHERE i.job_id=j.id AND i.snapshot_id=j.snapshot_id AND c.source<>'';

CREATE INDEX submission_items_success_source_sku_idx ON submission_items(sku,job_id)
WHERE status='SUCCEEDED' AND sku<>'';

-- Batch history checks filter identities before expanding variant/task JSON.
CREATE INDEX collect_items_live_source_sku_idx ON collect_items(account_id,source_sku)
WHERE deleted_at IS NULL AND source IN ('ozon','AUTO_LISTING_EXCEL_SKU');
CREATE INDEX product_drafts_variant_skus_idx ON product_drafts USING gin ((data->'variants'));
CREATE INDEX ai_listing_source_skus_idx ON ai_image_listing_tasks USING gin ((body#>'{source,items}'));
