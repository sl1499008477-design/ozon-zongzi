CREATE TABLE IF NOT EXISTS auto_listing_import_object_cleanup (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(import_id), '') IS NOT NULL AND OCTET_LENGTH(import_id) <= 240
  ),
  object_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(object_key), '') IS NOT NULL AND OCTET_LENGTH(object_key) <= 1024
  ),
  reason_code TEXT NOT NULL CHECK (reason_code = 'AUTO_LISTING_IMPORT_ORPHANED_WORKBOOK'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED')),
  status_version BIGINT NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_cas_token TEXT CHECK (lease_cas_token IS NULL),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (account_id, id),
  UNIQUE (account_id, object_key),
  CHECK (
    (status = 'PROCESSING'
      AND NULLIF(BTRIM(lease_owner), '') IS NOT NULL
      AND NULLIF(BTRIM(lease_token), '') IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL)
    OR (status = 'PENDING'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'COMPLETED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION auto_listing_enforce_import_cleanup_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  supplied_lease_token TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.status_version <> 0 OR NEW.attempt_count <> 0
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_token IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL OR NEW.lease_cas_token IS NOT NULL
      OR NEW.last_error_code IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.updated_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION 'invalid initial import cleanup state' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  supplied_lease_token := NEW.lease_cas_token;
  NEW.lease_cas_token := NULL;
  IF ROW(
    NEW.id,NEW.account_id,NEW.import_id,NEW.object_key,NEW.reason_code,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,OLD.account_id,OLD.import_id,OLD.object_key,OLD.reason_code,OLD.created_at
  ) OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'import cleanup identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'terminal import cleanup is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'PENDING' AND NEW.status = 'PROCESSING' THEN
    IF OLD.available_at > STATEMENT_TIMESTAMP()
      OR NEW.status_version <> OLD.status_version + 1
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NULLIF(BTRIM(NEW.lease_owner), '') IS NULL
      OR NULLIF(BTRIM(NEW.lease_token), '') IS NULL
      OR NEW.lease_expires_at <= STATEMENT_TIMESTAMP()
      OR NEW.lease_expires_at > STATEMENT_TIMESTAMP() + INTERVAL '5 minutes'
      OR NOT ISFINITE(NEW.lease_expires_at)
      OR NEW.completed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid import cleanup claim' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PROCESSING' AND NEW.status = 'PROCESSING' THEN
    IF OLD.lease_expires_at > STATEMENT_TIMESTAMP()
      OR NEW.status_version <> OLD.status_version + 1
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NULLIF(BTRIM(NEW.lease_owner), '') IS NULL
      OR NULLIF(BTRIM(NEW.lease_token), '') IS NULL
      OR NEW.lease_token = OLD.lease_token
      OR NEW.lease_expires_at <= STATEMENT_TIMESTAMP()
      OR NEW.lease_expires_at > STATEMENT_TIMESTAMP() + INTERVAL '5 minutes'
      OR NOT ISFINITE(NEW.lease_expires_at)
      OR NEW.completed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid import cleanup reclaim' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PROCESSING' AND NEW.status IN ('PENDING', 'COMPLETED') THEN
    IF OLD.lease_expires_at <= STATEMENT_TIMESTAMP()
      OR supplied_lease_token IS DISTINCT FROM OLD.lease_token
      OR NEW.status_version <> OLD.status_version + 1
      OR NEW.attempt_count <> OLD.attempt_count
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR (NEW.status = 'PENDING' AND (
        NEW.available_at <= STATEMENT_TIMESTAMP() OR NEW.last_error_code IS NULL OR NEW.completed_at IS NOT NULL
      ))
      OR (NEW.status = 'COMPLETED' AND NEW.completed_at IS NULL)
    THEN
      RAISE EXCEPTION 'invalid import cleanup release' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid import cleanup transition' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_import_object_cleanup_state_guard
  ON auto_listing_import_object_cleanup;
CREATE TRIGGER auto_listing_import_object_cleanup_state_guard
BEFORE INSERT OR UPDATE ON auto_listing_import_object_cleanup
FOR EACH ROW EXECUTE FUNCTION auto_listing_enforce_import_cleanup_transition();

CREATE INDEX IF NOT EXISTS auto_listing_import_object_cleanup_runnable_idx
  ON auto_listing_import_object_cleanup(available_at,created_at,account_id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS auto_listing_import_object_cleanup_reclaim_idx
  ON auto_listing_import_object_cleanup(lease_expires_at,account_id)
  WHERE status = 'PROCESSING';

-- Claims use row locks so two cleanup workers cannot own the same object.
-- Repository claim statements must select candidates with FOR UPDATE SKIP LOCKED.
