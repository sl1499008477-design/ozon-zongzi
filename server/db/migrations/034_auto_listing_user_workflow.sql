-- Ordinary-user defaults are conveniences only. Every job still freezes and
-- revalidates an immutable configuration snapshot before work is staged.
CREATE UNIQUE INDEX IF NOT EXISTS stores_owner_account_id_id_key
  ON stores(owner_account_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_store_id_id_key
  ON warehouses(store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS collect_items_account_id_id_key
  ON collect_items(account_id, id);

-- PostgreSQL stores valid UTF-8, so surrogate code points (Unicode Cs) cannot
-- be persisted. This additionally closes Cc/Cf controls which can make two
-- visually identical identifiers compare differently.
CREATE OR REPLACE FUNCTION auto_listing_sku_has_forbidden_unicode(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  position INTEGER;
  codepoint INTEGER;
BEGIN
  FOR position IN 1..CHAR_LENGTH(value) LOOP
    codepoint := ASCII(SUBSTRING(value FROM position FOR 1));
    IF codepoint BETWEEN 0 AND 31 OR codepoint BETWEEN 127 AND 159
      OR codepoint IN (173, 1564, 1757, 1807, 2274, 6158, 65279)
      OR codepoint BETWEEN 1536 AND 1541
      OR codepoint BETWEEN 2192 AND 2193
      OR codepoint BETWEEN 8203 AND 8207
      OR codepoint BETWEEN 8234 AND 8238
      OR codepoint BETWEEN 8288 AND 8292
      OR codepoint BETWEEN 8294 AND 8303
      OR codepoint BETWEEN 65529 AND 65531 OR codepoint = 65533
      OR codepoint IN (69821, 69837)
      OR codepoint BETWEEN 78896 AND 78911
      OR codepoint BETWEEN 113824 AND 113827
      OR codepoint BETWEEN 119155 AND 119162
      OR codepoint = 917505
      OR codepoint BETWEEN 917536 AND 917631
    THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

CREATE TABLE IF NOT EXISTS auto_listing_preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  target_store_id TEXT NOT NULL,
  target_warehouse_id TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock > 0),
  price_adjustment_kopecks BIGINT NOT NULL DEFAULT 0,
  image_config JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(image_config) = 'object'),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id, target_store_id)
    REFERENCES stores(owner_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (target_store_id, target_warehouse_id)
    REFERENCES warehouses(store_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS auto_listing_import_files (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_file_name TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_file_name), '') IS NOT NULL
    AND OCTET_LENGTH(source_file_name) <= 512
  ),
  source_content_type TEXT NOT NULL CHECK (
    NULLIF(BTRIM(source_content_type), '') IS NOT NULL
    AND OCTET_LENGTH(source_content_type) <= 160
  ),
  source_size_bytes BIGINT NOT NULL CHECK (source_size_bytes > 0),
  file_hash TEXT NOT NULL CHECK (file_hash ~ '^[a-f0-9]{64}$'),
  object_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(object_key), '') IS NOT NULL
    AND OCTET_LENGTH(object_key) <= 1024
  ),
  worksheet_name TEXT CHECK (worksheet_name IS NULL OR OCTET_LENGTH(worksheet_name) <= 255),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  rejected_rows INTEGER NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  duplicate_rows INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  ready_rows INTEGER NOT NULL DEFAULT 0 CHECK (ready_rows >= 0),
  failed_rows INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (
    'RECEIVED', 'QUEUED', 'COLLECTING', 'READY', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'
  )),
  status_version BIGINT NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  config_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(config_snapshot) = 'object'),
  config_hash TEXT NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(idempotency_key), '') IS NOT NULL
    AND OCTET_LENGTH(idempotency_key) <= 240
  ),
  created_by TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(correlation_id), '') IS NOT NULL
    AND OCTET_LENGTH(correlation_id) <= 240
  ),
  generated_job_id TEXT,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  last_error_safe TEXT CHECK (
    last_error_safe IS NULL OR OCTET_LENGTH(last_error_safe) <= 500
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, id),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (account_id, object_key),
  FOREIGN KEY (account_id, generated_job_id)
    REFERENCES auto_listing_jobs(account_id, id) ON DELETE RESTRICT,
  CHECK (accepted_rows + rejected_rows + duplicate_rows <= total_rows),
  CHECK (ready_rows + failed_rows <= accepted_rows),
  CHECK ((status IN ('READY', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED')) = (completed_at IS NOT NULL))
);

ALTER TABLE auto_listing_import_files
  ADD COLUMN IF NOT EXISTS status_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE auto_listing_import_files
  DROP CONSTRAINT IF EXISTS auto_listing_import_files_created_by_fkey;
ALTER TABLE auto_listing_import_files
  ADD CONSTRAINT auto_listing_import_files_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS auto_listing_import_rows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  import_file_id TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  raw_sku TEXT NOT NULL DEFAULT '' CHECK (OCTET_LENGTH(raw_sku) <= 131072),
  normalized_sku TEXT CHECK (
    normalized_sku IS NULL OR (
      OCTET_LENGTH(normalized_sku) BETWEEN 1 AND 160
      AND normalized_sku = BTRIM(normalized_sku)
      AND normalized_sku !~ '[[:cntrl:]]'
      AND NOT auto_listing_sku_has_forbidden_unicode(normalized_sku)
    )
  ),
  status TEXT NOT NULL CHECK (status IN (
    'ACCEPTED', 'DUPLICATE_IN_FILE', 'INVALID_SKU', 'PENDING', 'COLLECTING',
    'READY', 'FAILED', 'CANCELLED'
  )),
  status_version BIGINT NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  collect_item_id TEXT,
  auto_listing_item_id TEXT,
  -- A worker supplies this transient guard only while returning a leased row
  -- to PENDING. The BEFORE trigger validates it then clears it.
  source_lease_cas_token TEXT CHECK (source_lease_cas_token IS NULL),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  last_error_safe TEXT CHECK (
    last_error_safe IS NULL OR OCTET_LENGTH(last_error_safe) <= 500
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, import_file_id, id),
  UNIQUE (import_file_id, row_number),
  FOREIGN KEY (account_id, import_file_id)
    REFERENCES auto_listing_import_files(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, collect_item_id)
    REFERENCES collect_items(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, auto_listing_item_id)
    REFERENCES auto_listing_job_items(account_id, id) ON DELETE RESTRICT,
  CHECK ((status IN ('ACCEPTED', 'PENDING', 'COLLECTING') AND completed_at IS NULL)
    OR (status IN ('DUPLICATE_IN_FILE', 'INVALID_SKU', 'READY', 'FAILED', 'CANCELLED')
      AND completed_at IS NOT NULL)),
  CHECK ((status = 'INVALID_SKU') = (normalized_sku IS NULL)),
  CHECK (status <> 'READY' OR collect_item_id IS NOT NULL)
);

ALTER TABLE auto_listing_import_rows
  ADD COLUMN IF NOT EXISTS status_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_lease_cas_token TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auto_listing_import_rows'::regclass
       AND conname = 'auto_listing_import_rows_normalized_sku_unicode_ck'
  ) THEN
    ALTER TABLE auto_listing_import_rows
      ADD CONSTRAINT auto_listing_import_rows_normalized_sku_unicode_ck
      CHECK (normalized_sku IS NULL OR NOT auto_listing_sku_has_forbidden_unicode(normalized_sku))
      NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auto_listing_import_rows'::regclass
       AND conname = 'auto_listing_import_rows_source_lease_cas_token_ck'
  ) THEN
    ALTER TABLE auto_listing_import_rows
      ADD CONSTRAINT auto_listing_import_rows_source_lease_cas_token_ck
      CHECK (source_lease_cas_token IS NULL) NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_import_rows_normalized_sku_uq
  ON auto_listing_import_rows(import_file_id, normalized_sku)
  WHERE normalized_sku IS NOT NULL AND status <> 'DUPLICATE_IN_FILE';

