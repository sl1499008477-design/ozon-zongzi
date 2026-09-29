-- Resolve provenance once. Heartbeats and task summaries read only the indexed
-- key, never the large product raw payload documents.
ALTER TABLE collector_ozon_enrichment_jobs ADD COLUMN task_group_key TEXT;

UPDATE collector_ozon_enrichment_jobs AS job
   SET task_group_key = COALESCE((
     SELECT 'run:' || COALESCE(NULLIF(BTRIM(raw.payload#>>'{source,collectorRunId}'),''),
                              NULLIF(BTRIM(raw.payload#>>'{normalized,collectorRunId}'),''))
       FROM collect_raw_payloads AS raw
      WHERE raw.collect_item_id=job.collect_item_id AND raw.account_id=job.account_id
        AND (raw.created_at<=job.created_at OR raw.request_id=job.request_id)
      ORDER BY (raw.request_id=job.request_id) DESC NULLS LAST,raw.created_at DESC,raw.id DESC
      LIMIT 1
   ), 'collect:' || job.collect_item_id, 'request:' || job.request_id);

CREATE INDEX collector_ozon_enrichment_jobs_task_group_idx
  ON collector_ozon_enrichment_jobs(account_id, task_group_key, created_at DESC, id DESC);

-- Existing worker containers can still insert jobs during a rolling upgrade.
-- Resolve their missing key at the write boundary as well.
CREATE FUNCTION assign_collector_enrichment_task_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE collector_run_id TEXT;
BEGIN
  IF NEW.task_group_key IS NULL THEN
    IF NEW.collect_item_id IS NOT NULL THEN
      -- pg_restore clears search_path; bind the lookup to the triggering table.
      EXECUTE format('SELECT COALESCE(NULLIF(BTRIM(payload#>>''{source,collectorRunId}''),''''),NULLIF(BTRIM(payload#>>''{normalized,collectorRunId}''),'''')) FROM %I.collect_raw_payloads WHERE collect_item_id=$1 AND account_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', TG_TABLE_SCHEMA)
        INTO collector_run_id USING NEW.collect_item_id, NEW.account_id;
      NEW.task_group_key := CASE WHEN collector_run_id IS NOT NULL
        THEN 'run:' || collector_run_id ELSE 'collect:' || NEW.collect_item_id END;
    ELSE
      NEW.task_group_key := 'request:' || NEW.request_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collector_enrichment_task_group_before_insert
BEFORE INSERT ON collector_ozon_enrichment_jobs
FOR EACH ROW EXECUTE FUNCTION assign_collector_enrichment_task_group();

ALTER TABLE collector_ozon_enrichment_jobs ALTER COLUMN task_group_key SET NOT NULL;

CREATE TABLE collector_ozon_enrichment_task_controls (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task_group_key TEXT NOT NULL,
  control_state TEXT NOT NULL CHECK (control_state IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, task_group_key)
);
