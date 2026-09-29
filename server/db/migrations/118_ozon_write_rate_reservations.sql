-- Shared by the AI and direct V3 writers. An intent consumes capacity even when
-- a request's response is lost; no credentials or payloads are retained here.
CREATE TABLE ozon_write_rate_reservations (
  seller_scope TEXT NOT NULL,
  request_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('stock','import')),
  units INTEGER NOT NULL CHECK (units > 0),
  pair_keys TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ozon_write_rate_reservations_window_idx
  ON ozon_write_rate_reservations(seller_scope,operation,created_at);
