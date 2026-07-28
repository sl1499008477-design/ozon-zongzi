CREATE TABLE IF NOT EXISTS pricing_fx_probes (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  last_observed_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_fx_probes_status_idx
  ON pricing_fx_probes(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pricing_fx_observations (
  id TEXT PRIMARY KEY,
  probe_id TEXT NOT NULL REFERENCES pricing_fx_probes(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  rub_price NUMERIC(18, 6) NOT NULL CHECK (rub_price > 0),
  cny_price NUMERIC(18, 6) NOT NULL CHECK (cny_price > 0),
  implied_rate NUMERIC(18, 8) NOT NULL CHECK (implied_rate > 0),
  accepted BOOLEAN NOT NULL DEFAULT TRUE,
  reject_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ozon_frontend',
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL DEFAULT '',
  raw JSONB NOT NULL DEFAULT '{}'::JSONB,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_fx_observations_probe_time_idx
  ON pricing_fx_observations(probe_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS pricing_fx_observations_time_idx
  ON pricing_fx_observations(observed_at DESC);

CREATE TABLE IF NOT EXISTS pricing_live_exchange_rates (
  id TEXT PRIMARY KEY,
  base_currency TEXT NOT NULL DEFAULT 'CNY',
  quote_currency TEXT NOT NULL DEFAULT 'RUB',
  rate NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  method TEXT NOT NULL DEFAULT 'median',
  source TEXT NOT NULL DEFAULT 'ozon_sku_frontend',
  sample_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'LOW' CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  observed_from TIMESTAMPTZ,
  observed_to TIMESTAMPTZ,
  evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_live_exchange_rates_latest_idx
  ON pricing_live_exchange_rates(base_currency, quote_currency, computed_at DESC);
