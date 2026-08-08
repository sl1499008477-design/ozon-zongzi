DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auto_listing_import_files
     WHERE retry_of_import_id IS NOT NULL
     GROUP BY account_id,retry_of_import_id HAVING COUNT(*)>1
  ) OR EXISTS (
    SELECT 1 FROM auto_listing_import_retry_commands
     GROUP BY account_id,import_file_id HAVING COUNT(*)>1
  ) THEN
    RAISE EXCEPTION 'AUTO_LISTING_IMPORT_RETRY_HISTORY_CONFLICT'
      USING ERRCODE='P4202',
        DETAIL='One parent import has multiple historical retry successors; migration 042 did not modify or delete them.',
        HINT='Audit auto_listing_import_files by (account_id,retry_of_import_id) and auto_listing_import_retry_commands by (account_id,import_file_id); apply an approved tenant-scoped history repair, then rerun migration 042.';
  END IF;
END;
$$;

-- Fail closed before any schema or audit mutation. Historical retry rows are
-- legitimate only when they map exactly to a FAILED row of their declared
-- parent import; a pending/ready/succeeded source must never be made retryable
-- merely because this migration ran.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM auto_listing_import_rows AS child
      JOIN auto_listing_import_files AS child_file
        ON child_file.account_id=child.account_id AND child_file.id=child.import_file_id
      LEFT JOIN auto_listing_import_retry_commands AS command
        ON command.account_id=child_file.account_id AND command.retry_import_file_id=child_file.id
      LEFT JOIN auto_listing_import_rows AS source
        ON source.account_id=command.account_id AND source.import_file_id=command.import_file_id
       AND source.row_number=child.row_number
       AND source.raw_sku=child.raw_sku
       AND source.normalized_sku=child.normalized_sku
     WHERE child_file.retry_of_import_id IS NOT NULL
       AND (
         command.import_file_id IS DISTINCT FROM child_file.retry_of_import_id
         OR source.id IS NULL
         OR source.status<>'FAILED'
       )
  ) THEN
    RAISE EXCEPTION 'AUTO_LISTING_IMPORT_RETRY_LINEAGE_SOURCE_INVALID'
      USING ERRCODE='P4203',
        DETAIL='A historical retry row does not map exactly to a FAILED row in its declared parent import; migration 042 made no schema or data changes.',
        HINT='Audit the affected tenant retry command and source-row status, repair the invalid history through an approved tenant-scoped procedure, then rerun migration 042.';
  END IF;
END;
$$;

ALTER TABLE auto_listing_import_rows
  ADD COLUMN IF NOT EXISTS retry_source_row_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_import_rows_account_id_uq
  ON auto_listing_import_rows(account_id,id);

CREATE TABLE IF NOT EXISTS auto_listing_import_retry_lineage_backfill_audit (
  account_id TEXT NOT NULL,
  child_import_file_id TEXT NOT NULL,
  child_row_id TEXT NOT NULL,
  source_import_file_id TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,child_row_id),
  UNIQUE (account_id,source_row_id)
);

CREATE OR REPLACE FUNCTION auto_listing_enforce_retry_lineage_audit_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'retry lineage backfill audit is append-only' USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_retry_lineage_audit_append_only
  ON auto_listing_import_retry_lineage_backfill_audit;
CREATE TRIGGER auto_listing_retry_lineage_audit_append_only
BEFORE UPDATE OR DELETE ON auto_listing_import_retry_lineage_backfill_audit
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_retry_lineage_audit_append_only();

-- 040 may already have created retry children, including children that have
-- since become terminal. Record the exact mapping first, then temporarily
-- suspend only the 034 state trigger for this one immutable-column backfill.
INSERT INTO auto_listing_import_retry_lineage_backfill_audit (
  account_id,child_import_file_id,child_row_id,source_import_file_id,source_row_id
)
SELECT child.account_id,child.import_file_id,child.id,source.import_file_id,source.id
  FROM auto_listing_import_rows AS child
  JOIN auto_listing_import_files AS child_file
    ON child_file.account_id=child.account_id AND child_file.id=child.import_file_id
  JOIN auto_listing_import_retry_commands AS command
    ON command.account_id=child_file.account_id AND command.retry_import_file_id=child_file.id
  JOIN auto_listing_import_rows AS source
    ON source.account_id=command.account_id AND source.import_file_id=command.import_file_id
   AND source.row_number=child.row_number
   AND source.raw_sku=child.raw_sku
   AND source.normalized_sku=child.normalized_sku
   AND source.status='FAILED'
 WHERE child.retry_source_row_id IS NULL
