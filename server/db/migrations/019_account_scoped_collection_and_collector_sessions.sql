-- Account ownership is the collection boundary. Backfill only from the
-- collection item/task/run that already authoritatively owns each child row.
DO $$
DECLARE
  conflicting_record RECORD;
BEGIN
  SELECT payload.id INTO conflicting_record
  FROM collect_raw_payloads AS payload
  LEFT JOIN collect_items AS item ON item.id = payload.collect_item_id
  WHERE item.id IS NULL
     OR item.account_id IS NULL
     OR (payload.account_id IS NOT NULL AND payload.account_id IS DISTINCT FROM item.account_id)
  ORDER BY payload.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collect_raw_payloads record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;

  SELECT request.id INTO conflicting_record
  FROM collect_requests AS request
  LEFT JOIN collect_items AS item ON item.id = request.collect_item_id
  WHERE item.id IS NULL
     OR item.account_id IS NULL
     OR (request.account_id IS NOT NULL AND request.account_id IS DISTINCT FROM item.account_id)
  ORDER BY request.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collect_requests record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;

  SELECT run.id INTO conflicting_record
  FROM collector_task_runs AS run
  LEFT JOIN collector_tasks AS task ON task.id = run.task_id
  WHERE task.id IS NULL
     OR task.account_id IS NULL
     OR (run.account_id IS NOT NULL AND run.account_id IS DISTINCT FROM task.account_id)
  ORDER BY run.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_task_runs record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;

  SELECT item.id INTO conflicting_record
  FROM collector_task_items AS item
  LEFT JOIN collector_tasks AS task ON task.id = item.task_id
  LEFT JOIN collector_task_runs AS run ON run.id = item.run_id
  WHERE task.id IS NULL
     OR run.id IS NULL
     OR task.account_id IS NULL
     OR run.account_id IS NULL
     OR task.account_id IS DISTINCT FROM run.account_id
     OR (item.account_id IS NOT NULL AND (
       item.account_id IS DISTINCT FROM task.account_id
       OR item.account_id IS DISTINCT FROM run.account_id
     ))
  ORDER BY item.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_task_items record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;

  SELECT event.id INTO conflicting_record
  FROM collector_task_events AS event
  LEFT JOIN collector_tasks AS task ON task.id = event.task_id
  LEFT JOIN collector_task_runs AS run ON run.id = event.run_id
  WHERE task.id IS NULL
     OR task.account_id IS NULL
     OR (event.run_id IS NOT NULL AND (
       run.id IS NULL
       OR run.account_id IS NULL
       OR run.account_id IS DISTINCT FROM task.account_id
     ))
     OR (event.account_id IS NOT NULL AND (
       event.account_id IS DISTINCT FROM task.account_id
       OR (event.run_id IS NOT NULL AND event.account_id IS DISTINCT FROM run.account_id)
     ))
  ORDER BY event.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_task_events record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;

  SELECT export.id INTO conflicting_record
  FROM collector_exports AS export
  LEFT JOIN collector_tasks AS task ON task.id = export.task_id
  LEFT JOIN collector_task_runs AS run ON run.id = export.run_id
  WHERE task.id IS NULL
     OR run.id IS NULL
     OR task.account_id IS NULL
     OR run.account_id IS NULL
     OR task.account_id IS DISTINCT FROM run.account_id
     OR (export.account_id IS NOT NULL AND (
       export.account_id IS DISTINCT FROM task.account_id
       OR export.account_id IS DISTINCT FROM run.account_id
     ))
  ORDER BY export.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_exports record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;

  SELECT snapshot.id INTO conflicting_record
  FROM collector_market_snapshots AS snapshot
  LEFT JOIN collector_tasks AS task ON task.id = snapshot.task_id
  LEFT JOIN collector_task_runs AS run ON run.id = snapshot.run_id
  WHERE (task.id IS NULL AND run.id IS NULL)
     OR (snapshot.task_id IS NOT NULL AND (task.id IS NULL OR task.account_id IS NULL))
     OR (snapshot.run_id IS NOT NULL AND (run.id IS NULL OR run.account_id IS NULL))
     OR (task.id IS NOT NULL AND run.id IS NOT NULL AND task.account_id IS DISTINCT FROM run.account_id)
     OR (snapshot.account_id IS NOT NULL AND (
       (task.id IS NOT NULL AND snapshot.account_id IS DISTINCT FROM task.account_id)
       OR (run.id IS NOT NULL AND snapshot.account_id IS DISTINCT FROM run.account_id)
     ))
  ORDER BY snapshot.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_market_snapshots record %s has conflicting or missing authoritative account', conflicting_record.id);
  END IF;
END $$;

UPDATE collect_raw_payloads AS payload
SET account_id = item.account_id
FROM collect_items AS item
WHERE payload.collect_item_id = item.id
  AND payload.account_id IS NULL
  AND item.account_id IS NOT NULL;

UPDATE collect_requests AS request
SET account_id = item.account_id
FROM collect_items AS item
WHERE request.collect_item_id = item.id
  AND request.account_id IS NULL
  AND item.account_id IS NOT NULL;

