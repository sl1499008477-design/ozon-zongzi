-- Forward-only RFBS authorization handoff from the auto-listing upload claim
-- into the standard listing worker. FBS and legacy submissions have no row.

CREATE TABLE IF NOT EXISTS submission_rfbs_handoffs (
  id TEXT PRIMARY KEY CHECK (
    NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id) <= 240
  ),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  local_warehouse_id TEXT NOT NULL,
  platform_warehouse_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(platform_warehouse_id),'') IS NOT NULL
    AND LOWER(platform_warehouse_id) NOT LIKE 'wh\_%' ESCAPE '\'
  ),
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type='RFBS'),
  link_identity_evidence_id TEXT NOT NULL,
  attempt_authorization_evidence_id TEXT NOT NULL,
  reserved_attempt_id TEXT NOT NULL,
  submission_link_id TEXT NOT NULL,
  business_idempotency_key TEXT NOT NULL CHECK (
    NULLIF(BTRIM(business_idempotency_key),'') IS NOT NULL
    AND OCTET_LENGTH(business_idempotency_key) <= 512
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP(),
  UNIQUE (account_id,id),
  UNIQUE (account_id,submission_job_id),
  UNIQUE (account_id,submission_snapshot_id),
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id,store_id)
    REFERENCES submission_jobs(account_id,id,snapshot_id,store_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,submission_snapshot_id,store_id)
    REFERENCES submission_snapshots(account_id,id,store_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,store_id)
    REFERENCES stores(owner_account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id,local_warehouse_id,platform_warehouse_id)
    REFERENCES warehouses(store_id,id,warehouse_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,attempt_authorization_evidence_id)
    REFERENCES auto_listing_rfbs_warehouse_evidence(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,link_identity_evidence_id)
    REFERENCES auto_listing_rfbs_warehouse_evidence(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,reserved_attempt_id)
    REFERENCES auto_listing_upload_attempts(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,submission_link_id)
    REFERENCES auto_listing_submission_links(account_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS submission_rfbs_handoffs_target_idx
  ON submission_rfbs_handoffs(account_id,store_id,local_warehouse_id);

CREATE OR REPLACE FUNCTION validate_submission_rfbs_handoff()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM submission_jobs AS job
    JOIN submission_snapshots AS snapshot
      ON snapshot.account_id=job.account_id AND snapshot.id=job.snapshot_id
     AND snapshot.store_id=job.store_id
    JOIN auto_listing_submission_links AS link
     ON link.account_id=job.account_id AND link.id=NEW.submission_link_id
     AND link.target_store_id=job.store_id
     AND link.idempotency_key=NEW.business_idempotency_key
     AND link.warehouse_validation_evidence_id=NEW.link_identity_evidence_id
     AND (
       (link.status='RESERVED' AND link.submission_job_id IS NULL AND link.submission_snapshot_id IS NULL)
       OR (link.status IN ('SUBMITTED','RECONCILING','SUCCEEDED')
         AND link.submission_job_id=NEW.submission_job_id
         AND link.submission_snapshot_id=NEW.submission_snapshot_id)
     )
    JOIN auto_listing_upload_attempts AS attempt
      ON attempt.account_id=link.account_id AND attempt.id=NEW.reserved_attempt_id
     AND attempt.submission_link_id=link.id
     AND attempt.job_id=link.job_id
     AND attempt.auto_listing_item_id=link.auto_listing_item_id
     AND attempt.target_store_id=link.target_store_id
     AND attempt.target_warehouse_id=NEW.local_warehouse_id
     AND attempt.warehouse_validation_evidence_id=NEW.attempt_authorization_evidence_id
     AND attempt.outcome='RESERVED'
     AND attempt.listing_pipeline_response_summary->>'submissionIdempotencyKey'
       =NEW.business_idempotency_key
    JOIN auto_listing_rfbs_warehouse_evidence AS evidence
      ON evidence.account_id=link.account_id AND evidence.id=attempt.warehouse_validation_evidence_id
     AND evidence.id=NEW.attempt_authorization_evidence_id
     AND evidence.store_id=link.target_store_id
     AND evidence.warehouse_record_id=NEW.local_warehouse_id
     AND evidence.platform_warehouse_id=NEW.platform_warehouse_id
     AND evidence.fulfillment_type='RFBS' AND evidence.status='ACTIVE'
     AND evidence.outcome='PASSED'
    JOIN auto_listing_rfbs_warehouse_evidence AS identity_evidence
      ON identity_evidence.account_id=link.account_id
     AND identity_evidence.id=NEW.link_identity_evidence_id
     AND identity_evidence.store_id=link.target_store_id
     AND identity_evidence.warehouse_record_id=NEW.local_warehouse_id
     AND identity_evidence.platform_warehouse_id=NEW.platform_warehouse_id
     AND identity_evidence.fulfillment_type='RFBS'
     AND identity_evidence.status='ACTIVE' AND identity_evidence.outcome='PASSED'
    JOIN warehouses AS warehouse
      ON warehouse.store_id=evidence.store_id AND warehouse.id=evidence.warehouse_record_id
     AND warehouse.warehouse_id=evidence.platform_warehouse_id
   WHERE job.account_id=NEW.account_id
     AND job.id=NEW.submission_job_id
     AND job.snapshot_id=NEW.submission_snapshot_id
     AND job.store_id=NEW.store_id
     AND job.type='AUTO_LISTING'
     AND UPPER(BTRIM(warehouse.warehouse_type))='RFBS'
     AND LOWER(BTRIM(warehouse.status)) NOT IN
       ('disabled','inactive','archived','deleted','blocked')
     AND warehouse.is_active IS TRUE
     AND warehouse.is_archived IS FALSE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid RFBS standard-submission handoff' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_rfbs_handoffs_insert_guard
BEFORE INSERT ON submission_rfbs_handoffs
FOR EACH ROW EXECUTE FUNCTION validate_submission_rfbs_handoff();

CREATE OR REPLACE FUNCTION reject_submission_rfbs_handoff_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
    AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RFBS submission handoffs are append-only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER submission_rfbs_handoffs_append_only
BEFORE UPDATE OR DELETE ON submission_rfbs_handoffs
FOR EACH ROW EXECUTE FUNCTION reject_submission_rfbs_handoff_mutation();

-- Backfill only already-bound pre-061 RFBS submissions whose immutable link,
-- RESERVED attempt and warehouse identities are all still provable. Drifted
-- targets remain without a row and are recovered lazily only after a fresh
-- phase verification sees the exact RFBS target again.
INSERT INTO submission_rfbs_handoffs (
  id,account_id,submission_job_id,submission_snapshot_id,store_id,local_warehouse_id,
  platform_warehouse_id,fulfillment_type,link_identity_evidence_id,
  attempt_authorization_evidence_id,reserved_attempt_id,submission_link_id,business_idempotency_key
)
SELECT 'rfbs-handoff-backfill-' || MD5(link.account_id || ':' || link.id || ':' || job.id),
       link.account_id,job.id,job.snapshot_id,job.store_id,attempt.target_warehouse_id,
       attempt_evidence.platform_warehouse_id,'RFBS',link.warehouse_validation_evidence_id,
       attempt.warehouse_validation_evidence_id,attempt.id,link.id,link.idempotency_key
  FROM auto_listing_submission_links AS link
  JOIN submission_jobs AS job
    ON job.account_id=link.account_id AND job.id=link.submission_job_id
   AND job.snapshot_id=link.submission_snapshot_id AND job.store_id=link.target_store_id
   AND job.type='AUTO_LISTING'
  JOIN LATERAL (
    SELECT candidate.* FROM auto_listing_upload_attempts AS candidate
     WHERE candidate.account_id=link.account_id
       AND candidate.submission_link_id=link.id
       AND candidate.job_id=link.job_id
       AND candidate.auto_listing_item_id=link.auto_listing_item_id
       AND candidate.target_store_id=link.target_store_id
       AND candidate.outcome='RESERVED'
       AND candidate.listing_pipeline_response_summary->>'submissionIdempotencyKey'=link.idempotency_key
     ORDER BY candidate.created_at DESC,candidate.id DESC
     LIMIT 1
  ) AS attempt ON TRUE
  JOIN auto_listing_rfbs_warehouse_evidence AS identity_evidence
    ON identity_evidence.account_id=link.account_id
   AND identity_evidence.id=link.warehouse_validation_evidence_id
   AND identity_evidence.store_id=link.target_store_id
   AND identity_evidence.fulfillment_type='RFBS' AND identity_evidence.outcome='PASSED'
  JOIN auto_listing_rfbs_warehouse_evidence AS attempt_evidence
    ON attempt_evidence.account_id=link.account_id
   AND attempt_evidence.id=attempt.warehouse_validation_evidence_id
   AND attempt_evidence.store_id=link.target_store_id
   AND attempt_evidence.warehouse_record_id=attempt.target_warehouse_id
   AND attempt_evidence.platform_warehouse_id=identity_evidence.platform_warehouse_id
   AND attempt_evidence.fulfillment_type='RFBS' AND attempt_evidence.outcome='PASSED'
  JOIN warehouses AS warehouse
    ON warehouse.store_id=link.target_store_id AND warehouse.id=attempt.target_warehouse_id
   AND warehouse.warehouse_id=attempt_evidence.platform_warehouse_id
   AND UPPER(BTRIM(warehouse.warehouse_type))='RFBS'
   AND LOWER(BTRIM(warehouse.status)) NOT IN
     ('disabled','inactive','archived','deleted','blocked')
   AND warehouse.is_active IS TRUE AND warehouse.is_archived IS FALSE
 WHERE link.status IN ('SUBMITTED','RECONCILING','SUCCEEDED')
   AND link.submission_job_id IS NOT NULL AND link.submission_snapshot_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- A pre-061 AUTO_LISTING job is deployable only when it was backfilled above
-- or its immutable stock snapshot is wholly and exactly current FBS. This
-- deliberately aborts migration for ambiguous rows instead of silently
-- allowing an old RFBS job to bypass the worker gate after target drift.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM submission_jobs AS job
    JOIN submission_snapshots AS snapshot
      ON snapshot.account_id=job.account_id AND snapshot.id=job.snapshot_id
     AND snapshot.store_id=job.store_id
    LEFT JOIN submission_rfbs_handoffs AS handoff
      ON handoff.account_id=job.account_id AND handoff.submission_job_id=job.id
     AND handoff.submission_snapshot_id=job.snapshot_id AND handoff.store_id=job.store_id
    WHERE job.type='AUTO_LISTING' AND handoff.id IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM auto_listing_submission_links AS link
           WHERE link.account_id=job.account_id AND link.target_store_id=job.store_id
             AND link.submission_job_id=job.id AND link.submission_snapshot_id=job.snapshot_id
             AND link.warehouse_validation_evidence_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1 FROM auto_listing_submission_links AS link
          JOIN auto_listing_listing_bases AS listing_base
            ON listing_base.account_id=link.account_id AND listing_base.id=link.listing_base_id
          JOIN auto_listing_upload_attempts AS attempt
            ON attempt.account_id=link.account_id AND attempt.submission_link_id=link.id
           AND attempt.job_id=link.job_id AND attempt.auto_listing_item_id=link.auto_listing_item_id
           AND attempt.target_store_id=link.target_store_id AND attempt.outcome='RESERVED'
          JOIN auto_listing_rfbs_warehouse_evidence AS attempt_evidence
            ON attempt_evidence.account_id=link.account_id
           AND attempt_evidence.id=attempt.warehouse_validation_evidence_id
           AND attempt_evidence.store_id=link.target_store_id
           AND attempt_evidence.warehouse_record_id=attempt.target_warehouse_id
           AND attempt_evidence.fulfillment_type='RFBS' AND attempt_evidence.outcome='PASSED'
         WHERE link.account_id=job.account_id AND link.target_store_id=job.store_id
           AND link.submission_job_id IS NULL AND link.submission_snapshot_id IS NULL
           AND link.warehouse_validation_evidence_id IS NOT NULL
           AND listing_base.collect_item_id=job.collect_item_id
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(snapshot.stocks) AS stock
              WHERE stock->>'warehouse_id'=attempt_evidence.platform_warehouse_id
           )
        )
        OR jsonb_array_length(snapshot.stocks)=0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(snapshot.stocks) AS stock
          LEFT JOIN warehouses AS warehouse
            ON warehouse.store_id=job.store_id
           AND warehouse.warehouse_id=stock->>'warehouse_id'
          WHERE warehouse.id IS NULL OR UPPER(BTRIM(warehouse.warehouse_type))<>'FBS'
             OR LOWER(BTRIM(warehouse.status)) IN
               ('disabled','inactive','archived','deleted','blocked')
             OR warehouse.is_active IS NOT TRUE OR warehouse.is_archived IS NOT FALSE
        )
      )
  ) THEN
    RAISE EXCEPTION 'unresolved AUTO_LISTING fulfillment blocks migration 061' USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_submission_job_rfbs_handoff_at_commit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type<>'AUTO_LISTING' THEN RETURN NEW; END IF;
  PERFORM 1 FROM submission_rfbs_handoffs AS handoff
   WHERE handoff.account_id=NEW.account_id AND handoff.submission_job_id=NEW.id
     AND handoff.submission_snapshot_id=NEW.snapshot_id AND handoff.store_id=NEW.store_id;
  IF FOUND THEN RETURN NEW; END IF;
  PERFORM 1
    FROM submission_snapshots AS snapshot
    JOIN auto_listing_submission_links AS link
      ON link.account_id=NEW.account_id AND link.target_store_id=NEW.store_id
     AND link.warehouse_validation_evidence_id IS NOT NULL
    JOIN auto_listing_listing_bases AS listing_base
      ON listing_base.account_id=link.account_id AND listing_base.id=link.listing_base_id
    JOIN auto_listing_upload_attempts AS attempt
      ON attempt.account_id=link.account_id AND attempt.submission_link_id=link.id
     AND attempt.job_id=link.job_id AND attempt.auto_listing_item_id=link.auto_listing_item_id
     AND attempt.target_store_id=link.target_store_id AND attempt.outcome='RESERVED'
    JOIN auto_listing_rfbs_warehouse_evidence AS identity_evidence
      ON identity_evidence.account_id=link.account_id
     AND identity_evidence.id=link.warehouse_validation_evidence_id
     AND identity_evidence.store_id=link.target_store_id
     AND identity_evidence.fulfillment_type='RFBS' AND identity_evidence.outcome='PASSED'
    JOIN auto_listing_rfbs_warehouse_evidence AS attempt_evidence
      ON attempt_evidence.account_id=link.account_id
     AND attempt_evidence.id=attempt.warehouse_validation_evidence_id
     AND attempt_evidence.store_id=link.target_store_id
     AND attempt_evidence.warehouse_record_id=attempt.target_warehouse_id
     AND attempt_evidence.platform_warehouse_id=identity_evidence.platform_warehouse_id
     AND attempt_evidence.fulfillment_type='RFBS' AND attempt_evidence.outcome='PASSED'
   WHERE snapshot.account_id=NEW.account_id AND snapshot.id=NEW.snapshot_id
     AND snapshot.store_id=NEW.store_id
     AND ((link.submission_job_id=NEW.id AND link.submission_snapshot_id=NEW.snapshot_id)
       OR (link.submission_job_id IS NULL AND link.submission_snapshot_id IS NULL
         AND listing_base.collect_item_id=NEW.collect_item_id))
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot.stocks) AS stock
        WHERE stock->>'warehouse_id'=attempt_evidence.platform_warehouse_id
     );
  IF FOUND THEN
    RAISE EXCEPTION 'AUTO_LISTING RFBS lineage requires an exact handoff'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM submission_snapshots AS snapshot
   WHERE snapshot.account_id=NEW.account_id AND snapshot.id=NEW.snapshot_id
     AND snapshot.store_id=NEW.store_id AND jsonb_array_length(snapshot.stocks)>0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot.stocks) AS stock
       LEFT JOIN warehouses AS warehouse
         ON warehouse.store_id=NEW.store_id AND warehouse.warehouse_id=stock->>'warehouse_id'
       WHERE warehouse.id IS NULL OR UPPER(BTRIM(warehouse.warehouse_type))<>'FBS'
          OR LOWER(BTRIM(warehouse.status)) IN
            ('disabled','inactive','archived','deleted','blocked')
          OR warehouse.is_active IS NOT TRUE OR warehouse.is_archived IS NOT FALSE
     );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTO_LISTING job requires an RFBS handoff or exact FBS snapshot'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER submission_jobs_rfbs_handoff_commit_gate
