-- Preserve the original Task 6 submission-item failure as immutable recovery provenance.
-- A category retry records its terminal item results as children of the sole recovery attempt.

ALTER TABLE submission_category_recovery_attempts
  ADD CONSTRAINT submission_category_recovery_attempts_retry_identity_key
  UNIQUE (account_id,submission_job_id,submission_snapshot_id,id,retry_ozon_task_id);

CREATE TABLE submission_category_recovery_item_results (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND LENGTH(id) <= 240),
  account_id TEXT NOT NULL,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  recovery_attempt_id TEXT NOT NULL,
  retry_ozon_task_id TEXT NOT NULL
    CHECK (NULLIF(BTRIM(retry_ozon_task_id),'') IS NOT NULL AND LENGTH(retry_ozon_task_id) <= 240),
  submission_item_id TEXT NOT NULL,
  offer_id TEXT NOT NULL CHECK (NULLIF(BTRIM(offer_id),'') IS NOT NULL AND LENGTH(offer_id) <= 240),
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','SKIPPED')),
  product_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW() CHECK (ISFINITE(created_at)),
  UNIQUE (
    account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id,
    retry_ozon_task_id,submission_item_id,offer_id
  ),
  FOREIGN KEY (
    account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id,retry_ozon_task_id
  ) REFERENCES submission_category_recovery_attempts(
    account_id,submission_job_id,submission_snapshot_id,id,retry_ozon_task_id
  ) ON DELETE CASCADE,
  FOREIGN KEY (submission_job_id,submission_snapshot_id,submission_item_id,offer_id)
    REFERENCES submission_items(job_id,snapshot_id,id,offer_id) ON DELETE CASCADE,
  CHECK (
    (status='SUCCEEDED' AND CASE
      WHEN product_id ~ '^[1-9][0-9]{0,15}$'
        THEN product_id::NUMERIC <= 9007199254740991::NUMERIC
      ELSE FALSE
    END)
    OR (status IN ('FAILED','SKIPPED') AND product_id IS NULL)
  )
);

CREATE INDEX submission_category_recovery_item_results_read_idx
  ON submission_category_recovery_item_results(
    account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id,retry_ozon_task_id
  );

CREATE OR REPLACE FUNCTION guard_submission_category_recovery_item_result()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM submission_category_recovery_attempts
      WHERE account_id=OLD.account_id AND id=OLD.recovery_attempt_id)
    OR NOT EXISTS (SELECT 1 FROM submission_items
      WHERE job_id=OLD.submission_job_id AND snapshot_id=OLD.submission_snapshot_id
        AND id=OLD.submission_item_id AND offer_id=OLD.offer_id)
  ) THEN
    RETURN OLD;
  END IF;
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'submission category recovery item results are append only'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM submission_category_recovery_attempts AS attempt
      JOIN submission_jobs AS job
        ON job.account_id=attempt.account_id AND job.id=attempt.submission_job_id
       AND job.snapshot_id=attempt.submission_snapshot_id
      JOIN submission_items AS original_item
        ON original_item.job_id=attempt.submission_job_id
       AND original_item.snapshot_id=attempt.submission_snapshot_id
       AND original_item.id=NEW.submission_item_id AND original_item.offer_id=NEW.offer_id
     WHERE attempt.account_id=NEW.account_id
       AND attempt.submission_job_id=NEW.submission_job_id
       AND attempt.submission_snapshot_id=NEW.submission_snapshot_id
       AND attempt.id=NEW.recovery_attempt_id
       AND attempt.status='RETRY_ACCEPTED'
       AND attempt.retry_ozon_task_id=NEW.retry_ozon_task_id
       AND job.status='CHECKING' AND job.ozon_task_id=NEW.retry_ozon_task_id
       AND original_item.status='FAILED'
       AND NULLIF(BTRIM(original_item.product_id),'') IS NULL
       AND original_item.response->'errorEvidence' IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM JSONB_ARRAY_ELEMENTS(attempt.corrected_items) AS corrected(value)
          WHERE COALESCE(corrected.value->>'offer_id',corrected.value->>'offerId')=NEW.offer_id
       )
     FOR UPDATE OF attempt,job,original_item
  ) THEN
    RAISE EXCEPTION 'submission category recovery item result identity is not eligible'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_category_recovery_item_result_guard
BEFORE INSERT OR UPDATE OR DELETE ON submission_category_recovery_item_results
FOR EACH ROW EXECUTE FUNCTION guard_submission_category_recovery_item_result();

CREATE OR REPLACE FUNCTION require_submission_category_recovery_terminal_results()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  expected_count BIGINT;
  result_count BIGINT;
  success_count BIGINT;
BEGIN
  IF OLD.status='RETRY_ACCEPTED' AND NEW.status IN ('SUCCEEDED','NEEDS_REVIEW') THEN
    SELECT COUNT(*) INTO expected_count
      FROM submission_items AS original_item
     WHERE original_item.job_id=OLD.submission_job_id
       AND original_item.snapshot_id=OLD.submission_snapshot_id;
    SELECT COUNT(*),COUNT(*) FILTER (WHERE child.status='SUCCEEDED')
      INTO result_count,success_count
      FROM submission_category_recovery_item_results AS child
     WHERE child.account_id=OLD.account_id
       AND child.submission_job_id=OLD.submission_job_id
       AND child.submission_snapshot_id=OLD.submission_snapshot_id
       AND child.recovery_attempt_id=OLD.id
       AND child.retry_ozon_task_id=OLD.retry_ozon_task_id;
    IF expected_count<1 OR result_count<>expected_count
      OR (NEW.status='SUCCEEDED' AND success_count<>expected_count)
      OR (NEW.status='NEEDS_REVIEW' AND success_count=expected_count)
    THEN
      RAISE EXCEPTION 'submission category recovery terminal result set is incomplete or inconsistent'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_category_recovery_attempt_result_gate
BEFORE UPDATE ON submission_category_recovery_attempts
FOR EACH ROW EXECUTE FUNCTION require_submission_category_recovery_terminal_results();
