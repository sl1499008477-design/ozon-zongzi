ALTER TABLE auto_listing_import_files
  ADD COLUMN IF NOT EXISTS retry_of_import_id TEXT;

-- A retry batch references the same immutable workbook evidence as its parent.
-- The object itself is not copied or exposed; multiple import records may safely
-- reference it while account scope remains indexed.
ALTER TABLE auto_listing_import_files
  DROP CONSTRAINT IF EXISTS auto_listing_import_files_account_id_object_key_key;

CREATE INDEX IF NOT EXISTS auto_listing_import_files_account_object_idx
  ON auto_listing_import_files(account_id,object_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='auto_listing_import_files'::regclass
       AND conname='auto_listing_import_files_retry_parent_fk'
  ) THEN
    ALTER TABLE auto_listing_import_files
      ADD CONSTRAINT auto_listing_import_files_retry_parent_fk
      FOREIGN KEY (account_id,retry_of_import_id)
      REFERENCES auto_listing_import_files(account_id,id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_enforce_import_retry_parent_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.retry_of_import_id IS DISTINCT FROM OLD.retry_of_import_id THEN
    RAISE EXCEPTION 'import retry parent is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.retry_of_import_id IS NOT NULL AND NEW.retry_of_import_id=NEW.id THEN
    RAISE EXCEPTION 'import cannot retry itself' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_import_retry_parent_guard ON auto_listing_import_files;
CREATE TRIGGER auto_listing_import_retry_parent_guard
BEFORE INSERT OR UPDATE ON auto_listing_import_files
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_import_retry_parent_identity();

CREATE TABLE IF NOT EXISTS auto_listing_import_retry_commands (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  import_file_id TEXT NOT NULL,
  retry_import_file_id TEXT NOT NULL,
  expected_status_version BIGINT NOT NULL CHECK (expected_status_version>=0),
  idempotency_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(idempotency_key),'') IS NOT NULL AND OCTET_LENGTH(idempotency_key)<=240
  ),
  correlation_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240
  ),
  actor_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  retried_row_count INTEGER NOT NULL CHECK (retried_row_count>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,id),
  UNIQUE (account_id,idempotency_key),
  UNIQUE (account_id,retry_import_file_id),
  FOREIGN KEY (account_id,import_file_id)
    REFERENCES auto_listing_import_files(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,retry_import_file_id)
    REFERENCES auto_listing_import_files(account_id,id) ON DELETE RESTRICT,
  CHECK (actor_id=account_id),
  CHECK (import_file_id<>retry_import_file_id)
);

CREATE OR REPLACE FUNCTION auto_listing_enforce_import_retry_command_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'import retry command evidence is append-only' USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_import_retry_commands_append_only
  ON auto_listing_import_retry_commands;
CREATE TRIGGER auto_listing_import_retry_commands_append_only
BEFORE UPDATE OR DELETE ON auto_listing_import_retry_commands
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_import_retry_command_append_only();

CREATE INDEX IF NOT EXISTS auto_listing_import_retry_commands_source_idx
  ON auto_listing_import_retry_commands(account_id,import_file_id,created_at DESC);
