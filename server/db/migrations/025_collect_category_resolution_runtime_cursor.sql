CREATE TABLE IF NOT EXISTS collect_category_resolution_runtime_cursors (
  worker_key TEXT PRIMARY KEY,
  cursor_key TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
