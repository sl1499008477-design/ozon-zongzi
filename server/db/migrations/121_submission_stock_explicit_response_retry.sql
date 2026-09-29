-- Explicit response receipts reuse the job summary and append-only journal events.
-- No inferred response (timeout/missing/contradictory item) permits a resend.
DO $$ DECLARE constraint_row RECORD; BEGIN
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid='submission_stock_write_intents'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP EXECUTE FORMAT('ALTER TABLE submission_stock_write_intents DROP CONSTRAINT %I',constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid='submission_stock_write_events'::regclass AND contype='c'
      AND (pg_get_constraintdef(oid) LIKE '%status%' OR pg_get_constraintdef(oid) LIKE '%event_type%')
  LOOP EXECUTE FORMAT('ALTER TABLE submission_stock_write_events DROP CONSTRAINT %I',constraint_row.conname); END LOOP;
END $$;
ALTER TABLE submission_stock_write_intents ADD CONSTRAINT stock_write_state_v121 CHECK (
  (status='PREPARED' AND in_flight_at IS NULL AND done_at IS NULL AND ambiguous_at IS NULL AND failure_code='')
  OR (status='IN_FLIGHT' AND in_flight_at IS NOT NULL AND done_at IS NULL AND ambiguous_at IS NULL AND failure_code='')
  OR (status IN ('DONE','RESOLVED') AND in_flight_at IS NOT NULL AND done_at IS NOT NULL AND ambiguous_at IS NULL AND failure_code='')
  OR (status='AMBIGUOUS' AND in_flight_at IS NOT NULL AND done_at IS NULL AND ambiguous_at IS NOT NULL AND NULLIF(BTRIM(failure_code),'') IS NOT NULL)
);
ALTER TABLE submission_stock_write_events ADD CONSTRAINT stock_write_event_state_v121 CHECK (
  from_status IN ('','PREPARED','IN_FLIGHT','DONE','AMBIGUOUS','RESOLVED')
  AND to_status IN ('PREPARED','IN_FLIGHT','DONE','AMBIGUOUS','RESOLVED')
  AND event_type IN ('submission.stock_write_prepared','submission.stock_write_started','submission.stock_write_done','submission.stock_write_ambiguous','submission.stock_write_resolved')
);

CREATE OR REPLACE FUNCTION validate_submission_stock_write_intent()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  stock_item JSONB;
  canonical_request TEXT;
  expected_count INTEGER;
  receipt JSONB;
  result_item JSONB;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(
      NEW.id,NEW.account_id,NEW.submission_job_id,NEW.submission_snapshot_id,NEW.store_id,
      NEW.import_ozon_task_id,NEW.recovery_attempt_id,NEW.request_hash,NEW.correlation_id,
      NEW.stock_items,NEW.item_count,NEW.prepared_at
    ) IS DISTINCT FROM ROW(
      OLD.id,OLD.account_id,OLD.submission_job_id,OLD.submission_snapshot_id,OLD.store_id,
      OLD.import_ozon_task_id,OLD.recovery_attempt_id,OLD.request_hash,OLD.correlation_id,
      OLD.stock_items,OLD.item_count,OLD.prepared_at
    ) THEN
      RAISE EXCEPTION 'stock write intent identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT (
      (OLD.status='PREPARED' AND NEW.status='IN_FLIGHT')
      OR (OLD.status='IN_FLIGHT' AND NEW.status IN ('DONE','AMBIGUOUS','RESOLVED'))
      OR (OLD.status='RESOLVED' AND NEW.status='PREPARED')
    ) THEN
      RAISE EXCEPTION 'stock write intent transition is not allowed' USING ERRCODE='23514';
    END IF;
    -- Finishing an already sent legacy request must remain possible. A new
    -- send rechecks the current successful import evidence below.
    IF NEW.status='RESOLVED' THEN
      SELECT JSONB_AGG(result.value) INTO receipt
        FROM submission_jobs AS job,
          JSONB_ARRAY_ELEMENTS(job.result_summary->'stockResults') AS result(value)
        WHERE job.account_id=NEW.account_id AND job.id=NEW.submission_job_id
          AND EXISTS (SELECT 1 FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items) AS item(value)
            WHERE item.value->>'offerId'=result.value->>'offerId'
              AND item.value->>'warehouseId'=result.value->>'warehouseId');
      IF receipt IS NULL OR JSONB_ARRAY_LENGTH(receipt)<>NEW.item_count
        OR (SELECT COUNT(DISTINCT (value->>'offerId',value->>'warehouseId'))
          FROM JSONB_ARRAY_ELEMENTS(receipt))<>NEW.item_count THEN
        RAISE EXCEPTION 'stock receipt must cover the exact request once' USING ERRCODE='23514';
      END IF;
      FOR result_item IN SELECT value FROM JSONB_ARRAY_ELEMENTS(receipt) LOOP
        IF COALESCE(JSONB_TYPEOF(result_item->'errors'),'')<>'array'
          OR COALESCE(result_item->>'status','') NOT IN ('SUCCEEDED','FAILED','RETRYABLE','UNKNOWN') THEN
          RAISE EXCEPTION 'stock receipt result is invalid' USING ERRCODE='23514';
        END IF;
        IF (result_item->>'status'='SUCCEEDED' AND
            (result_item->'updated' IS DISTINCT FROM 'true'::jsonb OR JSONB_ARRAY_LENGTH(result_item->'errors')<>0))
          OR (result_item->>'status' IN ('FAILED','RETRYABLE') AND result_item->'updated' IS DISTINCT FROM 'false'::jsonb)
          OR (result_item->>'status'='RETRYABLE' AND
            (JSONB_ARRAY_LENGTH(result_item->'errors')=0 OR EXISTS (
              SELECT 1 FROM JSONB_ARRAY_ELEMENTS_TEXT(result_item->'errors') AS error(code)
               WHERE code IS NULL OR code NOT IN ('PRODUCT_HAS_NOT_BEEN_TAGGED_YET','TOO_MANY_REQUESTS')))) THEN
          RAISE EXCEPTION 'stock receipt has no explicit result evidence' USING ERRCODE='23514';
        END IF;
      END LOOP;
      RETURN NEW;
    END IF;
    IF OLD.status='RESOLVED' THEN
      SELECT payload->'stockResults' INTO receipt FROM submission_stock_write_events
        WHERE account_id=OLD.account_id AND stock_write_intent_id=OLD.id AND to_status='RESOLVED'
        ORDER BY id DESC LIMIT 1;
      IF receipt IS NULL OR JSONB_ARRAY_LENGTH(receipt)<>OLD.item_count OR EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(receipt)
         WHERE value->>'status' IS DISTINCT FROM 'RETRYABLE'
      ) THEN
        RAISE EXCEPTION 'only an entirely explicit retryable receipt may be prepared again' USING ERRCODE='23514';
      END IF;
    END IF;
    IF OLD.status='IN_FLIGHT' THEN RETURN NEW; END IF;
  END IF;

  IF (TG_OP='INSERT' AND NEW.status<>'PREPARED')
    OR NEW.item_count<>JSONB_ARRAY_LENGTH(NEW.stock_items)
    OR NEW.item_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'stock write intent must start as one complete prepared generation' USING ERRCODE='23514';
  END IF;
  FOR stock_item IN SELECT value FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items)
  LOOP
    IF JSONB_TYPEOF(stock_item)<>'object'
      OR (SELECT COUNT(*) FROM JSONB_OBJECT_KEYS(stock_item))<>4
      OR NOT (stock_item ?& ARRAY['submissionItemId','offerId','warehouseId','quantity'])
      OR JSONB_TYPEOF(stock_item->'submissionItemId')<>'string'
      OR JSONB_TYPEOF(stock_item->'offerId')<>'string'
      OR JSONB_TYPEOF(stock_item->'warehouseId')<>'string'
      OR JSONB_TYPEOF(stock_item->'quantity')<>'number'
      OR stock_item->>'submissionItemId'<>BTRIM(stock_item->>'submissionItemId')
      OR stock_item->>'offerId'<>BTRIM(stock_item->>'offerId')
      OR stock_item->>'warehouseId'<>BTRIM(stock_item->>'warehouseId')
      OR NULLIF(stock_item->>'submissionItemId','') IS NULL
      OR NULLIF(stock_item->>'offerId','') IS NULL
      OR NULLIF(stock_item->>'warehouseId','') IS NULL
      OR OCTET_LENGTH(stock_item->>'submissionItemId')>240
      OR OCTET_LENGTH(stock_item->>'offerId')>240
      OR OCTET_LENGTH(stock_item->>'warehouseId')>240
      OR stock_item->>'submissionItemId' ~ '[[:cntrl:]]'
      OR stock_item->>'offerId' ~ '[[:cntrl:]]'
      OR stock_item->>'warehouseId' ~ '[[:cntrl:]]'
      OR NOT (stock_item->>'quantity' ~ '^(0|[1-9][0-9]{0,9})$')
      OR (stock_item->>'quantity')::NUMERIC>2147483647
    THEN
      RAISE EXCEPTION 'stock write item contract is invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO expected_count
    FROM (
      SELECT candidate.value->>'submissionItemId' AS item_id,
             candidate.value->>'offerId' AS offer_id
        FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items) AS candidate(value)
       GROUP BY candidate.value->>'submissionItemId',candidate.value->>'offerId'
    ) AS identities;
  IF expected_count<>NEW.item_count THEN
    RAISE EXCEPTION 'stock write item identity is duplicated' USING ERRCODE='23514';
  END IF;

  SELECT STRING_AGG(
    OCTET_LENGTH(candidate.value->>'submissionItemId')::TEXT || ':' ||
      (candidate.value->>'submissionItemId') || ':' ||
    OCTET_LENGTH(candidate.value->>'offerId')::TEXT || ':' ||
      (candidate.value->>'offerId') || ':' ||
    OCTET_LENGTH(candidate.value->>'warehouseId')::TEXT || ':' ||
      (candidate.value->>'warehouseId') || ':' ||
    (candidate.value->>'quantity'),
    '|' ORDER BY candidate.value->>'offerId' COLLATE "C",
      candidate.value->>'submissionItemId' COLLATE "C",candidate.value->>'warehouseId' COLLATE "C"
  ) INTO canonical_request
  FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items) AS candidate(value);
  IF MD5(canonical_request)<>NEW.request_hash THEN
    RAISE EXCEPTION 'stock write request hash is invalid' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM submission_jobs AS job
      JOIN submission_snapshots AS snapshot
        ON snapshot.account_id=job.account_id AND snapshot.id=job.snapshot_id
       AND snapshot.store_id=job.store_id
     WHERE job.account_id=NEW.account_id AND job.id=NEW.submission_job_id
       AND job.snapshot_id=NEW.submission_snapshot_id AND job.store_id=NEW.store_id
       AND job.status IN ('CHECKING','RECONCILING')
       AND job.ozon_task_id=NEW.import_ozon_task_id
       AND job.correlation_id=NEW.correlation_id
       AND NOT EXISTS (
         SELECT 1 FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items) AS candidate(value)
          WHERE NOT EXISTS (
            SELECT 1 FROM submission_items AS item
             WHERE item.job_id=job.id AND item.snapshot_id=job.snapshot_id
               AND item.id=candidate.value->>'submissionItemId'
               AND item.offer_id=candidate.value->>'offerId'
               AND (
                 (NEW.recovery_attempt_id IS NULL AND item.status='SUCCEEDED'
                   AND item.product_id ~ '^[1-9][0-9]{0,15}$')
                 OR EXISTS (
                   SELECT 1 FROM submission_category_recovery_item_results AS child
                    WHERE child.account_id=job.account_id
                      AND child.submission_job_id=job.id
                      AND child.submission_snapshot_id=job.snapshot_id
                      AND child.recovery_attempt_id=NEW.recovery_attempt_id
                      AND child.retry_ozon_task_id=NEW.import_ozon_task_id
                      AND child.submission_item_id=item.id AND child.offer_id=item.offer_id
                      AND child.status='SUCCEEDED' AND child.product_id IS NOT NULL
                 )
               )
          ) OR NOT EXISTS (
            SELECT 1 FROM JSONB_ARRAY_ELEMENTS(snapshot.stocks) AS frozen(value)
             WHERE frozen.value->>'offer_id'=candidate.value->>'offerId'
               AND frozen.value->>'warehouse_id'=candidate.value->>'warehouseId'
               AND frozen.value->>'stock'=candidate.value->>'quantity'
          )
       )
       AND (
         (NEW.recovery_attempt_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM submission_category_recovery_attempts AS recovery
            WHERE recovery.account_id=job.account_id
              AND recovery.submission_job_id=job.id
              AND recovery.submission_snapshot_id=job.snapshot_id
         ))
         OR EXISTS (
           SELECT 1 FROM submission_category_recovery_attempts AS recovery
            WHERE recovery.account_id=job.account_id
              AND recovery.submission_job_id=job.id
              AND recovery.submission_snapshot_id=job.snapshot_id
              AND recovery.id=NEW.recovery_attempt_id
              AND recovery.status IN ('SUCCEEDED','NEEDS_REVIEW')
              AND recovery.retry_ozon_task_id=NEW.import_ozon_task_id
         )
       )
  ) THEN
    RAISE EXCEPTION 'stock write intent identity is not eligible' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION audit_submission_stock_write_intent()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO submission_stock_write_events(
    account_id,stock_write_intent_id,submission_job_id,submission_snapshot_id,
    from_status,to_status,event_type,actor_id,payload
  ) VALUES (
    NEW.account_id,NEW.id,NEW.submission_job_id,NEW.submission_snapshot_id,
    CASE WHEN TG_OP='INSERT' THEN '' ELSE OLD.status END,NEW.status,
    CASE NEW.status
      WHEN 'PREPARED' THEN 'submission.stock_write_prepared'
      WHEN 'IN_FLIGHT' THEN 'submission.stock_write_started'
      WHEN 'RESOLVED' THEN 'submission.stock_write_resolved'
      WHEN 'DONE' THEN 'submission.stock_write_done'
      ELSE 'submission.stock_write_ambiguous'
    END,
    NEW.actor_id,
    JSONB_BUILD_OBJECT('requestHash',NEW.request_hash,'failureCode',NEW.failure_code)
    || CASE WHEN NEW.status='RESOLVED' THEN JSONB_BUILD_OBJECT('stockResults',(
      SELECT JSONB_AGG(result.value) FROM submission_jobs AS job,
        JSONB_ARRAY_ELEMENTS(job.result_summary->'stockResults') AS result(value)
       WHERE job.account_id=NEW.account_id AND job.id=NEW.submission_job_id
         AND EXISTS (SELECT 1 FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items) AS item(value)
           WHERE item.value->>'offerId'=result.value->>'offerId'
             AND item.value->>'warehouseId'=result.value->>'warehouseId')
    )) ELSE '{}'::jsonb END
  );
  RETURN NEW;
END;
$$;
