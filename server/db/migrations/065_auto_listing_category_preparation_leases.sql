-- A PostgreSQL session advisory lock is the safety boundary for category preparation.
-- Audit rows are observability only: they never substitute for the live session lock.

CREATE OR REPLACE FUNCTION account_ozon_shared_category_lease_key(account_id TEXT,shared_category_id TEXT)
RETURNS BIGINT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT hashtextextended(account_id || CHR(31) || shared_category_id,771815451337771::BIGINT)
$$;

CREATE TABLE auto_listing_category_preparation_leases (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  holder_backend_pid INTEGER NOT NULL CHECK (holder_backend_pid > 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED','EXPIRED','ORPHANED')),
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > acquired_at),
  released_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('COMMITTED','FAILED','CONFLICT','TIMEOUT','CRASHED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,id),
  CHECK ((state='ACTIVE' AND released_at IS NULL AND outcome IS NULL)
    OR (state<>'ACTIVE' AND released_at IS NOT NULL AND outcome IS NOT NULL))
);

CREATE INDEX auto_listing_category_preparation_leases_recovery_idx
  ON auto_listing_category_preparation_leases(account_id,state,expires_at,id);

CREATE TABLE auto_listing_category_preparation_lease_items (
  account_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  collect_item_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  shared_category_id TEXT NOT NULL,
  shared_category_version INTEGER NOT NULL CHECK (shared_category_version > 0),
  source_description_category_id BIGINT NOT NULL CHECK (source_description_category_id > 0),
  source_type_id BIGINT NOT NULL CHECK (source_type_id > 0),
  description_category_id BIGINT NOT NULL CHECK (description_category_id > 0),
  type_id BIGINT NOT NULL CHECK (type_id > 0),
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  taxonomy_fingerprint TEXT NOT NULL CHECK (
    taxonomy_fingerprint='' OR taxonomy_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  provenance TEXT NOT NULL CHECK (provenance IN ('SOURCE_DIRECT','OZON_REFRESH','MANUAL')),
  PRIMARY KEY (account_id,lease_id,collect_item_id),
  FOREIGN KEY (account_id,lease_id)
    REFERENCES auto_listing_category_preparation_leases(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,collect_item_id)
    REFERENCES collect_items(account_id,id) ON DELETE CASCADE
);

CREATE INDEX auto_listing_category_preparation_lease_items_shared_idx
  ON auto_listing_category_preparation_lease_items(
    account_id,shared_category_id,shared_category_version,lease_id
  );

CREATE OR REPLACE FUNCTION guard_auto_listing_category_preparation_lease_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id
    OR NEW.holder_backend_pid<>OLD.holder_backend_pid
    OR NEW.acquired_at<>OLD.acquired_at OR NEW.expires_at<>OLD.expires_at
    OR OLD.state<>'ACTIVE' OR NEW.state='ACTIVE'
    OR NEW.released_at IS NULL OR NEW.outcome IS NULL
    OR NEW.updated_at<OLD.updated_at
  THEN
    RAISE EXCEPTION 'invalid auto-listing category preparation lease transition'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_category_preparation_leases_transition_guard
BEFORE UPDATE ON auto_listing_category_preparation_leases
FOR EACH ROW EXECUTE FUNCTION guard_auto_listing_category_preparation_lease_transition();

CREATE OR REPLACE FUNCTION lock_account_ozon_shared_category_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  locked_account_id TEXT;
  locked_shared_category_id TEXT;
BEGIN
  locked_account_id := CASE WHEN TG_OP='INSERT' THEN NEW.account_id ELSE OLD.account_id END;
  locked_shared_category_id := CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  PERFORM pg_advisory_xact_lock(
    account_ozon_shared_category_lease_key(locked_account_id,locked_shared_category_id)
  );
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER account_ozon_shared_categories_00_preparation_lease_guard
BEFORE INSERT OR UPDATE OR DELETE ON account_ozon_shared_categories
FOR EACH ROW EXECUTE FUNCTION lock_account_ozon_shared_category_transition();
