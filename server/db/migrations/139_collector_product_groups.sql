-- Whole-product capture ownership and per-SKU successful checkpoints.
CREATE TABLE collector_product_groups (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 merged_into TEXT REFERENCES collector_product_groups(id),
 owner_run_id TEXT REFERENCES collector_task_runs(id) ON DELETE SET NULL,
 owner_entry_sku TEXT NOT NULL DEFAULT '',
 expected_skus JSONB NOT NULL DEFAULT '[]',
 completed_item_id TEXT REFERENCES collector_task_items(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX collector_product_groups_account_idx ON collector_product_groups(account_id,id);
CREATE TABLE collector_product_members (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 source_sku TEXT NOT NULL,
 group_id TEXT NOT NULL REFERENCES collector_product_groups(id) ON DELETE CASCADE,
 detail JSONB,
 captured_at TIMESTAMPTZ,
 PRIMARY KEY(account_id,source_sku)
);
CREATE INDEX collector_product_members_group_idx ON collector_product_members(group_id,source_sku);
