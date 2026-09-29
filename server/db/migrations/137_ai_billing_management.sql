-- Preserve source records and task/SKU charge uniqueness when correcting bills.
ALTER TABLE ai_wallet_entries ADD COLUMN original_amount_cents BIGINT,
 ADD COLUMN voided_at TIMESTAMPTZ, ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_wallet_entries DROP CONSTRAINT ai_wallet_entries_kind_check;
ALTER TABLE ai_wallet_entries ADD CONSTRAINT ai_wallet_entries_kind_check CHECK(kind IN ('TOPUP','SKU_CHARGE','BALANCE_ADJUSTMENT'));
CREATE INDEX ai_wallet_entries_account_created ON ai_wallet_entries(account_id,created_at DESC,id);
ALTER TABLE ai_user_channel_requests ADD COLUMN billing_cost_overridden BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN billing_cost_cny NUMERIC(18,6) CHECK(billing_cost_cny>=0),
 ADD COLUMN billing_cost_deleted_at TIMESTAMPTZ, ADD COLUMN billing_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE ai_billing_changes (
 id TEXT PRIMARY KEY,
 account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
 actor_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
 action TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
 payload JSONB NOT NULL, before JSONB NOT NULL, after JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_billing_changes_account_created ON ai_billing_changes(account_id,created_at DESC);
