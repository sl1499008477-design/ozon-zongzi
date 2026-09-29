ALTER TABLE collector_task_items ADD COLUMN IF NOT EXISTS export_data_from_raw BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS collector_run_handoffs (
  run_id TEXT PRIMARY KEY REFERENCES collector_task_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','COMPLETED','PARTIAL','FAILED')),
  body JSONB NOT NULL DEFAULT '{"receipts":{}}'::jsonb,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS collector_run_handoffs_due ON collector_run_handoffs(next_run_at,updated_at)
  WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX IF NOT EXISTS collector_run_handoffs_account ON collector_run_handoffs(account_id,run_id);
