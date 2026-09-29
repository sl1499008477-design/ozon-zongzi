CREATE TABLE ai_user_channels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  text_model TEXT NOT NULL,
  image_model TEXT NOT NULL,
  billing_account TEXT NOT NULL,
  credential JSONB NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_user_channels_account ON ai_user_channels(account_id);
CREATE TABLE ai_user_channel_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  channel_id TEXT NOT NULL REFERENCES ai_user_channels(id),
  task_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED')),
  error_code TEXT,
  gateway_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX ai_user_channel_requests_account ON ai_user_channel_requests(account_id,created_at DESC);
