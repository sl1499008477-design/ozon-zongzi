CREATE TABLE platform_product_restrictions (
 id TEXT PRIMARY KEY,
 payload JSONB NOT NULL,
 updated_by TEXT NOT NULL REFERENCES accounts(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE product_restriction_events (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 stage TEXT NOT NULL,
 sku TEXT NOT NULL DEFAULT '',
 decision TEXT NOT NULL,
 matches JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX product_restriction_events_account_time ON product_restriction_events(account_id,created_at DESC);
