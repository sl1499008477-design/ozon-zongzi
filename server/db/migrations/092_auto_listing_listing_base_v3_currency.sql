-- Admit the priced-variant V3 listing base while preserving the existing
-- store, top-level evidence, and per-variant currency boundaries.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'auto_listing_listing_bases'::regclass
       AND contype = 'c'
       AND (
         pg_get_constraintdef(oid) ILIKE '%listing_base_version%'
         OR pg_get_constraintdef(oid) ILIKE '%pricing_evidence%currency%'
       )
  LOOP
    EXECUTE format('ALTER TABLE auto_listing_listing_bases DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE auto_listing_listing_bases
  ADD CONSTRAINT auto_listing_listing_bases_currency_v3_check CHECK (
    jsonb_typeof(pricing_evidence) = 'object'
    AND COALESCE(pricing_evidence->>'evidenceHash','') ~ '^[a-f0-9]{64}$'
    AND (
      (listing_base_version = 'AUTO_LISTING_LISTING_BASE_V1'
        AND pricing_evidence->>'currency' = 'RUB'
        AND NOT (pricing_evidence ? 'currencySource'))
      OR
      (listing_base_version = 'AUTO_LISTING_LISTING_BASE_V2'
        AND pricing_evidence->>'currency' IN ('RUB','CNY')
        AND pricing_evidence ? 'currencySource'
        AND pricing_evidence->>'currencySource' IN ('SOURCE','TARGET_STORE'))
      OR
      (listing_base_version = 'AUTO_LISTING_LISTING_BASE_V3'
        AND (
          (pricing_evidence->>'currency' = 'RUB'
            AND NOT (pricing_evidence ? 'currencySource'))
          OR
          (pricing_evidence->>'currency' IN ('RUB','CNY')
            AND pricing_evidence ? 'currencySource'
            AND pricing_evidence->>'currencySource' IN ('SOURCE','TARGET_STORE'))
        ))
    )
  );

CREATE OR REPLACE FUNCTION auto_listing_require_complete_listing_base_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_currency TEXT;
BEGIN
  evidence_currency := NEW.pricing_evidence->>'currency';
  IF NEW.target_store_id IS NULL
    OR NEW.pricing_evidence IS NULL
    OR jsonb_typeof(NEW.pricing_evidence) <> 'object'
    OR COALESCE(NEW.pricing_evidence->>'evidenceHash','') !~ '^[a-f0-9]{64}$'
    OR NEW.rich_content_attribute_supported IS NULL
    OR NOT (
      (NEW.listing_base_version = 'AUTO_LISTING_LISTING_BASE_V1'
        AND evidence_currency = 'RUB'
        AND NOT (NEW.pricing_evidence ? 'currencySource'))
      OR
      (NEW.listing_base_version = 'AUTO_LISTING_LISTING_BASE_V2'
        AND evidence_currency IN ('RUB','CNY')
        AND NEW.pricing_evidence ? 'currencySource'
        AND NEW.pricing_evidence->>'currencySource' IN ('SOURCE','TARGET_STORE'))
      OR
      (NEW.listing_base_version = 'AUTO_LISTING_LISTING_BASE_V3'
        AND (
          (evidence_currency = 'RUB'
            AND NOT (NEW.pricing_evidence ? 'currencySource'))
          OR
          (evidence_currency IN ('RUB','CNY')
            AND NEW.pricing_evidence ? 'currencySource'
            AND NEW.pricing_evidence->>'currencySource' IN ('SOURCE','TARGET_STORE'))
        ))
    )
    OR NOT EXISTS (
      SELECT 1
        FROM stores AS store
       WHERE store.owner_account_id = NEW.account_id
         AND store.id = NEW.target_store_id
         AND store.currency_code = evidence_currency
    )
    OR jsonb_typeof(NEW.ozon_ready_variants) <> 'array'
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(NEW.ozon_ready_variants) AS variant
       WHERE jsonb_typeof(variant) <> 'object'
          OR jsonb_typeof(variant->'item') <> 'object'
          OR variant->'item'->>'currency_code' IS DISTINCT FROM evidence_currency
    )
    OR (
      NEW.listing_base_version = 'AUTO_LISTING_LISTING_BASE_V3'
      AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(NEW.ozon_ready_variants) AS variant
         WHERE jsonb_typeof(variant->'pricingEvidence') IS DISTINCT FROM 'object'
            OR variant->'pricingEvidence'->>'currency' IS DISTINCT FROM evidence_currency
            OR COALESCE(variant->'pricingEvidence'->>'evidenceHash','') !~ '^[a-f0-9]{64}$'
            OR NOT (
              (variant->'pricingEvidence'->>'currency' = 'RUB'
                AND NOT (variant->'pricingEvidence' ? 'currencySource'))
              OR
              (variant->'pricingEvidence'->>'currency' IN ('RUB','CNY')
                AND variant->'pricingEvidence' ? 'currencySource'
                AND variant->'pricingEvidence'->>'currencySource' IN ('SOURCE','TARGET_STORE'))
            )
      )
    )
  THEN
    RAISE EXCEPTION 'auto-listing listing base currency evidence is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
