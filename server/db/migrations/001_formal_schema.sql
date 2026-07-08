CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  password_salt TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  password_algorithm TEXT NOT NULL DEFAULT 'scrypt',
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  legal_name TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL UNIQUE,
  inn TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  currency_code TEXT NOT NULL DEFAULT 'RUB',
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT '',
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  seller_company_id TEXT NOT NULL DEFAULT '',
  saved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  profile_synced_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS store_credentials (
  store_id TEXT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  key_version TEXT NOT NULL DEFAULT 'v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT 'minio',
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  offer_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT '',
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  currency_code TEXT NOT NULL DEFAULT '',
  current_price NUMERIC(14, 2),
  original_price NUMERIC(14, 2),
  marketing_price NUMERIC(14, 2),
  stock_total INTEGER,
  image_url TEXT NOT NULL DEFAULT '',
  primary_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS products_store_product_id_uq
  ON products(store_id, product_id)
  WHERE product_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS products_store_sku_uq
  ON products(store_id, sku)
  WHERE sku <> '';
CREATE INDEX IF NOT EXISTS products_store_status_idx ON products(store_id, status);
CREATE INDEX IF NOT EXISTS products_store_offer_idx ON products(store_id, offer_id);

CREATE TABLE IF NOT EXISTS product_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  price_type TEXT NOT NULL DEFAULT '',
  action_id TEXT NOT NULL DEFAULT '',
  action_name TEXT NOT NULL DEFAULT '',
  price NUMERIC(14, 2),
  currency_code TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS product_prices_identity_uq
  ON product_prices(product_id, price_type, action_id, action_name);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  warehouse_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_store_warehouse_id_uq
  ON warehouses(store_id, warehouse_id)
  WHERE warehouse_id <> '';
CREATE INDEX IF NOT EXISTS warehouses_store_active_idx ON warehouses(store_id, is_active, is_archived);

CREATE TABLE IF NOT EXISTS product_stocks (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  sku TEXT NOT NULL DEFAULT '',
  offer_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  present INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY(product_id, warehouse_id, source)
);

CREATE INDEX IF NOT EXISTS product_stocks_store_sku_idx ON product_stocks(store_id, sku);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
  posting_number TEXT NOT NULL DEFAULT '',
  order_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  shipment_type TEXT NOT NULL DEFAULT '',
  in_process_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_store_posting_uq
  ON orders(store_id, posting_number)
  WHERE posting_number <> '';
CREATE INDEX IF NOT EXISTS orders_store_status_idx ON orders(store_id, status);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL DEFAULT '',
  offer_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  price NUMERIC(14, 2),
  currency_code TEXT NOT NULL DEFAULT '',
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_sku_idx ON order_items(sku);

CREATE TABLE IF NOT EXISTS product_assets (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL DEFAULT 'image',
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  origin_url TEXT NOT NULL DEFAULT '',
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS product_assets_product_idx ON product_assets(product_id, asset_type, sort_order);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  fetched_count INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS sync_jobs_store_type_idx ON sync_jobs(store_id, type, status);
