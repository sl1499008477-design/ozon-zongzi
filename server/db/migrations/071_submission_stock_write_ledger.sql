-- Durable, generation-scoped stock-write intent. An IN_FLIGHT generation without
-- DONE is ambiguous and must never be blindly resent.

CREATE UNIQUE INDEX submission_category_recovery_attempts_stock_identity_key
  ON submission_category_recovery_attempts(account_id,submission_job_id,submission_snapshot_id,id);

CREATE TABLE submission_stock_write_intents (
  id TEXT PRIMARY KEY CHECK (NULLIF(BTRIM(id),'') IS NOT NULL AND OCTET_LENGTH(id)<=240),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  import_ozon_task_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(import_ozon_task_id),'') IS NOT NULL AND OCTET_LENGTH(import_ozon_task_id)<=240
  ),
  recovery_attempt_id TEXT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{32}$'),
  correlation_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(correlation_id),'') IS NOT NULL AND OCTET_LENGTH(correlation_id)<=240
  ),
  actor_id TEXT NOT NULL CHECK (
    NULLIF(BTRIM(actor_id),'') IS NOT NULL AND OCTET_LENGTH(actor_id)<=240
  ),
  stock_items JSONB NOT NULL CHECK (
    JSONB_TYPEOF(stock_items)='array' AND JSONB_ARRAY_LENGTH(stock_items) BETWEEN 1 AND 1000
  ),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 1000),
  status TEXT NOT NULL CHECK (status IN ('PREPARED','IN_FLIGHT','DONE','AMBIGUOUS')),
  failure_code TEXT NOT NULL DEFAULT '' CHECK (OCTET_LENGTH(failure_code)<=120),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(prepared_at)),
  in_flight_at TIMESTAMPTZ CHECK (in_flight_at IS NULL OR ISFINITE(in_flight_at)),
  done_at TIMESTAMPTZ CHECK (done_at IS NULL OR ISFINITE(done_at)),
  ambiguous_at TIMESTAMPTZ CHECK (ambiguous_at IS NULL OR ISFINITE(ambiguous_at)),
  UNIQUE (account_id,id),
  UNIQUE (
    account_id,submission_job_id,submission_snapshot_id,import_ozon_task_id,
    recovery_attempt_id,request_hash
  ),
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id,store_id)
    REFERENCES submission_jobs(account_id,id,snapshot_id,store_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,submission_snapshot_id,store_id)
    REFERENCES submission_snapshots(account_id,id,store_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,submission_job_id,submission_snapshot_id,recovery_attempt_id)
    REFERENCES submission_category_recovery_attempts(
      account_id,submission_job_id,submission_snapshot_id,id
    ) ON DELETE CASCADE,
  CHECK (
    (status='PREPARED' AND in_flight_at IS NULL AND done_at IS NULL AND ambiguous_at IS NULL AND failure_code='')
    OR (status='IN_FLIGHT' AND in_flight_at IS NOT NULL AND done_at IS NULL AND ambiguous_at IS NULL AND failure_code='')
    OR (status='DONE' AND in_flight_at IS NOT NULL AND done_at IS NOT NULL AND ambiguous_at IS NULL AND failure_code='')
    OR (status='AMBIGUOUS' AND in_flight_at IS NOT NULL AND done_at IS NULL
      AND ambiguous_at IS NOT NULL AND NULLIF(BTRIM(failure_code),'') IS NOT NULL)
  )
);

-- NULL recovery_attempt_id is a real generation identity, not an unbounded UNIQUE hole.
CREATE UNIQUE INDEX submission_stock_write_intents_generation_key
  ON submission_stock_write_intents(
    account_id,submission_job_id,submission_snapshot_id,import_ozon_task_id,
    COALESCE(recovery_attempt_id,''),request_hash
  );

CREATE INDEX submission_stock_write_intents_job_status_idx
  ON submission_stock_write_intents(account_id,submission_job_id,status);

