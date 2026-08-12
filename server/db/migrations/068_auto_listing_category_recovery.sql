-- Tenant-scoped, one-shot category recovery evidence and state.
-- Raw Ozon responses and credentials never belong in these tables.

CREATE UNIQUE INDEX submission_snapshots_account_id_id_key
  ON submission_snapshots(account_id,id);
CREATE UNIQUE INDEX submission_jobs_account_id_id_snapshot_id_key
  ON submission_jobs(account_id,id,snapshot_id);
CREATE UNIQUE INDEX submission_items_job_snapshot_id_offer_key
  ON submission_items(job_id,snapshot_id,id,offer_id);

CREATE OR REPLACE FUNCTION guard_submission_snapshot_category_recovery_basis()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.items IS DISTINCT FROM OLD.items OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash THEN
    RAISE EXCEPTION 'submission snapshot recovery basis is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_snapshot_category_recovery_basis
BEFORE UPDATE OF items,snapshot_hash ON submission_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_submission_snapshot_category_recovery_basis();

CREATE TABLE submission_category_error_evidence (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND LENGTH(id) <= 240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  submission_item_id TEXT NOT NULL,
  offer_id TEXT NOT NULL CHECK (NULLIF(BTRIM(offer_id),'') IS NOT NULL AND LENGTH(offer_id) <= 240),
  original_ozon_task_id TEXT NOT NULL
    CHECK (NULLIF(BTRIM(original_ozon_task_id),'') IS NOT NULL AND LENGTH(original_ozon_task_id) <= 240),
  original_snapshot_hash TEXT NOT NULL CHECK (original_snapshot_hash ~ '^[0-9a-f]{64}$'),
  original_items JSONB NOT NULL CHECK (
    jsonb_typeof(original_items)='array' AND jsonb_array_length(original_items) BETWEEN 1 AND 100
    AND OCTET_LENGTH(original_items::TEXT) <= 2097152
  ),
  source_evidence_id TEXT NOT NULL,
  old_shared_category_id TEXT NOT NULL,
  old_shared_category_version INTEGER NOT NULL CHECK (old_shared_category_version > 0),
  classifier_policy_version TEXT NOT NULL
    CHECK (classifier_policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  safe_evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() CHECK (ISFINITE(created_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,submission_job_id,submission_item_id),
  UNIQUE (account_id,id,submission_job_id,submission_snapshot_id,original_ozon_task_id),
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id)
    REFERENCES submission_jobs(account_id,id,snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,submission_snapshot_id)
    REFERENCES submission_snapshots(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (submission_job_id,submission_snapshot_id,submission_item_id,offer_id)
    REFERENCES submission_items(job_id,snapshot_id,id,offer_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,source_evidence_id)
    REFERENCES collect_ozon_category_source_evidence(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,old_shared_category_id)
    REFERENCES account_ozon_shared_categories(account_id,id) ON DELETE CASCADE,
  CHECK (
    jsonb_typeof(safe_evidence)='object'
    AND OCTET_LENGTH(safe_evidence::TEXT) <= 4096
    AND safe_evidence ?& ARRAY[
      'schemaVersion','policyVersion','errorCode','field','attributeId',
      'state','offerId','productId','classification'
    ]
    AND safe_evidence - ARRAY[
      'schemaVersion','policyVersion','errorCode','field','attributeId',
      'state','offerId','productId','classification'
    ] = '{}'::JSONB
    AND safe_evidence->>'schemaVersion'='OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1'
    AND safe_evidence->>'policyVersion'=classifier_policy_version
    AND safe_evidence->>'classification'='EXPLICIT_CATEGORY_FAILURE'
    AND safe_evidence->>'state'='FAILED'
    AND safe_evidence->>'offerId'=offer_id
    AND safe_evidence->'productId'='null'::JSONB
    AND safe_evidence->>'errorCode' ~ '^[A-Z][A-Z0-9_]{0,119}$'
    AND safe_evidence->>'field' ~ '^[A-Za-z0-9_.-]{1,240}$'
    AND (
      safe_evidence->'attributeId'='null'::JSONB
      OR (
        jsonb_typeof(safe_evidence->'attributeId')='number'
        AND (safe_evidence->>'attributeId') ~ '^[1-9][0-9]*$'
        AND (safe_evidence->>'attributeId')::NUMERIC <= 9007199254740991::NUMERIC
      )
    )
  )
);

CREATE INDEX submission_category_error_evidence_job_read_idx
  ON submission_category_error_evidence(account_id,submission_job_id,created_at,id);

CREATE TABLE submission_category_recovery_attempts (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND LENGTH(id) <= 240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  triggering_error_evidence_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  old_shared_category_id TEXT NOT NULL,
  old_shared_category_version INTEGER NOT NULL CHECK (old_shared_category_version > 0),
  original_ozon_task_id TEXT NOT NULL
    CHECK (NULLIF(BTRIM(original_ozon_task_id),'') IS NOT NULL AND LENGTH(original_ozon_task_id) <= 240),
  original_snapshot_hash TEXT NOT NULL CHECK (original_snapshot_hash ~ '^[0-9a-f]{64}$'),
  corrected_items JSONB,
  corrected_items_hash TEXT CHECK (corrected_items_hash IS NULL OR corrected_items_hash ~ '^[0-9a-f]{64}$'),
  replacement_shared_category_id TEXT,
  replacement_shared_category_version INTEGER
    CHECK (replacement_shared_category_version IS NULL OR replacement_shared_category_version > 0),
  retry_ozon_task_id TEXT
    CHECK (retry_ozon_task_id IS NULL OR (NULLIF(BTRIM(retry_ozon_task_id),'') IS NOT NULL
      AND LENGTH(retry_ozon_task_id) <= 240)),
  status TEXT NOT NULL CHECK (status IN (
    'CLAIMED','MATCHED','RETRY_PENDING','RETRY_ACCEPTED','SUCCEEDED','NEEDS_REVIEW'
  )),
  safe_review_code TEXT NOT NULL DEFAULT ''
    CHECK (safe_review_code='' OR safe_review_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  correlation_id TEXT NOT NULL
    CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND LENGTH(correlation_id) <= 240),
  claimed_at TIMESTAMPTZ NOT NULL CHECK (ISFINITE(claimed_at)),
  updated_at TIMESTAMPTZ NOT NULL CHECK (ISFINITE(updated_at)),
  completed_at TIMESTAMPTZ CHECK (completed_at IS NULL OR ISFINITE(completed_at)),
  UNIQUE (account_id,id),
  UNIQUE (account_id,submission_job_id),
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id)
    REFERENCES submission_jobs(account_id,id,snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,triggering_error_evidence_id,submission_job_id,submission_snapshot_id,original_ozon_task_id)
    REFERENCES submission_category_error_evidence(
      account_id,id,submission_job_id,submission_snapshot_id,original_ozon_task_id
    ) ON DELETE CASCADE,
  FOREIGN KEY (account_id,source_evidence_id)
    REFERENCES collect_ozon_category_source_evidence(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,old_shared_category_id)
    REFERENCES account_ozon_shared_categories(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,replacement_shared_category_id)
    REFERENCES account_ozon_shared_categories(account_id,id) ON DELETE CASCADE,
  CHECK (
    (corrected_items IS NULL AND corrected_items_hash IS NULL
      AND replacement_shared_category_id IS NULL AND replacement_shared_category_version IS NULL)
    OR
    (jsonb_typeof(corrected_items)='array' AND jsonb_array_length(corrected_items) BETWEEN 1 AND 100
      AND OCTET_LENGTH(corrected_items::TEXT) <= 2097152
      AND corrected_items_hash IS NOT NULL
      AND replacement_shared_category_id IS NOT NULL
      AND replacement_shared_category_version > old_shared_category_version)
  ),
  CHECK (
    (status='CLAIMED' AND corrected_items IS NULL AND retry_ozon_task_id IS NULL
      AND safe_review_code='' AND completed_at IS NULL)
    OR
    (status IN ('MATCHED','RETRY_PENDING') AND corrected_items IS NOT NULL
      AND retry_ozon_task_id IS NULL AND safe_review_code='' AND completed_at IS NULL)
    OR
    (status='RETRY_ACCEPTED' AND corrected_items IS NOT NULL
      AND retry_ozon_task_id IS NOT NULL AND safe_review_code='' AND completed_at IS NULL)
    OR
    (status='SUCCEEDED' AND corrected_items IS NOT NULL
      AND retry_ozon_task_id IS NOT NULL AND safe_review_code='' AND completed_at IS NOT NULL)
    OR
    (status='NEEDS_REVIEW' AND corrected_items IS NULL AND corrected_items_hash IS NULL
      AND replacement_shared_category_id IS NULL AND replacement_shared_category_version IS NULL
      AND retry_ozon_task_id IS NULL AND NULLIF(BTRIM(safe_review_code),'') IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX submission_category_recovery_attempts_read_idx
  ON submission_category_recovery_attempts(account_id,status,updated_at,id);

CREATE OR REPLACE FUNCTION verify_submission_category_error_evidence_basis()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM submission_jobs AS job
      JOIN submission_snapshots AS snapshot
        ON snapshot.account_id=job.account_id AND snapshot.id=job.snapshot_id
      JOIN submission_items AS item
        ON item.job_id=job.id AND item.snapshot_id=job.snapshot_id
       AND item.id=NEW.submission_item_id AND item.offer_id=NEW.offer_id
      JOIN collect_ozon_category_source_evidence AS source
        ON source.account_id=job.account_id AND source.id=NEW.source_evidence_id
      JOIN account_ozon_shared_categories AS shared
        ON shared.account_id=job.account_id AND shared.id=NEW.old_shared_category_id
       AND shared.source_evidence_id=source.id
     WHERE job.account_id=NEW.account_id AND job.id=NEW.submission_job_id
       AND job.snapshot_id=NEW.submission_snapshot_id
       AND job.ozon_task_id=NEW.original_ozon_task_id
       AND job.status='FAILED'
       AND snapshot.snapshot_hash=NEW.original_snapshot_hash
       AND snapshot.items=NEW.original_items
       AND item.status='FAILED'
       AND NULLIF(BTRIM(item.product_id),'') IS NULL
       AND item.response->'errorEvidence'=NEW.safe_evidence
       AND shared.version=NEW.old_shared_category_version
       AND shared.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'submission category evidence basis is not the exact current terminal failure'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_category_error_evidence_basis
BEFORE INSERT ON submission_category_error_evidence
FOR EACH ROW EXECUTE FUNCTION verify_submission_category_error_evidence_basis();

CREATE OR REPLACE FUNCTION reject_submission_category_error_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (SELECT 1 FROM submission_jobs WHERE account_id=OLD.account_id AND id=OLD.submission_job_id)
    OR NOT EXISTS (SELECT 1 FROM submission_items WHERE job_id=OLD.submission_job_id AND id=OLD.submission_item_id)
    OR NOT EXISTS (SELECT 1 FROM collect_ozon_category_source_evidence
      WHERE account_id=OLD.account_id AND id=OLD.source_evidence_id)
    OR NOT EXISTS (SELECT 1 FROM account_ozon_shared_categories
      WHERE account_id=OLD.account_id AND id=OLD.old_shared_category_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'submission category error evidence is append only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER submission_category_error_evidence_append_only
BEFORE UPDATE OR DELETE ON submission_category_error_evidence
FOR EACH ROW EXECUTE FUNCTION reject_submission_category_error_evidence_mutation();

CREATE OR REPLACE FUNCTION guard_submission_category_recovery_attempt_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'CLAIMED'
    OR NEW.corrected_items IS NOT NULL
    OR NEW.corrected_items_hash IS NOT NULL
    OR NEW.replacement_shared_category_id IS NOT NULL
    OR NEW.replacement_shared_category_version IS NOT NULL
    OR NEW.retry_ozon_task_id IS NOT NULL
    OR NEW.safe_review_code<>''
    OR NEW.completed_at IS NOT NULL
    OR NEW.updated_at IS DISTINCT FROM NEW.claimed_at
    OR NOT EXISTS (
      SELECT 1 FROM submission_category_error_evidence AS evidence
       WHERE evidence.account_id=NEW.account_id
         AND evidence.submission_job_id=NEW.submission_job_id
         AND evidence.submission_snapshot_id=NEW.submission_snapshot_id
         AND evidence.id=NEW.triggering_error_evidence_id
         AND evidence.source_evidence_id=NEW.source_evidence_id
         AND evidence.old_shared_category_id=NEW.old_shared_category_id
         AND evidence.old_shared_category_version=NEW.old_shared_category_version
         AND evidence.original_ozon_task_id=NEW.original_ozon_task_id
         AND evidence.original_snapshot_hash=NEW.original_snapshot_hash
    )
  THEN
    RAISE EXCEPTION 'invalid initial submission category recovery attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_category_recovery_attempt_insert
BEFORE INSERT ON submission_category_recovery_attempts
FOR EACH ROW EXECUTE FUNCTION guard_submission_category_recovery_attempt_insert();

CREATE OR REPLACE FUNCTION canonical_submission_category_recovery_json(value JSONB)
RETURNS TEXT LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN COALESCE((
      SELECT '{' || STRING_AGG(TO_JSONB(entry.key)::TEXT || ':'
        || canonical_submission_category_recovery_json(entry.value), ',' ORDER BY entry.key) || '}'
        FROM JSONB_EACH(value) AS entry
    ), '{}')
    WHEN 'array' THEN COALESCE((
      SELECT '[' || STRING_AGG(canonical_submission_category_recovery_json(entry.value), ','
        ORDER BY entry.ordinality) || ']'
        FROM JSONB_ARRAY_ELEMENTS(value) WITH ORDINALITY AS entry(value,ordinality)
    ), '[]')
    ELSE value::TEXT
  END;
$$;

CREATE OR REPLACE FUNCTION guard_submission_category_recovery_attempt_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  triggering_evidence submission_category_error_evidence%ROWTYPE;
  replacement account_ozon_shared_categories%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (SELECT 1 FROM submission_jobs WHERE account_id=OLD.account_id AND id=OLD.submission_job_id)
    OR NOT EXISTS (
      SELECT 1 FROM submission_category_error_evidence
       WHERE account_id=OLD.account_id AND id=OLD.triggering_error_evidence_id
    )
    OR NOT EXISTS (SELECT 1 FROM collect_ozon_category_source_evidence
      WHERE account_id=OLD.account_id AND id=OLD.source_evidence_id)
    OR NOT EXISTS (SELECT 1 FROM account_ozon_shared_categories
      WHERE account_id=OLD.account_id AND id=OLD.old_shared_category_id)
    OR (OLD.replacement_shared_category_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM account_ozon_shared_categories
       WHERE account_id=OLD.account_id AND id=OLD.replacement_shared_category_id
    ))
  ) THEN
    RETURN OLD;
  END IF;
  IF OLD.status='CLAIMED' AND NEW.status='MATCHED' THEN
    SELECT * INTO triggering_evidence
      FROM submission_category_error_evidence
     WHERE account_id=OLD.account_id AND id=OLD.triggering_error_evidence_id;
    SELECT * INTO replacement
      FROM account_ozon_shared_categories
     WHERE account_id=OLD.account_id AND id=NEW.replacement_shared_category_id
       AND version=NEW.replacement_shared_category_version AND status='ACTIVE'
       AND source_evidence_id=OLD.source_evidence_id;
    IF triggering_evidence.id IS NULL OR replacement.id IS NULL
      OR NEW.corrected_items_hash IS DISTINCT FROM ENCODE(SHA256(CONVERT_TO(
        canonical_submission_category_recovery_json(NEW.corrected_items),'UTF8')), 'hex')
      OR JSONB_ARRAY_LENGTH(NEW.corrected_items) <> JSONB_ARRAY_LENGTH(triggering_evidence.original_items)
      OR EXISTS (
        SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(triggering_evidence.original_items) WITH ORDINALITY AS original_item(value,ordinality)
          FULL JOIN JSONB_ARRAY_ELEMENTS(NEW.corrected_items) WITH ORDINALITY AS corrected_item(value,ordinality)
            USING (ordinality)
         WHERE JSONB_TYPEOF(original_item.value)<>'object'
            OR JSONB_TYPEOF(corrected_item.value)<>'object'
            OR original_item.value - ARRAY[
              'description_category_id','descriptionCategoryId','type_id','typeId','attributes'
            ] IS DISTINCT FROM corrected_item.value - ARRAY[
              'description_category_id','descriptionCategoryId','type_id','typeId','attributes'
            ]
            OR JSONB_TYPEOF(corrected_item.value->'description_category_id')<>'number'
            OR NOT ((corrected_item.value->>'description_category_id') ~ '^[1-9][0-9]*$')
            OR (corrected_item.value->>'description_category_id')::NUMERIC
              <> replacement.current_description_category_id
            OR JSONB_TYPEOF(corrected_item.value->'type_id')<>'number'
            OR NOT ((corrected_item.value->>'type_id') ~ '^[1-9][0-9]*$')
            OR (corrected_item.value->>'type_id')::NUMERIC <> replacement.current_type_id
            OR JSONB_TYPEOF(corrected_item.value->'attributes')<>'array'
      )
    THEN
      RAISE EXCEPTION 'invalid matched submission category recovery correction'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP='DELETE'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.submission_job_id IS DISTINCT FROM OLD.submission_job_id
    OR NEW.submission_snapshot_id IS DISTINCT FROM OLD.submission_snapshot_id
    OR NEW.triggering_error_evidence_id IS DISTINCT FROM OLD.triggering_error_evidence_id
    OR NEW.source_evidence_id IS DISTINCT FROM OLD.source_evidence_id
    OR NEW.old_shared_category_id IS DISTINCT FROM OLD.old_shared_category_id
    OR NEW.old_shared_category_version IS DISTINCT FROM OLD.old_shared_category_version
    OR NEW.original_ozon_task_id IS DISTINCT FROM OLD.original_ozon_task_id
    OR NEW.original_snapshot_hash IS DISTINCT FROM OLD.original_snapshot_hash
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.updated_at <= OLD.updated_at
    OR (NEW.status<>'NEEDS_REVIEW' AND OLD.corrected_items IS NOT NULL
      AND NEW.corrected_items IS DISTINCT FROM OLD.corrected_items)
    OR (NEW.status<>'NEEDS_REVIEW' AND OLD.corrected_items_hash IS NOT NULL
      AND NEW.corrected_items_hash IS DISTINCT FROM OLD.corrected_items_hash)
    OR (OLD.replacement_shared_category_id IS NOT NULL
      AND NEW.status<>'NEEDS_REVIEW'
      AND NEW.replacement_shared_category_id IS DISTINCT FROM OLD.replacement_shared_category_id)
    OR (OLD.replacement_shared_category_version IS NOT NULL
      AND NEW.status<>'NEEDS_REVIEW'
      AND NEW.replacement_shared_category_version IS DISTINCT FROM OLD.replacement_shared_category_version)
    OR (OLD.retry_ozon_task_id IS NOT NULL AND NEW.status<>'NEEDS_REVIEW'
      AND NEW.retry_ozon_task_id IS DISTINCT FROM OLD.retry_ozon_task_id)
    OR (OLD.retry_ozon_task_id IS NULL AND NEW.retry_ozon_task_id IS NOT NULL
      AND NEW.status<>'RETRY_ACCEPTED')
    OR (OLD.status='CLAIMED' AND NEW.status='NEEDS_REVIEW' AND (
      NEW.corrected_items IS NOT NULL
      OR NEW.corrected_items_hash IS NOT NULL
      OR NEW.replacement_shared_category_id IS NOT NULL
      OR NEW.replacement_shared_category_version IS NOT NULL
    ))
    OR NOT (
      (OLD.status='CLAIMED' AND NEW.status IN ('MATCHED','NEEDS_REVIEW'))
      OR (OLD.status='MATCHED' AND NEW.status IN ('RETRY_PENDING','NEEDS_REVIEW'))
      OR (OLD.status='RETRY_PENDING' AND NEW.status IN ('RETRY_ACCEPTED','NEEDS_REVIEW'))
      OR (OLD.status='RETRY_ACCEPTED' AND NEW.status IN ('SUCCEEDED','NEEDS_REVIEW'))
    )
  THEN
    RAISE EXCEPTION 'invalid submission category recovery attempt transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_category_recovery_attempt_transition
BEFORE UPDATE OR DELETE ON submission_category_recovery_attempts
FOR EACH ROW EXECUTE FUNCTION guard_submission_category_recovery_attempt_transition();
