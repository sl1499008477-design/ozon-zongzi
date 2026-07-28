-- Keep local_state's legacy operating-store ownership aligned with the formal
-- stores table. Never infer an owner from the current account: in a multi-user
-- installation, stores.owner_account_id is the only authoritative mapping.

LOCK TABLE local_state IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE stores IN SHARE MODE;

DO $$
DECLARE
  invalid_state_ids TEXT;
  unmapped_stores TEXT;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id)
  INTO invalid_state_ids
  FROM local_state
  WHERE state ? 'stores'
    AND state->'stores' <> 'null'::JSONB
    AND jsonb_typeof(state->'stores') <> 'array';

  IF invalid_state_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = format(
        'Cannot backfill local_state store owners: state.stores must be an array (state rows: %s)',
        invalid_state_ids
      ),
      HINT = 'Repair the listed local_state rows before rerunning this migration.';
  END IF;

  WITH legacy_stores AS (
    SELECT
      state_row.id AS state_id,
      entry.ordinality,
      entry.item,
      NULLIF(btrim(entry.item->>'id'), '') AS store_id,
      NULLIF(btrim(entry.item->>'ownerAccountId'), '') AS legacy_owner_account_id
    FROM local_state state_row
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(state_row.state->'stores') = 'array'
          THEN state_row.state->'stores'
        ELSE '[]'::JSONB
      END
    ) WITH ORDINALITY AS entry(item, ordinality)
  )
  SELECT string_agg(
    format(
      '%s.stores[%s] (store id: %s)',
      legacy.state_id,
      legacy.ordinality - 1,
      COALESCE(legacy.store_id, '<missing>')
    ),
    ', ' ORDER BY legacy.state_id, legacy.ordinality
  )
  INTO unmapped_stores
  FROM legacy_stores legacy
  LEFT JOIN stores formal_store ON formal_store.id = legacy.store_id
  WHERE legacy.legacy_owner_account_id IS NULL
    AND NULLIF(btrim(formal_store.owner_account_id), '') IS NULL;

  IF unmapped_stores IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format(
        'Cannot backfill local_state store owners: no authoritative stores.owner_account_id mapping for %s',
        unmapped_stores
      ),
      HINT = 'Create or restore the matching formal stores rows before rerunning; this migration will not guess an account owner.';
  END IF;
END
$$;

WITH expanded AS (
  SELECT
    state_row.id AS state_id,
    entry.ordinality,
    entry.item,
    formal_store.owner_account_id
  FROM local_state state_row
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(state_row.state->'stores') = 'array'
        THEN state_row.state->'stores'
      ELSE '[]'::JSONB
    END
  ) WITH ORDINALITY AS entry(item, ordinality)
  LEFT JOIN stores formal_store ON formal_store.id = NULLIF(btrim(entry.item->>'id'), '')
), rebuilt AS (
  SELECT
    state_id,
    jsonb_agg(
      CASE
        WHEN owner_account_id IS NOT NULL
          THEN jsonb_set(item, '{ownerAccountId}', to_jsonb(owner_account_id), TRUE)
        ELSE item
      END
      ORDER BY ordinality
    ) AS stores
  FROM expanded
  GROUP BY state_id
)
UPDATE local_state state_row
SET state = jsonb_set(state_row.state, '{stores}', rebuilt.stores, TRUE),
    version = state_row.version + 1,
    updated_at = NOW()
FROM rebuilt
WHERE state_row.id = rebuilt.state_id
  AND state_row.state->'stores' IS DISTINCT FROM rebuilt.stores;
