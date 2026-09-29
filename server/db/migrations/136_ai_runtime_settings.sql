-- One instance-wide setting, separate from the worker's acknowledgement.
CREATE TABLE IF NOT EXISTS ai_runtime_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  settings JSONB,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  worker_status JSONB,
  worker_seen_at TIMESTAMPTZ
);
INSERT INTO ai_runtime_settings(id) VALUES(TRUE) ON CONFLICT (id) DO NOTHING;