CREATE OR REPLACE FUNCTION auto_listing_enforce_import_file_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RECEIVED'
      OR NEW.status_version <> 0
      OR NEW.ready_rows <> 0
      OR NEW.failed_rows <> 0
      OR NEW.generated_job_id IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
      OR NEW.last_error_safe IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'invalid initial import file state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.id, NEW.account_id, NEW.source_file_name, NEW.source_content_type,
    NEW.source_size_bytes, NEW.file_hash, NEW.object_key, NEW.worksheet_name,
    NEW.total_rows, NEW.accepted_rows, NEW.rejected_rows, NEW.duplicate_rows,
    NEW.config_snapshot, NEW.config_hash, NEW.idempotency_key, NEW.created_by,
    NEW.correlation_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.source_file_name, OLD.source_content_type,
    OLD.source_size_bytes, OLD.file_hash, OLD.object_key, OLD.worksheet_name,
    OLD.total_rows, OLD.accepted_rows, OLD.rejected_rows, OLD.duplicate_rows,
    OLD.config_snapshot, OLD.config_hash, OLD.idempotency_key, OLD.created_by,
    OLD.correlation_id, OLD.created_at
  )
    OR NEW.ready_rows < OLD.ready_rows
    OR NEW.failed_rows < OLD.failed_rows
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.generated_job_id IS NOT NULL AND NEW.generated_job_id IS DISTINCT FROM OLD.generated_job_id)
    OR ((NEW.ready_rows, NEW.failed_rows) IS DISTINCT FROM (OLD.ready_rows, OLD.failed_rows)
      AND OLD.status <> 'COLLECTING')
    OR (OLD.generated_job_id IS NULL AND NEW.generated_job_id IS NOT NULL
      AND NEW.status NOT IN ('READY', 'PARTIAL'))
  THEN
    RAISE EXCEPTION 'import file identity or evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.status IN ('READY', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED') THEN
    RAISE EXCEPTION 'terminal import file is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.status_version <> OLD.status_version THEN
      RAISE EXCEPTION 'import file version cannot change without transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status_version <> OLD.status_version + 1 OR NOT (
    (OLD.status = 'RECEIVED' AND NEW.status IN ('QUEUED', 'CANCELLED', 'FAILED'))
    OR (OLD.status = 'QUEUED' AND NEW.status IN ('COLLECTING', 'CANCELLED', 'FAILED'))
    OR (OLD.status = 'COLLECTING' AND NEW.status IN ('READY', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid import file transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_import_files_state_guard ON auto_listing_import_files;
CREATE TRIGGER auto_listing_import_files_state_guard
BEFORE INSERT OR UPDATE ON auto_listing_import_files
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_import_file_transition();

CREATE OR REPLACE FUNCTION auto_listing_enforce_import_row_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_job_id TEXT;
  supplied_source_lease_cas_token TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status_version <> 0
      OR NEW.source_lease_cas_token IS NOT NULL
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
      OR NEW.status NOT IN ('ACCEPTED', 'PENDING', 'DUPLICATE_IN_FILE', 'INVALID_SKU')
      OR (
        NEW.status IN ('ACCEPTED', 'PENDING') AND (
          NEW.attempt_count <> 0
          OR NEW.collect_item_id IS NOT NULL
          OR NEW.auto_listing_item_id IS NOT NULL
          OR NEW.last_error_code IS NOT NULL
          OR NEW.last_error_safe IS NOT NULL
          OR NEW.completed_at IS NOT NULL
        )
      )
      OR (
        NEW.status = 'DUPLICATE_IN_FILE' AND (
          NEW.attempt_count <> 0
          OR NEW.collect_item_id IS NOT NULL
          OR NEW.auto_listing_item_id IS NOT NULL
          OR NEW.last_error_code IS DISTINCT FROM 'DUPLICATE_IN_FILE'
          OR NEW.last_error_safe IS NOT NULL
          OR NEW.completed_at IS NULL
        )
      )
      OR (
        NEW.status = 'INVALID_SKU' AND (
          NEW.attempt_count <> 0
          OR NEW.collect_item_id IS NOT NULL
          OR NEW.auto_listing_item_id IS NOT NULL
          OR NEW.last_error_code IS NULL
          OR NEW.last_error_code NOT IN ('INVALID_SKU', 'FORMULA_RESULT_MISSING', 'SKU_COLUMN_MUST_BE_TEXT')
          OR NEW.last_error_safe IS NOT NULL
          OR NEW.completed_at IS NULL
        )
      )
    THEN
      RAISE EXCEPTION 'invalid initial import row state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  supplied_source_lease_cas_token := NEW.source_lease_cas_token;
  NEW.source_lease_cas_token := NULL;

  IF ROW(
    NEW.id, NEW.account_id, NEW.import_file_id, NEW.row_number,
    NEW.raw_sku, NEW.normalized_sku, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.import_file_id, OLD.row_number,
    OLD.raw_sku, OLD.normalized_sku, OLD.created_at
  )
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.collect_item_id IS NOT NULL AND NEW.collect_item_id IS DISTINCT FROM OLD.collect_item_id)
    OR (OLD.auto_listing_item_id IS NOT NULL AND NEW.auto_listing_item_id IS DISTINCT FROM OLD.auto_listing_item_id)
    OR (OLD.collect_item_id IS NULL AND NEW.collect_item_id IS NOT NULL AND NEW.status <> 'READY')
    OR (OLD.auto_listing_item_id IS NULL AND NEW.auto_listing_item_id IS NOT NULL AND NEW.status <> 'READY')
  THEN
    RAISE EXCEPTION 'import row identity or evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'READY' AND NEW.status = 'READY'
    AND OLD.auto_listing_item_id IS NULL AND NEW.auto_listing_item_id IS NOT NULL
    AND NEW.status_version = OLD.status_version + 1
    AND ROW(
      NEW.attempt_count, NEW.collect_item_id, NEW.last_error_code,
      NEW.last_error_safe, NEW.completed_at
    ) IS NOT DISTINCT FROM ROW(
      OLD.attempt_count, OLD.collect_item_id, OLD.last_error_code,
      OLD.last_error_safe, OLD.completed_at
    )
  THEN
    SELECT generated_job_id
      INTO expected_job_id
      FROM auto_listing_import_files
     WHERE account_id = NEW.account_id
       AND id = NEW.import_file_id
     FOR KEY SHARE;
    IF expected_job_id IS NULL THEN
      RAISE EXCEPTION 'import row has no generated job to link' USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM auto_listing_job_items
     WHERE account_id = NEW.account_id
       AND id = NEW.auto_listing_item_id
       AND job_id = expected_job_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'import row item belongs to another generated job' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.status IN ('DUPLICATE_IN_FILE', 'INVALID_SKU', 'READY', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'terminal import row is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.status_version <> OLD.status_version OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'import row progress cannot change without transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status_version <> OLD.status_version + 1 OR NOT (
    (OLD.status = 'ACCEPTED' AND NEW.status IN ('PENDING', 'CANCELLED'))
    OR (OLD.status = 'PENDING' AND NEW.status IN ('COLLECTING', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'COLLECTING' AND NEW.status IN ('PENDING', 'READY', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid import row transition' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'PENDING' AND NEW.status = 'COLLECTING'
      AND NEW.attempt_count <> OLD.attempt_count + 1)
    OR (NOT (OLD.status = 'PENDING' AND NEW.status = 'COLLECTING')
      AND NEW.attempt_count <> OLD.attempt_count)
  THEN
    RAISE EXCEPTION 'invalid import row attempt progression' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'COLLECTING' AND NEW.status = 'PENDING' THEN
    IF NULLIF(BTRIM(supplied_source_lease_cas_token), '') IS NULL
      OR NEW.last_error_code IS NULL
    THEN
      RAISE EXCEPTION 'leased import row retry requires failure evidence' USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM auto_listing_source_outbox
     WHERE account_id = NEW.account_id
       AND import_file_id = NEW.import_file_id
       AND row_id = NEW.id
       AND event_type = 'COLLECT_EXCEL_SKU'
       AND state = 'PROCESSING'
       AND lease_token = supplied_source_lease_cas_token
       AND ISFINITE(lease_expires_at)
       AND lease_expires_at > STATEMENT_TIMESTAMP()
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'import row retry lease is missing, stale, or expired' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_import_rows_state_guard ON auto_listing_import_rows;
CREATE TRIGGER auto_listing_import_rows_state_guard
BEFORE INSERT OR UPDATE ON auto_listing_import_rows
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_import_row_transition();

CREATE TABLE IF NOT EXISTS auto_listing_source_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  import_file_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'COLLECT_EXCEL_SKU'),
  dedupe_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(dedupe_key), '') IS NOT NULL
    AND OCTET_LENGTH(dedupe_key) <= 240
  ),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING', 'PROCESSING', 'COMPLETED', 'DEAD'
  )),
  state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  -- A worker supplies this transient guard only while releasing a live lease.
  -- The BEFORE trigger validates it then clears it, so it is never persisted.
  lease_cas_token TEXT CHECK (lease_cas_token IS NULL),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  last_error_safe TEXT CHECK (
    last_error_safe IS NULL OR OCTET_LENGTH(last_error_safe) <= 500
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, id),
  UNIQUE (account_id, dedupe_key),
  UNIQUE (account_id, import_file_id, row_id, event_type),
  FOREIGN KEY (account_id, import_file_id, row_id)
    REFERENCES auto_listing_import_rows(account_id, import_file_id, id) ON DELETE CASCADE,
  CHECK (
    (state = 'PROCESSING'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL)
    OR (state = 'PENDING'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL)
    OR (state IN ('COMPLETED', 'DEAD')
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL)
  )
);

