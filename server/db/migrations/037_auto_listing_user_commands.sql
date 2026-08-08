CREATE TABLE IF NOT EXISTS auto_listing_user_commands (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('CANCEL','REGENERATE')),
  expected_status_version INTEGER NOT NULL CHECK (expected_status_version > 0),
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_status TEXT NOT NULL,
  result_status_version INTEGER NOT NULL CHECK (result_status_version > expected_status_version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id,job_id,item_id)
    REFERENCES auto_listing_job_items(account_id,job_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS auto_listing_user_commands_item_created_idx
  ON auto_listing_user_commands(account_id,job_id,item_id,created_at DESC);

CREATE OR REPLACE FUNCTION auto_listing_user_commands_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auto-listing user commands are append-only';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_user_commands_immutable_trigger
  ON auto_listing_user_commands;
CREATE TRIGGER auto_listing_user_commands_immutable_trigger
BEFORE UPDATE OR DELETE ON auto_listing_user_commands
FOR EACH ROW EXECUTE FUNCTION auto_listing_user_commands_immutable();
