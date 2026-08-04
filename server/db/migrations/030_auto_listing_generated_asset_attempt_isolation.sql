ALTER TABLE ai_generation_assets
  ADD COLUMN IF NOT EXISTS object_key_version TEXT;

-- Preserve pre-V2 accepted/stored evidence as read-only legacy audit. Runtime
-- writers never select this version for new assets.
UPDATE ai_generation_assets
SET object_key_version = 'LEGACY_V1'
WHERE object_key_version IS NULL
  AND object_key IS NOT NULL;

CREATE OR REPLACE FUNCTION auto_listing_object_key_segment(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT REPLACE(
    REPLACE(
      RTRIM(REPLACE(REPLACE(ENCODE(CONVERT_TO(value, 'UTF8'), 'base64'), E'\n', ''), E'\r', ''), '='),
      '+', '-'
    ),
    '/', '_'
  )
$$;

CREATE OR REPLACE FUNCTION auto_listing_generation_object_key_v2_complete(
  account_id TEXT,
  job_id TEXT,
  item_id TEXT,
  plan_id TEXT,
  visual_group_key TEXT,
  slot_key TEXT,
  attempt_identity_hash TEXT,
  attempt_no INTEGER,
  input_hash TEXT,
  content_hash TEXT,
  object_key TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT account_id IS NOT NULL AND BTRIM(account_id) = account_id AND account_id <> ''
    AND job_id IS NOT NULL AND BTRIM(job_id) = job_id AND job_id <> ''
    AND item_id IS NOT NULL AND BTRIM(item_id) = item_id AND item_id <> ''
    AND plan_id IS NOT NULL AND BTRIM(plan_id) = plan_id AND plan_id <> ''
    AND visual_group_key IS NOT NULL AND BTRIM(visual_group_key) = visual_group_key AND visual_group_key <> ''
    AND slot_key IS NOT NULL AND BTRIM(slot_key) = slot_key AND slot_key <> ''
    AND attempt_identity_hash ~ '^[a-f0-9]{64}$'
    AND attempt_no BETWEEN 1 AND 3
    AND input_hash ~ '^[a-f0-9]{64}$'
    AND content_hash ~ '^[a-f0-9]{64}$'
    AND object_key = 'auto-listing/v2/'
      || auto_listing_object_key_segment(account_id) || '/'
      || auto_listing_object_key_segment(job_id) || '/'
      || auto_listing_object_key_segment(item_id) || '/'
      || auto_listing_object_key_segment(plan_id) || '/'
      || auto_listing_object_key_segment(visual_group_key) || '/'
      || auto_listing_object_key_segment(slot_key) || '/'
      || attempt_identity_hash || '/attempt-' || attempt_no::TEXT || '/'
      || input_hash || '/' || content_hash || '.png'
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_generation_assets_object_key_version_check'
      AND conrelid = 'ai_generation_assets'::regclass
  ) THEN
    ALTER TABLE ai_generation_assets
      ADD CONSTRAINT ai_generation_assets_object_key_version_check CHECK (
        object_key_version IS NULL OR object_key_version IN ('LEGACY_V1', 'ATTEMPT_V2')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_generation_assets_new_object_key_v2_check'
      AND conrelid = 'ai_generation_assets'::regclass
  ) THEN
    ALTER TABLE ai_generation_assets
      ADD CONSTRAINT ai_generation_assets_new_object_key_v2_check CHECK (
        status <> 'ACCEPTED' OR (
          object_key_version = 'ATTEMPT_V2'
          AND auto_listing_generation_object_key_v2_complete(account_id,job_id,item_id,plan_id,visual_group_key,slot_key,attempt_identity_hash,attempt_no,input_hash,content_hash,object_key)
        )
      ) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE auto_listing_asset_cleanup_obligations
  ADD COLUMN IF NOT EXISTS object_key_version TEXT,
  ADD COLUMN IF NOT EXISTS adopted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS adopted_generation_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS adopted_generation_asset_status TEXT;

UPDATE auto_listing_asset_cleanup_obligations
SET object_key_version = 'LEGACY_V1'
WHERE object_key_version IS NULL;

ALTER TABLE auto_listing_asset_cleanup_obligations
  ALTER COLUMN object_key_version SET NOT NULL;

ALTER TABLE auto_listing_asset_cleanup_obligations
  DROP CONSTRAINT IF EXISTS auto_listing_asset_cleanup_obligations_status_check;

ALTER TABLE auto_listing_asset_cleanup_obligations
  ADD CONSTRAINT auto_listing_asset_cleanup_obligations_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'ADOPTED'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auto_listing_asset_cleanup_object_key_version_check'
      AND conrelid = 'auto_listing_asset_cleanup_obligations'::regclass
  ) THEN
    ALTER TABLE auto_listing_asset_cleanup_obligations
      ADD CONSTRAINT auto_listing_asset_cleanup_object_key_version_check CHECK (
        object_key_version IN ('LEGACY_V1', 'ATTEMPT_V2')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auto_listing_asset_cleanup_new_object_key_v2_check'
      AND conrelid = 'auto_listing_asset_cleanup_obligations'::regclass
  ) THEN
    ALTER TABLE auto_listing_asset_cleanup_obligations
      ADD CONSTRAINT auto_listing_asset_cleanup_new_object_key_v2_check CHECK (
        object_key_version = 'LEGACY_V1'
        OR (
          object_key_version = 'ATTEMPT_V2'
          AND auto_listing_generation_object_key_v2_complete(account_id,job_id,item_id,plan_id,visual_group_key,slot_key,attempt_identity_hash,attempt_no,input_hash,content_hash,object_key)
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auto_listing_asset_cleanup_adopted_audit_check'
      AND conrelid = 'auto_listing_asset_cleanup_obligations'::regclass
  ) THEN
    ALTER TABLE auto_listing_asset_cleanup_obligations
      ADD CONSTRAINT auto_listing_asset_cleanup_adopted_audit_check CHECK (
        (status = 'ADOPTED'
          AND adopted_at IS NOT NULL
          AND NULLIF(BTRIM(adopted_generation_asset_id), '') IS NOT NULL
          AND NULLIF(BTRIM(adopted_generation_asset_status), '') IS NOT NULL
          AND claim_token IS NULL AND claim_owner IS NULL AND claim_expires_at IS NULL)
        OR (status <> 'ADOPTED'
          AND adopted_at IS NULL AND adopted_generation_asset_id IS NULL AND adopted_generation_asset_status IS NULL)
      ) NOT VALID;
  END IF;
END;
$$;

-- CHECK constraints cannot distinguish an old LEGACY_V1 row being terminally
-- updated from a newly inserted row. This insert-only trigger closes that gap
-- while leaving migrated cleanup obligations recoverable.
CREATE OR REPLACE FUNCTION auto_listing_asset_cleanup_new_v2_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.object_key_version <> 'ATTEMPT_V2'
    OR NOT auto_listing_generation_object_key_v2_complete(
      NEW.account_id,NEW.job_id,NEW.item_id,NEW.plan_id,NEW.visual_group_key,NEW.slot_key,
      NEW.attempt_identity_hash,NEW.attempt_no,NEW.input_hash,NEW.content_hash,NEW.object_key
    ) THEN
    RAISE EXCEPTION 'new cleanup obligations require an exact ATTEMPT_V2 object key' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_listing_asset_cleanup_new_v2_only_trigger
  ON auto_listing_asset_cleanup_obligations;
CREATE TRIGGER auto_listing_asset_cleanup_new_v2_only_trigger
BEFORE INSERT ON auto_listing_asset_cleanup_obligations
FOR EACH ROW EXECUTE FUNCTION auto_listing_asset_cleanup_new_v2_only();
