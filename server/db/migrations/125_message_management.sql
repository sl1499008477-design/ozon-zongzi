CREATE TABLE ozon_message_settings (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{"enabled":false,"displayName":"","timeZone":"Europe/Moscow","webhookBaseUrl":""}',
  state JSONB NOT NULL DEFAULT '{}',
  webhook_token TEXT NOT NULL,
  next_sync_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,store_id)
);

CREATE TABLE ozon_message_templates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  body JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(account_id,store_id) REFERENCES ozon_message_settings(account_id,store_id) ON DELETE CASCADE
);
CREATE INDEX ozon_message_templates_store ON ozon_message_templates(account_id,store_id,created_at);

CREATE TABLE ozon_message_postings (
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  posting_number TEXT NOT NULL,
  body JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(account_id,store_id,posting_number),
  FOREIGN KEY(account_id,store_id) REFERENCES ozon_message_settings(account_id,store_id) ON DELETE CASCADE
);
CREATE INDEX ozon_message_postings_order ON ozon_message_postings(account_id,store_id,(body->>'orderNumber'));
CREATE INDEX ozon_message_postings_recent ON ozon_message_postings(account_id,store_id,updated_at DESC);

CREATE TABLE ozon_message_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','SKIPPED','FAILED','UNCERTAIN','CANCELLED')),
  due_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  claimed_at BIGINT,
  body JSONB NOT NULL,
  UNIQUE(account_id,store_id,dedupe_key),
  FOREIGN KEY(account_id,store_id) REFERENCES ozon_message_settings(account_id,store_id) ON DELETE CASCADE
);
CREATE INDEX ozon_message_records_due ON ozon_message_records(due_at) WHERE status='PENDING';
CREATE INDEX ozon_message_records_store ON ozon_message_records(account_id,store_id,created_at DESC);
