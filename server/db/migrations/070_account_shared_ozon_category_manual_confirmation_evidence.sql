-- Additive immutable provenance for administrator confirmation when exact lookup is unresolved.
-- Only bounded identities and hashes are stored; sensitive external material is excluded.

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='collect_ozon_category_source_evidence'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%source_kind%'
  LOOP
    EXECUTE format('ALTER TABLE collect_ozon_category_source_evidence DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE collect_ozon_category_source_evidence
  ADD CONSTRAINT collect_ozon_category_source_evidence_source_kind_check
    CHECK (source_kind IN ('PRODUCT_DRAFT','ENRICHMENT_CACHE','OZON_READ_LOOKUP','MANUAL_CONFIRMATION')),
  ADD CONSTRAINT collect_ozon_category_source_evidence_source_variant_check CHECK (
    (source_kind='PRODUCT_DRAFT'
      AND collect_item_id IS NOT NULL AND product_draft_id IS NOT NULL
      AND product_raw_response_ref=raw_response_ref AND lookup_evidence_id IS NULL
      AND enrichment_source IS NULL AND enrichment_sku IS NULL
      AND enrichment_contract_version IS NULL)
    OR
    (source_kind='ENRICHMENT_CACHE'
      AND collect_item_id IS NULL AND product_draft_id IS NULL
      AND product_raw_response_ref IS NULL AND lookup_evidence_id IS NULL
      AND enrichment_source IS NOT NULL AND enrichment_sku IS NOT NULL
      AND enrichment_contract_version IS NOT NULL)
    OR
    (source_kind='OZON_READ_LOOKUP'
      AND collect_item_id IS NOT NULL AND product_draft_id IS NULL
      AND product_raw_response_ref IS NULL AND lookup_evidence_id IS NOT NULL
      AND enrichment_source IS NULL AND enrichment_sku IS NULL
      AND enrichment_contract_version IS NULL
      AND lookup_evidence_id=raw_response_ref AND source_record_id=lookup_evidence_id
      AND source_version='lookup:v1:' || SUBSTRING(lookup_evidence_id FROM 14))
    OR
    (source_kind='MANUAL_CONFIRMATION'
      AND collect_item_id IS NOT NULL AND product_draft_id IS NULL
      AND product_raw_response_ref IS NULL AND lookup_evidence_id IS NULL
      AND enrichment_source IS NULL AND enrichment_sku IS NULL
      AND enrichment_contract_version IS NULL
      AND source_record_id=raw_response_ref AND source_version=raw_response_ref
      AND raw_response_ref ~ '^manual-confirmation:v1:[0-9a-f]{64}$')
  );

ALTER TABLE collect_ozon_category_current_sources
  DROP CONSTRAINT collect_ozon_category_current_sources_source_kind_check,
  ADD CONSTRAINT collect_ozon_category_current_sources_source_kind_check
    CHECK (source_kind IN ('PRODUCT_DRAFT','OZON_READ_LOOKUP','MANUAL_CONFIRMATION'));

CREATE UNIQUE INDEX product_drafts_collect_item_id_id_version_key
  ON product_drafts(collect_item_id,id,version);

CREATE TABLE collect_ozon_category_manual_confirmation_evidence (
  id TEXT NOT NULL CHECK (id ~ '^manual-confirmation:v1:[0-9a-f]{64}$'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  collect_item_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'MANUAL_CONFIRMATION'
    CHECK (source_kind='MANUAL_CONFIRMATION'),
  source_record_id TEXT NOT NULL CHECK (source_record_id=id),
  source_version TEXT NOT NULL CHECK (source_version=id),
  trigger_product_draft_id TEXT NOT NULL,
  trigger_product_draft_version INTEGER NOT NULL CHECK (trigger_product_draft_version > 0),
  selected_description_category_id BIGINT NOT NULL CHECK (selected_description_category_id > 0),
  selected_type_id BIGINT NOT NULL CHECK (selected_type_id > 0),
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  actor_id TEXT NOT NULL,
  confirmation_contract_version TEXT NOT NULL
    CHECK (confirmation_contract_version='account-shared-ozon-category-manual-confirmation.v1'),
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,id),
  UNIQUE (account_id,idempotency_key),
  UNIQUE (account_id,id,collect_item_id),
  CHECK (actor_id=account_id),
  FOREIGN KEY (account_id,collect_item_id)
    REFERENCES collect_items(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (collect_item_id,trigger_product_draft_id,trigger_product_draft_version)
    REFERENCES product_drafts(collect_item_id,id,version) ON DELETE CASCADE,
  FOREIGN KEY (account_id,source_evidence_id,collect_item_id,source_kind,source_record_id,source_version)
    REFERENCES collect_ozon_category_source_evidence(
      account_id,id,collect_item_id,source_kind,source_record_id,source_version
    ) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION reject_collect_ozon_category_manual_confirmation_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (
      SELECT 1 FROM collect_items WHERE account_id=OLD.account_id AND id=OLD.collect_item_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_source_evidence
       WHERE account_id=OLD.account_id AND id=OLD.source_evidence_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM product_drafts
       WHERE collect_item_id=OLD.collect_item_id AND id=OLD.trigger_product_draft_id
    )
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon manual category confirmation evidence is append only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER collect_ozon_category_manual_confirmation_evidence_append_only
BEFORE UPDATE OR DELETE ON collect_ozon_category_manual_confirmation_evidence
FOR EACH ROW EXECUTE FUNCTION reject_collect_ozon_category_manual_confirmation_evidence_mutation();

ALTER TABLE account_ozon_category_confirmation_audit
  ADD COLUMN manual_confirmation_evidence_id TEXT,
  ADD CONSTRAINT account_ozon_category_confirmation_audit_manual_evidence_fkey
    FOREIGN KEY (account_id,manual_confirmation_evidence_id)
    REFERENCES collect_ozon_category_manual_confirmation_evidence(account_id,id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION reject_collect_ozon_category_source_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR (OLD.collect_item_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM collect_items WHERE account_id=OLD.account_id AND id=OLD.collect_item_id
    ))
    OR (OLD.source_kind='PRODUCT_DRAFT' AND NOT EXISTS (
      SELECT 1 FROM product_drafts WHERE id=OLD.product_draft_id
    ))
    OR (OLD.source_kind='ENRICHMENT_CACHE' AND NOT EXISTS (
      SELECT 1 FROM collector_ozon_enrichment_cache
       WHERE account_id=OLD.account_id AND source=OLD.enrichment_source
         AND sku=OLD.enrichment_sku AND contract_version=OLD.enrichment_contract_version
    ))
    OR (OLD.source_kind='OZON_READ_LOOKUP' AND NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_lookup_evidence
       WHERE account_id=OLD.account_id AND id=OLD.lookup_evidence_id
    ))
    OR (OLD.source_kind='MANUAL_CONFIRMATION' AND NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_manual_confirmation_evidence
       WHERE account_id=OLD.account_id AND source_evidence_id=OLD.id
    ))
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon category source evidence is immutable' USING ERRCODE='23514';
END;
$$;

CREATE OR REPLACE FUNCTION reject_account_ozon_category_confirmation_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (
      SELECT 1 FROM collect_items WHERE account_id=OLD.account_id AND id=OLD.collect_item_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_source_evidence
       WHERE account_id=OLD.account_id AND id=OLD.source_evidence_id
    )
    OR (OLD.manual_confirmation_evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_manual_confirmation_evidence
       WHERE account_id=OLD.account_id AND id=OLD.manual_confirmation_evidence_id
    ))
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon category confirmation audit is append only' USING ERRCODE='23514';
END;
$$;