ALTER TABLE auto_listing_source_outbox
  ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_cas_token TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auto_listing_source_outbox'::regclass
       AND conname = 'auto_listing_source_outbox_lease_cas_token_ck'
  ) THEN
    ALTER TABLE auto_listing_source_outbox
      ADD CONSTRAINT auto_listing_source_outbox_lease_cas_token_ck
      CHECK (lease_cas_token IS NULL) NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_source_outbox_max_lease_duration()
RETURNS INTERVAL
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT INTERVAL '5 minutes';
$$;

CREATE OR REPLACE FUNCTION auto_listing_enforce_source_outbox_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  supplied_lease_token TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' OR NEW.state_version <> 0 OR NEW.attempts <> 0
      OR NEW.lease_generation <> 0 OR NEW.lease_cas_token IS NOT NULL THEN
      RAISE EXCEPTION 'invalid initial source outbox state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id, NEW.account_id, NEW.import_file_id, NEW.row_id,
    NEW.event_type, NEW.dedupe_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.import_file_id, OLD.row_id,
    OLD.event_type, OLD.dedupe_key, OLD.created_at
  ) OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'source outbox identity or evidence is immutable' USING ERRCODE = '23514';
  END IF;

  supplied_lease_token := NEW.lease_cas_token;
  NEW.lease_cas_token := NULL;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.state IN ('COMPLETED', 'DEAD') THEN
    RAISE EXCEPTION 'terminal source outbox row is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.state = 'PENDING' AND NEW.state = 'PROCESSING' THEN
    IF OLD.available_at > STATEMENT_TIMESTAMP()
      OR NEW.state_version <> OLD.state_version + 1
      OR NEW.attempts <> OLD.attempts + 1
      OR NEW.lease_generation <> OLD.lease_generation + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NEW.lease_expires_at <= STATEMENT_TIMESTAMP()
      OR NOT ISFINITE(NEW.lease_expires_at)
      OR NEW.lease_expires_at > STATEMENT_TIMESTAMP() + auto_listing_source_outbox_max_lease_duration()
      OR NULLIF(BTRIM(NEW.lease_token), '') IS NULL
      OR NULLIF(BTRIM(NEW.lease_owner), '') IS NULL
    THEN
      RAISE EXCEPTION 'invalid source outbox claim' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'PROCESSING' AND NEW.state = 'PROCESSING' THEN
    IF OLD.lease_expires_at > STATEMENT_TIMESTAMP()
      OR NEW.state_version <> OLD.state_version + 1
      OR NEW.attempts <> OLD.attempts + 1
      OR NEW.lease_generation <> OLD.lease_generation + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NEW.lease_expires_at <= STATEMENT_TIMESTAMP()
      OR NOT ISFINITE(NEW.lease_expires_at)
      OR NEW.lease_expires_at > STATEMENT_TIMESTAMP() + auto_listing_source_outbox_max_lease_duration()
      OR NULLIF(BTRIM(NEW.lease_token), '') IS NULL
      OR NEW.lease_token = OLD.lease_token
      OR NULLIF(BTRIM(NEW.lease_owner), '') IS NULL
    THEN
      RAISE EXCEPTION 'invalid source outbox reclaim' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'PROCESSING' AND NEW.state IN ('PENDING', 'COMPLETED', 'DEAD') THEN
    IF OLD.lease_expires_at <= STATEMENT_TIMESTAMP()
      OR supplied_lease_token IS DISTINCT FROM OLD.lease_token
      OR NEW.state_version <> OLD.state_version + 1
      OR NEW.attempts <> OLD.attempts
      OR NEW.lease_generation <> OLD.lease_generation
      OR (NEW.state IN ('COMPLETED', 'DEAD') AND NEW.available_at IS DISTINCT FROM OLD.available_at)
    THEN
      RAISE EXCEPTION 'invalid source outbox lease release' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid source outbox transition' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_source_outbox_state_guard ON auto_listing_source_outbox;
CREATE TRIGGER auto_listing_source_outbox_state_guard
BEFORE INSERT OR UPDATE ON auto_listing_source_outbox
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_source_outbox_transition();

CREATE INDEX IF NOT EXISTS auto_listing_import_files_account_status_idx
  ON auto_listing_import_files(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS auto_listing_import_rows_import_status_idx
  ON auto_listing_import_rows(account_id, import_file_id, status, row_number);
CREATE INDEX IF NOT EXISTS auto_listing_import_rows_account_collect_idx
  ON auto_listing_import_rows(account_id, collect_item_id)
  WHERE collect_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auto_listing_source_outbox_pending_idx
  ON auto_listing_source_outbox(available_at, created_at, account_id)
  WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS auto_listing_source_outbox_import_state_idx
  ON auto_listing_source_outbox(account_id, import_file_id, state, created_at);