AFTER INSERT ON submission_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_submission_job_rfbs_handoff_at_commit();

CREATE TABLE IF NOT EXISTS submission_rfbs_write_authorizations (
  id TEXT PRIMARY KEY CHECK (
    NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id) <= 240
  ),
  handoff_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  local_warehouse_id TEXT NOT NULL,
  platform_warehouse_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('PRE_IMPORT','PRE_STOCK')),
  warehouse_validation_evidence_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id) <= 240
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP(),
  UNIQUE (account_id,id),
  FOREIGN KEY (account_id,handoff_id)
    REFERENCES submission_rfbs_handoffs(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id,store_id)
    REFERENCES submission_jobs(account_id,id,snapshot_id,store_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,warehouse_validation_evidence_id)
    REFERENCES auto_listing_rfbs_warehouse_evidence(account_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id,local_warehouse_id,platform_warehouse_id)
    REFERENCES warehouses(store_id,id,warehouse_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS submission_rfbs_write_authorizations_phase_idx
  ON submission_rfbs_write_authorizations(
    account_id,submission_job_id,phase,created_at DESC
  );

CREATE OR REPLACE FUNCTION validate_submission_rfbs_write_authorization()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM submission_rfbs_handoffs AS handoff
    JOIN auto_listing_rfbs_warehouse_evidence AS evidence
      ON evidence.account_id=handoff.account_id
     AND evidence.id=NEW.warehouse_validation_evidence_id
     AND evidence.store_id=handoff.store_id
     AND evidence.warehouse_record_id=handoff.local_warehouse_id
     AND evidence.platform_warehouse_id=handoff.platform_warehouse_id
     AND evidence.fulfillment_type='RFBS' AND evidence.status='ACTIVE'
     AND evidence.outcome='PASSED' AND evidence.expires_at>STATEMENT_TIMESTAMP()
   WHERE handoff.account_id=NEW.account_id
     AND handoff.id=NEW.handoff_id
     AND handoff.submission_job_id=NEW.submission_job_id
     AND handoff.submission_snapshot_id=NEW.submission_snapshot_id
     AND handoff.store_id=NEW.store_id
     AND handoff.local_warehouse_id=NEW.local_warehouse_id
     AND handoff.platform_warehouse_id=NEW.platform_warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid RFBS write-phase authorization' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_rfbs_write_authorizations_insert_guard
BEFORE INSERT ON submission_rfbs_write_authorizations
FOR EACH ROW EXECUTE FUNCTION validate_submission_rfbs_write_authorization();

CREATE OR REPLACE FUNCTION reject_submission_rfbs_write_authorization_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
    AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RFBS write-phase authorizations are append-only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER submission_rfbs_write_authorizations_append_only
BEFORE UPDATE OR DELETE ON submission_rfbs_write_authorizations
FOR EACH ROW EXECUTE FUNCTION reject_submission_rfbs_write_authorization_mutation();
