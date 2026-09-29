-- Ozon SKU identity survives collector product-group merges and source-root changes.
CREATE TABLE collector_ai_sku_owners (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_sku TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES ai_image_listing_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id,source_sku)
);
CREATE INDEX collector_ai_sku_owners_task_idx ON collector_ai_sku_owners(task_id);
CREATE INDEX ai_listing_collect_wait_skus_idx ON ai_image_listing_tasks
  USING gin ((body#>'{collectWait,selectedSkus}')) WHERE status<>'MERGED';