UPDATE collector_task_runs AS run
SET account_id = task.account_id
FROM collector_tasks AS task
WHERE run.task_id = task.id
  AND run.account_id IS NULL
  AND task.account_id IS NOT NULL;

UPDATE collector_task_items AS item
SET account_id = run.account_id
FROM collector_task_runs AS run
WHERE item.run_id = run.id
  AND item.account_id IS NULL
  AND run.account_id IS NOT NULL;

UPDATE collector_task_events AS event
SET account_id = COALESCE(
  (SELECT run.account_id FROM collector_task_runs AS run WHERE run.id = event.run_id),
  (SELECT task.account_id FROM collector_tasks AS task WHERE task.id = event.task_id)
)
WHERE event.account_id IS NULL
  AND COALESCE(
    (SELECT run.account_id FROM collector_task_runs AS run WHERE run.id = event.run_id),
    (SELECT task.account_id FROM collector_tasks AS task WHERE task.id = event.task_id)
  ) IS NOT NULL;

UPDATE collector_exports AS export
SET account_id = run.account_id
FROM collector_task_runs AS run
WHERE export.run_id = run.id
  AND export.account_id IS NULL
  AND run.account_id IS NOT NULL;

UPDATE collector_market_snapshots AS snapshot
SET account_id = COALESCE(
  (SELECT run.account_id FROM collector_task_runs AS run WHERE run.id = snapshot.run_id),
  (SELECT task.account_id FROM collector_tasks AS task WHERE task.id = snapshot.task_id)
)
WHERE snapshot.account_id IS NULL
  AND COALESCE(
    (SELECT run.account_id FROM collector_task_runs AS run WHERE run.id = snapshot.run_id),
    (SELECT task.account_id FROM collector_tasks AS task WHERE task.id = snapshot.task_id)
  ) IS NOT NULL;

DO $$
DECLARE
  unowned_record RECORD;
BEGIN
  SELECT id INTO unowned_record
  FROM collect_items
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collect_items record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collect_raw_payloads
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collect_raw_payloads record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collect_requests
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collect_requests record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collector_task_runs
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_task_runs record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collector_task_items
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_task_items record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collector_task_events
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_task_events record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collector_exports
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_exports record %s has no authoritative account', unowned_record.id);
  END IF;

  SELECT id INTO unowned_record
  FROM collector_market_snapshots
  WHERE account_id IS NULL
  ORDER BY id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = format('Cannot migrate account-scoped collection: collector_market_snapshots record %s has no authoritative account', unowned_record.id);
  END IF;
END $$;

ALTER TABLE collect_items
  ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE collect_raw_payloads
  ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE collect_requests
  ALTER COLUMN account_id SET NOT NULL;

DO $$
DECLARE
  nullable_column RECORD;
BEGIN
  FOR nullable_column IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY (ARRAY[
        'collect_items',
        'collect_raw_payloads',
        'collect_requests',
        'collector_tasks',
        'collector_task_runs',
        'collector_task_items',
        'collector_task_events',
        'collector_exports',
        'collector_market_snapshots',
        'collector_category_mappings'
      ])
      AND column_name = ANY (ARRAY['store_id', 'operating_store_id', 'data_collection_store_id'])
      AND is_nullable = 'NO'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', nullable_column.table_name, nullable_column.column_name);
  END LOOP;
END $$;

DROP INDEX IF EXISTS collect_items_identity_key_uq;
CREATE UNIQUE INDEX collect_items_account_identity_key_uq
  ON collect_items(account_id, identity_key)
  WHERE identity_key <> '';

-- Keep the existing account/idempotency uniqueness index for the current
-- runtime's ON CONFLICT target. Task 4 will switch that runtime to the
-- account/source/source_sku/key contract before the compatibility index can
-- be reviewed for removal.
CREATE UNIQUE INDEX collect_requests_account_request_uq
  ON collect_requests(account_id, source, source_sku, idempotency_key);

CREATE UNIQUE INDEX sessions_account_token_uq
  ON sessions(account_id, token);

CREATE TABLE collector_auth_tickets (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_session_token TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '[]'::JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id, parent_session_token)
    REFERENCES sessions(account_id, token) ON DELETE CASCADE
);

CREATE TABLE collector_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_session_token TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL DEFAULT '',
  extension_version TEXT NOT NULL DEFAULT '',
  permissions JSONB NOT NULL DEFAULT '[]'::JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id, parent_session_token)
    REFERENCES sessions(account_id, token) ON DELETE CASCADE
);

CREATE INDEX collector_auth_tickets_expires_at_idx
  ON collector_auth_tickets(expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX collector_auth_tickets_account_expires_at_idx
  ON collector_auth_tickets(account_id, expires_at);

CREATE INDEX collector_sessions_expires_at_idx
  ON collector_sessions(expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX collector_sessions_account_last_seen_at_idx
  ON collector_sessions(account_id, last_seen_at DESC);
