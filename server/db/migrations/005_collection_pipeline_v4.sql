CREATE TABLE IF NOT EXISTS data_collection_stores (
  id TEXT PRIMARY KEY,
  seller_company_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS local_state (
  id TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_data_collection_stores (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  data_collection_store_id TEXT NOT NULL REFERENCES data_collection_stores(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  note TEXT NOT NULL DEFAULT '',
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, data_collection_store_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS account_data_collection_current_uq
  ON account_data_collection_stores(account_id)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS account_data_collection_status_idx
  ON account_data_collection_stores(account_id, status, updated_at DESC);

WITH legacy AS (
  SELECT
    item->>'id' AS legacy_id,
    item->>'ownerAccountId' AS account_id,
    regexp_replace(COALESCE(item->>'sellerCompanyId',''),'[^0-9]','','g') AS seller_company_id,
    COALESCE(item->>'createdAt','') AS created_at
  FROM local_state state_row,
       LATERAL jsonb_array_elements(COALESCE(state_row.state->'dataCollectionStores','[]'::jsonb)) item
  WHERE state_row.id='local-state'
)
INSERT INTO data_collection_stores (id,seller_company_id,created_at,updated_at)
SELECT legacy_id,seller_company_id,NULLIF(created_at,'')::timestamptz,NOW()
FROM legacy
WHERE legacy_id<>'' AND account_id<>'' AND seller_company_id<>''
ON CONFLICT (seller_company_id) DO UPDATE SET updated_at=NOW();

WITH legacy AS (
  SELECT
    item,
    item->>'ownerAccountId' AS account_id,
    regexp_replace(COALESCE(item->>'sellerCompanyId',''),'[^0-9]','','g') AS seller_company_id,
    state_row.state
  FROM local_state state_row,
       LATERAL jsonb_array_elements(COALESCE(state_row.state->'dataCollectionStores','[]'::jsonb)) item
  WHERE state_row.id='local-state'
)
INSERT INTO account_data_collection_stores (
  account_id,data_collection_store_id,label,status,note,is_current,last_verified_at,created_at,updated_at
)
SELECT
  legacy.account_id,
  stores.id,
  COALESCE(NULLIF(legacy.item->>'label',''),'数据采集店铺'),
  CASE WHEN legacy.item->>'status'='disabled' THEN 'disabled' ELSE 'active' END,
  COALESCE(legacy.item->>'note',''),
  COALESCE(
    legacy.state->'currentDataCollectionStoreIdsByAccount'->>legacy.account_id,
    CASE WHEN legacy.state->>'currentAccountId'=legacy.account_id THEN legacy.state->>'currentDataCollectionStoreId' ELSE '' END
  )=legacy.item->>'id',
  NULLIF(legacy.item->>'lastVerifiedAt','')::timestamptz,
  COALESCE(NULLIF(legacy.item->>'createdAt','')::timestamptz,NOW()),
  COALESCE(NULLIF(legacy.item->>'updatedAt','')::timestamptz,NOW())
FROM legacy
JOIN data_collection_stores stores ON stores.seller_company_id=legacy.seller_company_id
JOIN accounts accounts_row ON accounts_row.id=legacy.account_id
WHERE legacy.account_id<>'' AND legacy.seller_company_id<>''
ON CONFLICT (account_id,data_collection_store_id) DO UPDATE SET
  label=EXCLUDED.label,
  status=EXCLUDED.status,
  note=EXCLUDED.note,
  is_current=EXCLUDED.is_current,
  last_verified_at=COALESCE(EXCLUDED.last_verified_at,account_data_collection_stores.last_verified_at),
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS collection_store_verifications (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  data_collection_store_id TEXT REFERENCES data_collection_stores(id) ON DELETE SET NULL,
  seller_company_id TEXT NOT NULL DEFAULT '',
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  switched BOOLEAN NOT NULL DEFAULT FALSE,
  request_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collection_store_verifications_account_created_idx
  ON collection_store_verifications(account_id, created_at DESC);

ALTER TABLE collect_items
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ozon',
  ADD COLUMN IF NOT EXISTS identity_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS collect_items_identity_key_uq
  ON collect_items(identity_key)
  WHERE identity_key <> '';

ALTER TABLE collect_raw_payloads
  ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS request_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS collect_raw_payloads_content_hash_idx
  ON collect_raw_payloads(collect_item_id, content_hash)
  WHERE content_hash <> '';

CREATE TABLE IF NOT EXISTS collect_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  data_collection_store_id TEXT REFERENCES data_collection_stores(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  source_sku TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  collect_item_id TEXT REFERENCES collect_items(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  response JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collect_requests_account_created_idx
  ON collect_requests(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS collect_requests_lookup_idx
  ON collect_requests(account_id, data_collection_store_id, source, source_sku, created_at DESC);

ALTER TABLE product_draft_variants
  ADD COLUMN IF NOT EXISTS source_content_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_dedupe_key_uq
  ON outbox_events(dedupe_key)
  WHERE dedupe_key <> '';
