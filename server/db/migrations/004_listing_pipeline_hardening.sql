CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_active_delivery_uq
  ON outbox_events(aggregate_id, event_type)
  WHERE status IN ('PENDING', 'PUBLISHING');

CREATE INDEX IF NOT EXISTS submission_jobs_recovery_idx
  ON submission_jobs(status, updated_at, lock_expires_at)
  WHERE status NOT IN ('SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED');

CREATE INDEX IF NOT EXISTS product_draft_revisions_created_idx
  ON product_draft_revisions(draft_id, created_at DESC);

CREATE INDEX IF NOT EXISTS collect_raw_payloads_account_created_idx
  ON collect_raw_payloads(account_id, created_at DESC);
