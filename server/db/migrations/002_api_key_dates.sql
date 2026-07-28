ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS api_key_created_at DATE,
  ADD COLUMN IF NOT EXISTS api_key_expires_at DATE;

ALTER TABLE store_credentials
  ADD COLUMN IF NOT EXISTS api_key_created_at DATE,
  ADD COLUMN IF NOT EXISTS api_key_expires_at DATE;
