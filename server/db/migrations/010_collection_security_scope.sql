-- A Seller company/data store may belong to exactly one sonli account.
-- The catalog row remains keyed by seller_company_id, while this unique index
-- prevents a second account membership from sharing its cookies/analytics.
CREATE UNIQUE INDEX IF NOT EXISTS account_data_collection_store_owner_uq
  ON account_data_collection_stores(data_collection_store_id);

-- Idempotency is tenant scoped. A key chosen by one account must never select
-- or mutate another account's request.
ALTER TABLE collect_requests
  DROP CONSTRAINT IF EXISTS collect_requests_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS collect_requests_account_idempotency_uq
  ON collect_requests(account_id, idempotency_key)
  WHERE account_id IS NOT NULL;
