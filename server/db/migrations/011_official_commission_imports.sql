CREATE TABLE IF NOT EXISTS pricing_official_imports (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_date DATE,
  object_key TEXT NOT NULL,
  object_bucket TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  sha256 TEXT NOT NULL,
  fulfillment_types TEXT[] NOT NULL DEFAULT '{}',
  summary_rule_count INTEGER NOT NULL DEFAULT 0,
  detail_mapping_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id, sha256)
);

CREATE INDEX IF NOT EXISTS pricing_official_imports_version_idx
  ON pricing_official_imports(version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_official_category_mappings (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES pricing_config_versions(id) ON DELETE CASCADE,
  source_import_id TEXT NOT NULL REFERENCES pricing_official_imports(id) ON DELETE CASCADE,
  descriptive_type_ru TEXT NOT NULL,
  descriptive_type_zh TEXT NOT NULL DEFAULT '',
  descriptive_type_en TEXT NOT NULL DEFAULT '',
  descriptive_category_ru TEXT NOT NULL DEFAULT '',
  descriptive_category_zh TEXT NOT NULL DEFAULT '',
  descriptive_category_en TEXT NOT NULL DEFAULT '',
  marketplace_category_ru TEXT NOT NULL,
  marketplace_category_zh TEXT NOT NULL DEFAULT '',
  marketplace_category_en TEXT NOT NULL DEFAULT '',
  brand_name TEXT NOT NULL DEFAULT 'All',
  tariff_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_official_category_mappings_type_idx
  ON pricing_official_category_mappings(version_id, lower(descriptive_type_ru), brand_name);

CREATE INDEX IF NOT EXISTS pricing_official_category_mappings_marketplace_idx
  ON pricing_official_category_mappings(version_id, lower(marketplace_category_ru));
