ALTER TABLE product_assets
  ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS width INTEGER,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(12, 3),
  ADD COLUMN IF NOT EXISTS cover_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS external_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS product_assets_type_idx
  ON product_assets(asset_type);

CREATE INDEX IF NOT EXISTS product_assets_origin_url_idx
  ON product_assets(origin_url)
  WHERE origin_url <> '';
