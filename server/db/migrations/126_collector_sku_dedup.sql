-- Collection history stays available; explicit deletion only releases recollection.
ALTER TABLE collector_task_items ADD COLUMN dedup_released_at TIMESTAMPTZ;
-- Old unlinked rows cannot prove whether their collect-box copy was deleted.
ALTER TABLE collector_task_items ADD COLUMN dedup_saved_at TIMESTAMPTZ;
CREATE INDEX collector_items_saved_sku_idx
 ON collector_task_items(account_id,source_sku)
 WHERE source='ozon' AND status='QUALIFIED' AND dedup_released_at IS NULL;

-- A SKU reservation lives only as long as its existing collector run lease.
CREATE TABLE collector_sku_claims (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 source TEXT NOT NULL DEFAULT 'ozon' CHECK(source='ozon'),
 source_sku TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES collector_task_runs(id) ON DELETE CASCADE,
 PRIMARY KEY(account_id,source,source_sku)
);
CREATE INDEX collector_sku_claims_run_idx ON collector_sku_claims(run_id);
