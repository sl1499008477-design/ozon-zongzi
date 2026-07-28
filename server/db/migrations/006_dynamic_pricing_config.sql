CREATE TABLE IF NOT EXISTS pricing_config_versions (
  id TEXT PRIMARY KEY,
  version_no INTEGER NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'account', 'store')),
  scope_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED', 'SCHEDULED', 'ACTIVE', 'RETIRED')),
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  config_hash TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  published_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE(scope_type, scope_id, version_no)
);

CREATE INDEX IF NOT EXISTS pricing_config_versions_active_idx
  ON pricing_config_versions(scope_type, scope_id, status, effective_from DESC);

CREATE TABLE IF NOT EXISTS pricing_commission_rules (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL DEFAULT '',
  ozon_category_id TEXT NOT NULL DEFAULT '*',
  fulfillment_type TEXT NOT NULL DEFAULT 'RFBS',
  min_price_rub NUMERIC(18, 4) NOT NULL DEFAULT 0,
  max_price_rub NUMERIC(18, 4),
  commission_rate NUMERIC(9, 6) NOT NULL CHECK (commission_rate >= 0 AND commission_rate < 100),
  priority INTEGER NOT NULL DEFAULT 100,
  source_name TEXT NOT NULL DEFAULT '',
  source_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_commission_rules_lookup_idx
  ON pricing_commission_rules(version_id, ozon_category_id, fulfillment_type, min_price_rub, priority);

CREATE TABLE IF NOT EXISTS pricing_logistics_rules (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  route_code TEXT NOT NULL DEFAULT '',
  warehouse_id TEXT NOT NULL DEFAULT '',
  min_weight_g NUMERIC(18, 3) NOT NULL DEFAULT 0,
  max_weight_g NUMERIC(18, 3),
  base_fee_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  fee_per_kg_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  minimum_fee_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  use_volume_weight BOOLEAN NOT NULL DEFAULT FALSE,
  volume_divisor NUMERIC(18, 6) NOT NULL DEFAULT 6000,
  max_length_cm NUMERIC(18, 3),
  max_dimension_sum_cm NUMERIC(18, 3),
  surcharge_rate NUMERIC(9, 6) NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_logistics_rules_lookup_idx
  ON pricing_logistics_rules(version_id, provider, route_code, warehouse_id, min_weight_g, priority);

CREATE TABLE IF NOT EXISTS pricing_domestic_fee_rules (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL DEFAULT '*',
  domestic_shipping_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  labeling_fee_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  packaging_fee_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  operation_fee_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_domestic_fee_rules_lookup_idx
  ON pricing_domestic_fee_rules(version_id, warehouse_id, priority);

CREATE TABLE IF NOT EXISTS pricing_default_rules (
  version_id TEXT PRIMARY KEY REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  ad_rate NUMERIC(9, 6) NOT NULL DEFAULT 0,
  withdrawal_rate NUMERIC(9, 6) NOT NULL DEFAULT 3,
  return_loss_rate NUMERIC(9, 6) NOT NULL DEFAULT 2,
  target_margin_rate NUMERIC(9, 6) NOT NULL DEFAULT 20,
  frontend_discount_rate NUMERIC(9, 6) NOT NULL DEFAULT 50,
  other_fixed_fee_cny NUMERIC(18, 6) NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL DEFAULT 'CNY'
);

CREATE TABLE IF NOT EXISTS pricing_exchange_rates (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  base_currency TEXT NOT NULL DEFAULT 'CNY',
  quote_currency TEXT NOT NULL DEFAULT 'RUB',
  rate NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  source TEXT NOT NULL DEFAULT 'manual',
  quoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id, base_currency, quote_currency)
);

CREATE TABLE IF NOT EXISTS pricing_calculation_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  draft_id TEXT REFERENCES product_drafts(id) ON DELETE SET NULL,
  submission_snapshot_id TEXT REFERENCES submission_snapshots(id) ON DELETE SET NULL,
  config_version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL DEFAULT 'profit',
  input_json JSONB NOT NULL,
  result_json JSONB NOT NULL,
  config_snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_calculation_snapshots_store_created_idx
  ON pricing_calculation_snapshots(store_id, created_at DESC);

ALTER TABLE submission_snapshots
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE product_drafts
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB;
