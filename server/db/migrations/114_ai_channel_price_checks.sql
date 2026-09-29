CREATE TABLE ai_channel_price_checks (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  channel_id TEXT NOT NULL REFERENCES ai_user_channels(id),
  day DATE NOT NULL,
  report JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, channel_id, day)
);
