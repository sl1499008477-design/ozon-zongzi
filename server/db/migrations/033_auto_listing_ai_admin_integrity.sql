-- Administrative publication integrity for auto-listing AI configuration.
-- Existing rows are never rewritten: ambiguous legacy current rows stop the
-- migration so an operator can resolve them deliberately instead of guessing.

CREATE OR REPLACE FUNCTION protect_published_auto_listing_strategy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'RETIRED') OR OLD.published_at IS NOT NULL THEN
    IF OLD.status = 'PUBLISHED'
      AND NEW.status = 'RETIRED'
      AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.strategy_key IS NOT DISTINCT FROM OLD.strategy_key
      AND NEW.version IS NOT DISTINCT FROM OLD.version
      AND NEW.content IS NOT DISTINCT FROM OLD.content
      AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
      AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
      AND NEW.published_by IS NOT DISTINCT FROM OLD.published_by
      AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published strategy versions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_reject_published_strategy_version_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'RETIRED') OR OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published strategy versions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION auto_listing_reject_published_strategy_rule_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1
    FROM ai_content_strategy_versions
    WHERE account_id = OLD.account_id
      AND id = OLD.strategy_version_id
      AND (status IN ('PUBLISHED', 'RETIRED') OR published_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'published strategy rules are immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
    SELECT 1
    FROM ai_content_strategy_versions
    WHERE account_id = NEW.account_id
      AND id = NEW.strategy_version_id
      AND (status IN ('PUBLISHED', 'RETIRED') OR published_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'published strategy rules are immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ai_content_strategy_rules r
    LEFT JOIN ai_content_strategy_versions v
      ON v.account_id = r.account_id
     AND v.id = r.strategy_version_id
    WHERE v.id IS NULL
  ) THEN
    RAISE EXCEPTION 'cross-account AI content strategy rules require explicit repair' USING ERRCODE = '23503';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ai_content_strategy_rules_account_version_fk'
      AND conrelid = 'ai_content_strategy_rules'::regclass
  ) THEN
    ALTER TABLE ai_content_strategy_rules
      ADD CONSTRAINT ai_content_strategy_rules_account_version_fk
      FOREIGN KEY (account_id, strategy_version_id)
      REFERENCES ai_content_strategy_versions(account_id, id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE ai_content_strategy_rules
  VALIDATE CONSTRAINT ai_content_strategy_rules_account_version_fk;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ai_gateway_profiles
    WHERE enabled IS TRUE
    GROUP BY account_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate enabled AI gateway profiles require explicit repair' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_gateway_profiles_one_enabled_per_account_uq
  ON ai_gateway_profiles(account_id)
  WHERE enabled IS TRUE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ai_content_strategy_versions
    WHERE status = 'PUBLISHED'
    GROUP BY account_id, strategy_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate published AI content strategies require explicit repair' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_content_strategy_versions_one_published_per_key_uq
  ON ai_content_strategy_versions(account_id, strategy_key)
  WHERE status = 'PUBLISHED';
