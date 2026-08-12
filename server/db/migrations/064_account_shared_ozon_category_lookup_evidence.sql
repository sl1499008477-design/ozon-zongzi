-- Additive provenance support for exact, read-only Ozon lookups.
-- This migration deliberately stores bounded identity/hash metadata only; vendor response bodies
-- and credentials are never persisted here.

CREATE TABLE collect_ozon_category_lookup_evidence (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  collect_item_id TEXT NOT NULL,
  requested_ozon_product_id BIGINT CHECK (requested_ozon_product_id IS NULL OR requested_ozon_product_id > 0),
  requested_source_sku TEXT CHECK (requested_source_sku IS NULL OR NULLIF(BTRIM(requested_source_sku),'') IS NOT NULL),
  matched_ozon_product_id BIGINT NOT NULL CHECK (matched_ozon_product_id > 0),
  matched_source_sku TEXT NOT NULL CHECK (NULLIF(BTRIM(matched_source_sku),'') IS NOT NULL),
  lookup_contract_version TEXT NOT NULL CHECK (lookup_contract_version='account-shared-ozon-category-lookup.v1'),
  trigger_product_draft_id TEXT NOT NULL,
  trigger_product_draft_version INTEGER NOT NULL CHECK (trigger_product_draft_version > 0),
  response_hash TEXT NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,id),
  UNIQUE (account_id,id,collect_item_id),
  FOREIGN KEY (account_id,collect_item_id) REFERENCES collect_items(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (collect_item_id,trigger_product_draft_id)
    REFERENCES product_drafts(collect_item_id,id) ON DELETE CASCADE,
  CHECK (requested_ozon_product_id IS NOT NULL OR requested_source_sku IS NOT NULL),
  CHECK (requested_ozon_product_id IS NULL OR requested_ozon_product_id=matched_ozon_product_id),
  CHECK (requested_source_sku IS NULL OR requested_source_sku=matched_source_sku),
  CHECK (id ~ '^ozon-read:(product|offer):[0-9a-f]{64}:[0-9a-f]{64}$'),
  CHECK (RIGHT(id,65)=':' || response_hash)
);

CREATE OR REPLACE FUNCTION reject_collect_ozon_category_lookup_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (SELECT 1 FROM collect_items WHERE id=OLD.collect_item_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon category lookup evidence is append only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER collect_ozon_category_lookup_evidence_append_only
BEFORE UPDATE OR DELETE ON collect_ozon_category_lookup_evidence
FOR EACH ROW EXECUTE FUNCTION reject_collect_ozon_category_lookup_evidence_mutation();

ALTER TABLE collect_ozon_category_source_evidence
  ADD COLUMN product_raw_response_ref TEXT,
  ADD COLUMN lookup_evidence_id TEXT;

ALTER TABLE collect_ozon_category_source_evidence
  DISABLE TRIGGER collect_ozon_category_source_evidence_immutable;
UPDATE collect_ozon_category_source_evidence
   SET product_raw_response_ref=raw_response_ref
 WHERE source_kind='PRODUCT_DRAFT';
ALTER TABLE collect_ozon_category_source_evidence
  ENABLE TRIGGER collect_ozon_category_source_evidence_immutable;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='collect_ozon_category_source_evidence'::regclass
       AND contype IN ('c','f')
       AND (pg_get_constraintdef(oid) LIKE '%source_kind%'
         OR pg_get_constraintdef(oid) LIKE '%raw_response_ref, collect_item_id%')
  LOOP
    EXECUTE format('ALTER TABLE collect_ozon_category_source_evidence DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE collect_ozon_category_source_evidence
  ADD CONSTRAINT collect_ozon_category_source_evidence_source_kind_check
    CHECK (source_kind IN ('PRODUCT_DRAFT','ENRICHMENT_CACHE','OZON_READ_LOOKUP')),
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
      AND source_version='lookup:' || raw_response_hash)
  ),
  ADD CONSTRAINT collect_ozon_category_source_evidence_product_raw_fkey
    FOREIGN KEY (account_id,product_raw_response_ref,collect_item_id)
    REFERENCES collect_raw_payloads(account_id,id,collect_item_id) ON DELETE CASCADE,
  ADD CONSTRAINT collect_ozon_category_source_evidence_lookup_fkey
    FOREIGN KEY (account_id,lookup_evidence_id,collect_item_id)
    REFERENCES collect_ozon_category_lookup_evidence(account_id,id,collect_item_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX collect_ozon_category_source_evidence_current_identity_key
  ON collect_ozon_category_source_evidence(
    account_id,id,collect_item_id,source_kind,source_record_id,source_version
  );

CREATE TABLE collect_ozon_category_current_sources (
  account_id TEXT NOT NULL,
  collect_item_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('PRODUCT_DRAFT','OZON_READ_LOOKUP')),
  source_record_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id,collect_item_id),
  FOREIGN KEY (account_id,collect_item_id) REFERENCES collect_items(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,source_evidence_id,collect_item_id,source_kind,source_record_id,source_version)
    REFERENCES collect_ozon_category_source_evidence(
      account_id,id,collect_item_id,source_kind,source_record_id,source_version
    ) ON DELETE CASCADE
);

INSERT INTO collect_ozon_category_current_sources (
  account_id,collect_item_id,source_evidence_id,source_kind,source_record_id,source_version,updated_at
)
SELECT evidence.account_id,evidence.collect_item_id,evidence.id,evidence.source_kind,
       evidence.source_record_id,evidence.source_version,evidence.captured_at
  FROM collect_items AS item
  JOIN product_drafts AS draft
    ON draft.id=item.current_draft_id AND draft.collect_item_id=item.id
  JOIN collect_ozon_category_source_evidence AS evidence
    ON evidence.account_id=item.account_id AND evidence.collect_item_id=item.id
   AND evidence.source_kind='PRODUCT_DRAFT' AND evidence.product_draft_id=draft.id
   AND evidence.source_version IN (draft.version::TEXT,'draft:' || draft.version::TEXT)
ON CONFLICT (account_id,collect_item_id) DO NOTHING;

CREATE TABLE account_ozon_category_confirmation_audit (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  collect_item_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  expected_source_version TEXT NOT NULL CHECK (NULLIF(BTRIM(expected_source_version),'') IS NOT NULL),
  selected_description_category_id BIGINT NOT NULL CHECK (selected_description_category_id > 0),
  selected_type_id BIGINT NOT NULL CHECK (selected_type_id > 0),
  taxonomy_scope TEXT NOT NULL CHECK (taxonomy_scope='OZON:DEFAULT'),
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL CHECK (NULLIF(BTRIM(correlation_id),'') IS NOT NULL),
  idempotency_key TEXT NOT NULL CHECK (NULLIF(BTRIM(idempotency_key),'') IS NOT NULL),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_json JSONB NOT NULL CHECK (jsonb_typeof(result_json)='object'),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,idempotency_key),
  FOREIGN KEY (account_id,collect_item_id) REFERENCES collect_items(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,source_evidence_id) REFERENCES collect_ozon_category_source_evidence(account_id,id) ON DELETE CASCADE
);

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
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon category confirmation audit is append only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER account_ozon_category_confirmation_audit_append_only
BEFORE UPDATE OR DELETE ON account_ozon_category_confirmation_audit
FOR EACH ROW EXECUTE FUNCTION reject_account_ozon_category_confirmation_audit_mutation();

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
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon category source evidence is immutable' USING ERRCODE='23514';
END;
$$;
