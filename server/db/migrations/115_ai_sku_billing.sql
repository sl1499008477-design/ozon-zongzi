CREATE TABLE ai_user_wallets (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id),
 balance_cents BIGINT NOT NULL DEFAULT 0 CHECK(balance_cents>=0),
 reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=balance_cents),
 sku_price_cents BIGINT CHECK(sku_price_cents>=0)
);
CREATE TABLE ai_task_billing (
 task_id TEXT PRIMARY KEY REFERENCES ai_image_listing_tasks(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),
 unit_cents BIGINT NOT NULL CHECK(unit_cents>=0),
 reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK(reserved_cents>=0)
);
CREATE TABLE ai_wallet_entries (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 task_id TEXT REFERENCES ai_image_listing_tasks(id),
 sku TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('TOPUP','SKU_CHARGE')),
 amount_cents BIGINT NOT NULL,
 actor_id TEXT REFERENCES accounts(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(task_id,sku,kind)
);
ALTER TABLE ai_image_listing_tasks ADD COLUMN billable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_image_listing_tasks ALTER COLUMN billable SET DEFAULT TRUE;
ALTER TABLE ai_user_channel_requests ADD COLUMN estimated_cost_cny NUMERIC(18,6);
