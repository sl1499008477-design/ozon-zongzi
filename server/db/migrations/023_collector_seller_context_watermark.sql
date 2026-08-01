ALTER TABLE collector_sessions
  ADD COLUMN IF NOT EXISTS seller_context_json JSONB,
  ADD COLUMN IF NOT EXISTS seller_context_updated_at TIMESTAMPTZ;
