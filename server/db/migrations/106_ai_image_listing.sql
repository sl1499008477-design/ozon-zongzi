-- Independent AI image listing. Source collection and legacy listing tables are untouched.
CREATE TABLE ai_image_listing_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED','COLLECTING','GENERATING','AWAITING_REVIEW','READY_TO_SUBMIT',
    'SUBMITTING','SUBMITTED','COMPLETED','COLLECTION_FAILED','GENERATION_FAILED',
    'UPLOAD_FAILED','SUBMISSION_FAILED','SUBMISSION_UNCERTAIN','CANCELLED'
  )),
  body JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  next_run_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  lease_token TEXT,
  lease_expires_at BIGINT,
  UNIQUE (account_id,dedupe_key)
);
CREATE INDEX ai_image_listing_tasks_account_created_idx ON ai_image_listing_tasks(account_id,created_at DESC,id);
CREATE INDEX ai_image_listing_tasks_runnable_idx ON ai_image_listing_tasks(next_run_at,created_at,id)
  WHERE status IN ('QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED');
