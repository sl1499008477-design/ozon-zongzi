-- First confirmed target-product success is independent of deletable tasks.
-- Source SKU, mutable updated_at and billing timestamps are not success evidence.
-- Hold both receipt writers until backfill and trigger installation commit.
-- A prior committed write is included in history; a later write sees triggers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE ai_image_listing_submissions,submission_stock_write_events
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE listing_successes (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  store_name TEXT NOT NULL DEFAULT '',
  succeeded_at TIMESTAMPTZ,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY(account_id,store_id,product_id)
);
CREATE INDEX listing_successes_day_idx ON listing_successes(account_id,succeeded_at)
  WHERE succeeded_at IS NOT NULL;
CREATE TABLE listing_success_tracking (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  started_at TIMESTAMPTZ NOT NULL DEFAULT STATEMENT_TIMESTAMP()
);
INSERT INTO listing_success_tracking(singleton) VALUES(TRUE);

-- Retain historical AI identities as unknown-time anchors. A later retry must
-- not turn an old successful target product into a newly listed SKU today.
-- These anchors deliberately precede the manual backfill below: a dated manual
-- receipt does not prove it predates an AI success whose first time is unknown.
-- Keep that identity undated instead of presenting a possibly later retry date.
WITH history AS (
  SELECT submission.account_id,submission.id,
    COALESCE(submission.body#>>'{config,targetStoreId}',task.body#>>'{submissionTarget,targetStoreId}',task.body#>>'{config,targetStoreId}') AS store_id,
    result.value AS result
  FROM ai_image_listing_submissions submission
  LEFT JOIN ai_image_listing_tasks task ON task.account_id=submission.account_id AND task.id=submission.task_id
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(COALESCE(submission.body->'results','[]'::jsonb)) result(value)
  UNION ALL
  SELECT task.account_id,task.id,COALESCE(task.body#>>'{submissionTarget,targetStoreId}',task.body#>>'{config,targetStoreId}'),result.value
  FROM ai_image_listing_tasks task
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(COALESCE(task.body->'submissionResults','[]'::jsonb)) result(value)
)
INSERT INTO listing_successes(account_id,store_id,product_id,store_name,succeeded_at,source,source_id)
SELECT history.account_id,history.store_id,history.result->>'productId',COALESCE(store.label,''),NULL,'AI_HISTORY',history.id
FROM history LEFT JOIN stores store ON store.id=history.store_id AND store.owner_account_id=history.account_id
WHERE history.result->>'importStatus'='SUCCEEDED' AND history.result->>'stockStatus'='COMPLETED'
  AND NULLIF(history.store_id,'') IS NOT NULL AND NULLIF(history.result->>'productId','') IS NOT NULL
ON CONFLICT DO NOTHING;

-- Manual submissions already have immutable stock receipts. Combine receipt
-- subsets until every frozen warehouse for this target SKU has succeeded.
CREATE FUNCTION manual_listing_success_evidence(wanted_account TEXT DEFAULT NULL,wanted_job TEXT DEFAULT NULL)
RETURNS TABLE(account_id TEXT,store_id TEXT,product_id TEXT,succeeded_at TIMESTAMPTZ,job_id TEXT)
LANGUAGE SQL STABLE AS $$
  WITH warehouse_receipts AS (
    SELECT intent.account_id,intent.store_id,intent.submission_job_id AS job_id,
      COALESCE(recovery.product_id,NULLIF(item.product_id,'')) AS product_id,
      stock.value->>'offerId' AS offer_id,stock.value->>'warehouseId' AS warehouse_id,
      MIN(event.created_at) AS succeeded_at,
      (SELECT COUNT(DISTINCT frozen.value->>'warehouse_id')
        FROM JSONB_ARRAY_ELEMENTS(snapshot.stocks) frozen(value)
        WHERE frozen.value->>'offer_id'=stock.value->>'offerId') AS expected_warehouses
    FROM submission_stock_write_events event
    JOIN submission_stock_write_intents intent ON intent.account_id=event.account_id AND intent.id=event.stock_write_intent_id
    JOIN submission_jobs job ON job.account_id=intent.account_id AND job.id=intent.submission_job_id AND job.store_id=intent.store_id
    JOIN submission_snapshots snapshot ON snapshot.id=job.snapshot_id
    CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(intent.stock_items) stock(value)
    JOIN submission_items item ON item.id=stock.value->>'submissionItemId' AND item.job_id=job.id AND item.offer_id=stock.value->>'offerId'
    LEFT JOIN submission_category_recovery_item_results recovery ON recovery.account_id=intent.account_id
      AND recovery.submission_job_id=job.id AND recovery.recovery_attempt_id=intent.recovery_attempt_id
      AND recovery.submission_item_id=item.id AND recovery.status='SUCCEEDED'
    WHERE (wanted_account IS NULL OR intent.account_id=wanted_account)
      AND (wanted_job IS NULL OR job.id=wanted_job)
      AND (event.to_status='DONE' OR event.to_status='RESOLVED' AND EXISTS (
        SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(event.payload->'stockResults','[]'::jsonb)) receipt(value)
        WHERE receipt.value->>'offerId'=stock.value->>'offerId'
          AND receipt.value->>'warehouseId'=stock.value->>'warehouseId'
          AND receipt.value->>'status'='SUCCEEDED' AND receipt.value->>'updated'='true'))
    GROUP BY intent.account_id,intent.store_id,intent.submission_job_id,
      COALESCE(recovery.product_id,NULLIF(item.product_id,'')),stock.value,snapshot.stocks
  )
  SELECT account_id,store_id,product_id,MAX(succeeded_at),job_id
  FROM warehouse_receipts WHERE product_id IS NOT NULL
  GROUP BY account_id,store_id,product_id,job_id,offer_id
  HAVING MAX(expected_warehouses)>0 AND COUNT(DISTINCT warehouse_id)=MAX(expected_warehouses)
$$;

INSERT INTO listing_successes(account_id,store_id,product_id,store_name,succeeded_at,source,source_id)
SELECT evidence.account_id,evidence.store_id,evidence.product_id,COALESCE(store.label,''),evidence.succeeded_at,'MANUAL',evidence.job_id
FROM manual_listing_success_evidence() evidence
LEFT JOIN stores store ON store.id=evidence.store_id AND store.owner_account_id=evidence.account_id
ORDER BY evidence.succeeded_at
ON CONFLICT DO NOTHING;

CREATE FUNCTION record_ai_listing_success() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_store TEXT;
BEGIN
  target_store:=NEW.body#>>'{config,targetStoreId}';
  IF NULLIF(target_store,'') IS NULL THEN RETURN NEW; END IF;
  INSERT INTO listing_successes(account_id,store_id,product_id,store_name,succeeded_at,source,source_id)
  SELECT NEW.account_id,target_store,result.value->>'productId',COALESCE(store.label,''),STATEMENT_TIMESTAMP(),'AI',NEW.id
  FROM JSONB_ARRAY_ELEMENTS(COALESCE(NEW.body->'results','[]'::jsonb)) result(value)
  LEFT JOIN stores store ON store.id=target_store AND store.owner_account_id=NEW.account_id
  WHERE result.value->>'importStatus'='SUCCEEDED' AND result.value->>'stockStatus'='COMPLETED'
    AND NULLIF(result.value->>'productId','') IS NOT NULL
    AND (TG_OP='INSERT' OR NOT EXISTS (
      SELECT 1 FROM JSONB_ARRAY_ELEMENTS(COALESCE(OLD.body->'results','[]'::jsonb)) previous(value)
      WHERE previous.value->>'productId'=result.value->>'productId'
        AND previous.value->>'importStatus'='SUCCEEDED' AND previous.value->>'stockStatus'='COMPLETED'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_listing_success_receipt AFTER INSERT OR UPDATE OF body ON ai_image_listing_submissions
  FOR EACH ROW EXECUTE FUNCTION record_ai_listing_success();

CREATE FUNCTION record_manual_listing_success() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_status NOT IN ('DONE','RESOLVED') THEN RETURN NEW; END IF;
  INSERT INTO listing_successes(account_id,store_id,product_id,store_name,succeeded_at,source,source_id)
  SELECT evidence.account_id,evidence.store_id,evidence.product_id,COALESCE(store.label,''),evidence.succeeded_at,'MANUAL',evidence.job_id
  FROM manual_listing_success_evidence(NEW.account_id,NEW.submission_job_id) evidence
  LEFT JOIN stores store ON store.id=evidence.store_id AND store.owner_account_id=evidence.account_id
  ORDER BY evidence.succeeded_at
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER manual_listing_success_receipt AFTER INSERT ON submission_stock_write_events
  FOR EACH ROW EXECUTE FUNCTION record_manual_listing_success();
