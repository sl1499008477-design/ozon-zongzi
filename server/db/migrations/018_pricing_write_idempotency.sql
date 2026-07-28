CREATE TABLE IF NOT EXISTS pricing_write_idempotency (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_scope TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('FX_OBSERVATION', 'PRICING_SNAPSHOT')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, store_scope, action, idempotency_key)
);
