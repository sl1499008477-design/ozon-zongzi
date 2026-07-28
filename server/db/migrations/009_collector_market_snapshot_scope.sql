-- Migration 007 originally keyed snapshots without operating_store_id. The
-- desktop run freezes both stores, so snapshots from two operating stores must
-- not overwrite each other even when they use the same data store and key.
ALTER TABLE collector_market_snapshots
  DROP CONSTRAINT IF EXISTS collector_market_snapshots_account_id_data_collection_store_key;

CREATE UNIQUE INDEX IF NOT EXISTS collector_market_snapshots_scope_snapshot_uq
  ON collector_market_snapshots(
    account_id,
    operating_store_id,
    data_collection_store_id,
    snapshot_key
  );
