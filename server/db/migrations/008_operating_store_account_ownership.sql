-- Keep the same lock order as formal persistence (accounts -> stores) so a
-- live API instance can finish its mirror transaction without deadlocking
-- against this ownership migration.
LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE stores IN ACCESS EXCLUSIVE MODE;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS owner_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;

WITH legacy_ownership AS (
  SELECT
    item->>'id' AS store_id,
    COALESCE(NULLIF(item->>'ownerAccountId',''), NULLIF(state_row.state->>'currentAccountId','')) AS owner_account_id
  FROM local_state state_row,
       LATERAL jsonb_array_elements(COALESCE(state_row.state->'stores','[]'::jsonb)) item
  WHERE state_row.id='local-state'
)
UPDATE stores target
SET owner_account_id=legacy_ownership.owner_account_id
FROM legacy_ownership
WHERE target.id=legacy_ownership.store_id
  AND target.owner_account_id IS NULL
  AND EXISTS (SELECT 1 FROM accounts WHERE id=legacy_ownership.owner_account_id);

UPDATE stores
SET owner_account_id=(
  SELECT id FROM accounts
  ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, created_at NULLS LAST, id
  LIMIT 1
)
WHERE owner_account_id IS NULL
  AND EXISTS (SELECT 1 FROM accounts);

ALTER TABLE stores
  ALTER COLUMN owner_account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS stores_owner_account_idx
  ON stores(owner_account_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS stores_owner_current_uq
  ON stores(owner_account_id)
  WHERE is_current;
