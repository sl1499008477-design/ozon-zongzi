ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS event_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'account',
  ADD COLUMN IF NOT EXISTS actor_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'local-api',
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_event_id_unique
  ON audit_events(event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_scope_occurred_idx
  ON audit_events(account_id, store_id, occurred_at DESC);
