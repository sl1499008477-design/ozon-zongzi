-- Immutable, normalized proof that one tenant-owned local warehouse was
-- observed as a currently active RFBS warehouse. No public Ozon response or
-- credential is stored here; raw_response_ref is reserved for a bounded safe
-- reference if a later controlled collector persists one.

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_store_id_id_warehouse_id_key
  ON warehouses(store_id,id,warehouse_id);

CREATE TABLE IF NOT EXISTS auto_listing_rfbs_warehouse_evidence (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  warehouse_record_id TEXT NOT NULL,
  platform_warehouse_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(platform_warehouse_id),'') IS NOT NULL
    AND LOWER(platform_warehouse_id) NOT LIKE 'wh\_%' ESCAPE '\'
  ),
  schema_version TEXT NOT NULL CHECK (
    schema_version = 'AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1'
  ),
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type = 'RFBS'),
  status TEXT NOT NULL CHECK (status = 'ACTIVE'),
  outcome TEXT NOT NULL CHECK (outcome = 'PASSED'),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > observed_at),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  correlation_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id) <= 240
  ),
  actor_account_id TEXT NOT NULL CHECK (actor_account_id = account_id),
  raw_response_ref TEXT CHECK (
    raw_response_ref IS NULL OR (
      OCTET_LENGTH(raw_response_ref) <= 500
      AND raw_response_ref ~ '^rfbs-safe-ref:[A-Za-z0-9._:/-]{1,480}$'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP(),
  UNIQUE (account_id,id),
  FOREIGN KEY (account_id,store_id)
    REFERENCES stores(owner_account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (store_id,warehouse_record_id,platform_warehouse_id)
    REFERENCES warehouses(store_id,id,warehouse_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS auto_listing_rfbs_warehouse_evidence_scope_idx
  ON auto_listing_rfbs_warehouse_evidence(
    account_id,store_id,warehouse_record_id,created_at DESC
  );

CREATE OR REPLACE FUNCTION auto_listing_validate_fresh_rfbs_warehouse_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at <= STATEMENT_TIMESTAMP() THEN
    RAISE EXCEPTION 'RFBS warehouse evidence is expired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_validate_rfbs_warehouse_evidence_target()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM warehouses AS warehouse
    JOIN stores AS store
      ON store.id=warehouse.store_id AND store.owner_account_id=NEW.account_id
   WHERE warehouse.store_id=NEW.store_id
     AND warehouse.id=NEW.warehouse_record_id
     AND warehouse.warehouse_id=NEW.platform_warehouse_id
     AND UPPER(BTRIM(warehouse.warehouse_type))='RFBS'
     AND LOWER(BTRIM(warehouse.status)) NOT IN ('disabled','inactive','archived','deleted','blocked')
     AND warehouse.is_active IS TRUE
     AND warehouse.is_archived IS FALSE
   FOR SHARE OF store,warehouse;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RFBS warehouse evidence does not match an active tenant warehouse'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_rfbs_warehouse_evidence_fresh
BEFORE INSERT ON auto_listing_rfbs_warehouse_evidence
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_fresh_rfbs_warehouse_evidence();

CREATE TRIGGER auto_listing_rfbs_warehouse_evidence_target
AFTER INSERT ON auto_listing_rfbs_warehouse_evidence
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_rfbs_warehouse_evidence_target();

CREATE OR REPLACE FUNCTION auto_listing_reject_rfbs_warehouse_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
    AND (
      NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
      OR NOT EXISTS (
        SELECT 1 FROM stores
         WHERE owner_account_id=OLD.account_id AND id=OLD.store_id
      )
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RFBS warehouse evidence is append-only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER auto_listing_rfbs_warehouse_evidence_append_only
BEFORE UPDATE OR DELETE ON auto_listing_rfbs_warehouse_evidence
FOR EACH ROW EXECUTE FUNCTION auto_listing_reject_rfbs_warehouse_evidence_mutation();

ALTER TABLE auto_listing_jobs
  ADD COLUMN IF NOT EXISTS warehouse_validation_evidence_id TEXT;
ALTER TABLE auto_listing_submission_links
  ADD COLUMN IF NOT EXISTS warehouse_validation_evidence_id TEXT;
ALTER TABLE auto_listing_upload_attempts
  ADD COLUMN IF NOT EXISTS warehouse_validation_evidence_id TEXT;

ALTER TABLE auto_listing_jobs
  ADD CONSTRAINT auto_listing_jobs_rfbs_warehouse_evidence_fkey
  FOREIGN KEY (account_id,warehouse_validation_evidence_id)
  REFERENCES auto_listing_rfbs_warehouse_evidence(account_id,id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE auto_listing_submission_links
  ADD CONSTRAINT auto_listing_submission_links_rfbs_warehouse_evidence_fkey
  FOREIGN KEY (account_id,warehouse_validation_evidence_id)
  REFERENCES auto_listing_rfbs_warehouse_evidence(account_id,id) ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE auto_listing_upload_attempts
  ADD CONSTRAINT auto_listing_upload_attempts_rfbs_warehouse_evidence_fkey
  FOREIGN KEY (account_id,warehouse_validation_evidence_id)
  REFERENCES auto_listing_rfbs_warehouse_evidence(account_id,id) ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE auto_listing_jobs
  VALIDATE CONSTRAINT auto_listing_jobs_rfbs_warehouse_evidence_fkey;
ALTER TABLE auto_listing_submission_links
  VALIDATE CONSTRAINT auto_listing_submission_links_rfbs_warehouse_evidence_fkey;
ALTER TABLE auto_listing_upload_attempts
  VALIDATE CONSTRAINT auto_listing_upload_attempts_rfbs_warehouse_evidence_fkey;

CREATE OR REPLACE FUNCTION auto_listing_validate_job_rfbs_warehouse_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.warehouse_validation_evidence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM auto_listing_rfbs_warehouse_evidence AS evidence
     WHERE evidence.account_id=NEW.account_id
       AND evidence.id=NEW.warehouse_validation_evidence_id
       AND evidence.outcome='PASSED'
       AND evidence.fulfillment_type='RFBS'
       AND evidence.expires_at > STATEMENT_TIMESTAMP()
  ) THEN
    RAISE EXCEPTION 'job requires fresh RFBS warehouse evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_jobs_rfbs_warehouse_binding_guard
AFTER INSERT ON auto_listing_jobs
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_job_rfbs_warehouse_binding();

CREATE OR REPLACE FUNCTION auto_listing_validate_item_rfbs_warehouse_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  job_evidence_id TEXT;
  target_type TEXT;
BEGIN
  SELECT job.warehouse_validation_evidence_id INTO job_evidence_id
    FROM auto_listing_jobs AS job
   WHERE job.account_id=NEW.account_id AND job.id=NEW.job_id;
  SELECT UPPER(BTRIM(warehouse.warehouse_type)) INTO target_type
    FROM warehouses AS warehouse
    JOIN stores AS store
      ON store.id=warehouse.store_id AND store.owner_account_id=NEW.account_id
   WHERE warehouse.store_id=NEW.target_store_id AND warehouse.id=NEW.target_warehouse_id;
  IF target_type='RFBS' THEN
    IF job_evidence_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM auto_listing_rfbs_warehouse_evidence AS evidence
       WHERE evidence.account_id=NEW.account_id AND evidence.id=job_evidence_id
         AND evidence.store_id=NEW.target_store_id
         AND evidence.warehouse_record_id=NEW.target_warehouse_id
         AND evidence.expires_at > STATEMENT_TIMESTAMP()
    ) THEN
      RAISE EXCEPTION 'RFBS job item requires matching fresh warehouse evidence' USING ERRCODE='23514';
    END IF;
  ELSIF job_evidence_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-RFBS job cannot bind RFBS warehouse evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_job_items_rfbs_warehouse_binding_guard
BEFORE INSERT ON auto_listing_job_items
FOR EACH ROW EXECUTE FUNCTION auto_listing_validate_item_rfbs_warehouse_binding();

CREATE OR REPLACE FUNCTION auto_listing_protect_rfbs_warehouse_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.warehouse_validation_evidence_id IS DISTINCT FROM OLD.warehouse_validation_evidence_id THEN
    RAISE EXCEPTION '% RFBS warehouse evidence binding is immutable', TG_TABLE_NAME
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_jobs_rfbs_warehouse_binding_immutable
BEFORE UPDATE ON auto_listing_jobs
FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_rfbs_warehouse_binding();
CREATE TRIGGER auto_listing_submission_links_rfbs_warehouse_binding_immutable
BEFORE UPDATE ON auto_listing_submission_links
FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_rfbs_warehouse_binding();
CREATE TRIGGER auto_listing_upload_attempts_rfbs_warehouse_binding_immutable
BEFORE UPDATE ON auto_listing_upload_attempts
FOR EACH ROW EXECUTE FUNCTION auto_listing_protect_rfbs_warehouse_binding();

CREATE OR REPLACE FUNCTION auto_listing_rfbs_validation_audit_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action='AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED'
    OR (TG_OP='UPDATE' AND NEW.action='AUTO_LISTING_RFBS_WAREHOUSE_VALIDATED')
  THEN
    IF TG_OP='UPDATE'
      AND (
        NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.store_id IS DISTINCT FROM OLD.store_id
      )
      AND (TO_JSONB(NEW)-'account_id'-'store_id')
        IS NOT DISTINCT FROM (TO_JSONB(OLD)-'account_id'-'store_id')
      AND (
        NEW.account_id IS NOT DISTINCT FROM OLD.account_id
        OR (
          OLD.account_id IS NOT NULL AND NEW.account_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
        )
      )
      AND (
        NEW.store_id IS NOT DISTINCT FROM OLD.store_id
        OR (
          OLD.store_id IS NOT NULL AND NEW.store_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM stores
             WHERE id=OLD.store_id
               AND (OLD.account_id IS NULL OR owner_account_id=OLD.account_id)
          )
        )
      )
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'RFBS warehouse validation audits are append-only' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_listing_rfbs_validation_audit_append_only_trigger
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION auto_listing_rfbs_validation_audit_append_only();