CREATE TABLE submission_stock_write_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  stock_write_intent_id TEXT NOT NULL,
  submission_job_id TEXT NOT NULL,
  submission_snapshot_id TEXT NOT NULL,
  from_status TEXT NOT NULL CHECK (from_status IN ('','PREPARED','IN_FLIGHT','DONE','AMBIGUOUS')),
  to_status TEXT NOT NULL CHECK (to_status IN ('PREPARED','IN_FLIGHT','DONE','AMBIGUOUS')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'submission.stock_write_prepared','submission.stock_write_started',
    'submission.stock_write_done','submission.stock_write_ambiguous'
  )),
  actor_id TEXT NOT NULL DEFAULT '' CHECK (OCTET_LENGTH(actor_id)<=240),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (JSONB_TYPEOF(payload)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP() CHECK (ISFINITE(created_at)),
  FOREIGN KEY (account_id,stock_write_intent_id)
    REFERENCES submission_stock_write_intents(account_id,id) ON DELETE CASCADE
);

CREATE INDEX submission_stock_write_events_intent_idx
  ON submission_stock_write_events(account_id,stock_write_intent_id,id);

CREATE OR REPLACE FUNCTION validate_submission_stock_write_intent()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  stock_item JSONB;
  canonical_request TEXT;
  expected_count INTEGER;
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
      OR (OLD.status='IN_FLIGHT' AND NEW.status IN ('DONE','AMBIGUOUS'))
    ) THEN
      RAISE EXCEPTION 'stock write intent transition is not allowed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status<>'PREPARED' OR NEW.item_count<>JSONB_ARRAY_LENGTH(NEW.stock_items) THEN
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
       AND JSONB_ARRAY_LENGTH(snapshot.stocks)=NEW.item_count
       AND NOT EXISTS (
         SELECT 1 FROM JSONB_ARRAY_ELEMENTS(NEW.stock_items) AS candidate(value)
          WHERE NOT EXISTS (
            SELECT 1 FROM submission_items AS item
             WHERE item.job_id=job.id AND item.snapshot_id=job.snapshot_id
               AND item.id=candidate.value->>'submissionItemId'
               AND item.offer_id=candidate.value->>'offerId'
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
              AND recovery.status='SUCCEEDED'
              AND recovery.retry_ozon_task_id=NEW.import_ozon_task_id
         )
       )
  ) THEN
    RAISE EXCEPTION 'stock write intent identity is not eligible' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_stock_write_intent_guard
BEFORE INSERT OR UPDATE ON submission_stock_write_intents
FOR EACH ROW EXECUTE FUNCTION validate_submission_stock_write_intent();

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
      WHEN 'DONE' THEN 'submission.stock_write_done'
      ELSE 'submission.stock_write_ambiguous'
    END,
    NEW.actor_id,
    JSONB_BUILD_OBJECT('requestHash',NEW.request_hash,'failureCode',NEW.failure_code)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_stock_write_intent_audit
AFTER INSERT OR UPDATE ON submission_stock_write_intents
FOR EACH ROW EXECUTE FUNCTION audit_submission_stock_write_intent();

CREATE OR REPLACE FUNCTION guard_submission_stock_write_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (SELECT 1 FROM submission_jobs WHERE account_id=OLD.account_id AND id=OLD.submission_job_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'stock write ledger is append only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER submission_stock_write_intent_delete_guard
BEFORE DELETE ON submission_stock_write_intents
FOR EACH ROW EXECUTE FUNCTION guard_submission_stock_write_delete();

CREATE OR REPLACE FUNCTION guard_submission_stock_write_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM submission_stock_write_intents
     WHERE account_id=OLD.account_id AND id=OLD.stock_write_intent_id
  ) THEN
    RETURN OLD;
  END IF;
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'stock write events are append only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submission_stock_write_event_guard
BEFORE UPDATE OR DELETE ON submission_stock_write_events
FOR EACH ROW EXECUTE FUNCTION guard_submission_stock_write_event();