ON CONFLICT (account_id,child_row_id) DO NOTHING;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE auto_listing_import_rows DISABLE TRIGGER auto_listing_import_rows_state_guard';
  UPDATE auto_listing_import_rows AS child
     SET retry_source_row_id=audit.source_row_id
    FROM auto_listing_import_retry_lineage_backfill_audit AS audit
   WHERE audit.account_id=child.account_id
     AND audit.child_row_id=child.id
     AND child.retry_source_row_id IS NULL;
  EXECUTE 'ALTER TABLE auto_listing_import_rows ENABLE TRIGGER auto_listing_import_rows_state_guard';
EXCEPTION WHEN OTHERS THEN
  -- PL/pgSQL rolls the protected block back before entering this handler, so
  -- the trigger is enabled even when the backfill fails. Keep the explicit
  -- enable as a defensive no-op for migration runners that split statements.
  EXECUTE 'ALTER TABLE auto_listing_import_rows ENABLE TRIGGER auto_listing_import_rows_state_guard';
  RAISE;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM auto_listing_import_rows AS child
      JOIN auto_listing_import_files AS child_file
        ON child_file.account_id=child.account_id AND child_file.id=child.import_file_id
     WHERE child_file.retry_of_import_id IS NOT NULL
       AND child.retry_source_row_id IS NULL
  ) THEN
    RAISE EXCEPTION 'existing retry row cannot be assigned an immutable source lineage'
      USING ERRCODE='23514';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='auto_listing_import_rows'::regclass
       AND conname='auto_listing_import_rows_retry_source_fk'
  ) THEN
    ALTER TABLE auto_listing_import_rows
      ADD CONSTRAINT auto_listing_import_rows_retry_source_fk
      FOREIGN KEY (account_id,retry_source_row_id)
      REFERENCES auto_listing_import_rows(account_id,id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_import_rows_retry_source_uq
  ON auto_listing_import_rows(account_id,retry_source_row_id)
  WHERE retry_source_row_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_import_retry_commands_source_uq
  ON auto_listing_import_retry_commands(account_id,import_file_id);

CREATE OR REPLACE FUNCTION auto_listing_enforce_import_retry_row_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  child_parent_id TEXT;
  source RECORD;
BEGIN
  IF TG_OP='UPDATE'
     AND NEW.retry_source_row_id IS DISTINCT FROM OLD.retry_source_row_id THEN
    RAISE EXCEPTION 'retry row source lineage is immutable' USING ERRCODE='23514';
  END IF;

  SELECT retry_of_import_id INTO child_parent_id
    FROM auto_listing_import_files
   WHERE account_id=NEW.account_id AND id=NEW.import_file_id;

  IF child_parent_id IS NULL THEN
    IF NEW.retry_source_row_id IS NOT NULL THEN
      RAISE EXCEPTION 'non-retry import row cannot have retry lineage' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.retry_source_row_id IS NULL THEN
    RAISE EXCEPTION 'retry import row requires source lineage' USING ERRCODE='23514';
  END IF;

  SELECT import_file_id,row_number,raw_sku,status,normalized_sku INTO source
    FROM auto_listing_import_rows
   WHERE account_id=NEW.account_id AND id=NEW.retry_source_row_id;
  IF NOT FOUND OR source.import_file_id<>child_parent_id
     OR source.status <> 'FAILED'
     OR source.row_number <> NEW.row_number
     OR source.raw_sku IS DISTINCT FROM NEW.raw_sku
     OR source.normalized_sku IS DISTINCT FROM NEW.normalized_sku THEN
    RAISE EXCEPTION 'retry row lineage does not reference its failed parent row' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_import_retry_row_lineage_guard
  ON auto_listing_import_rows;
CREATE TRIGGER auto_listing_import_retry_row_lineage_guard
BEFORE INSERT OR UPDATE ON auto_listing_import_rows
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_import_retry_row_lineage();
