-- Forward-only replacement of retired store/collect-item category matches.
-- The application category worker and all listing mutations are stopped while
-- this migration runs. Only canonical collected source facts are admitted.

CREATE OR REPLACE FUNCTION account_shared_category_positive_bigint(value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value ~ '^[1-9][0-9]*$'
      THEN value::NUMERIC <= 9223372036854775807::NUMERIC
    ELSE FALSE
  END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM collect_category_resolutions AS resolution
      JOIN collect_items AS item ON item.id=resolution.collect_item_id
     WHERE resolution.account_id<>item.account_id
  ) THEN
    RAISE EXCEPTION 'category migration preflight found conflicting account ownership'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE TEMP TABLE account_shared_category_raw_facts (
  account_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  collect_item_id TEXT,
  product_draft_id TEXT,
  enrichment_source TEXT,
  enrichment_sku TEXT,
  enrichment_contract_version TEXT,
  raw_response_hash TEXT,
  raw_response_ref TEXT,
  captured_at TIMESTAMPTZ,
  taxonomy_scope TEXT NOT NULL,
  category_json JSONB NOT NULL,
  provenance JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO account_shared_category_raw_facts (
  account_id,source_kind,source_record_id,source_version,collect_item_id,
  product_draft_id,enrichment_source,enrichment_sku,enrichment_contract_version,
  raw_response_hash,raw_response_ref,captured_at,taxonomy_scope,category_json,provenance
)
SELECT item.account_id,'PRODUCT_DRAFT',draft.id,draft.version::TEXT,item.id,
       draft.id,NULL,NULL,NULL,raw.payload_hash,raw.id,
       COALESCE(raw.collected_at,raw.created_at),'OZON:DEFAULT',fact.category_json,
       jsonb_build_object(
         'sourceKind','PRODUCT_DRAFT','sourceRecordId',draft.id,
         'sourceVersion',draft.version::TEXT,'collectItemId',item.id,
         'productDraftId',draft.id,'rawResponseRef',raw.id,
         'canonicalPath',fact.canonical_path
       )
  FROM product_drafts AS draft
  JOIN collect_items AS item ON item.id=draft.collect_item_id
  LEFT JOIN collect_raw_payloads AS raw ON raw.id=draft.source_payload_id
  CROSS JOIN LATERAL (
    SELECT 'data.sourceCategory'::TEXT AS canonical_path,
           draft.data->'sourceCategory' AS category_json
    UNION ALL
    SELECT 'data.variants[].sourceCategory',variant.value->'sourceCategory'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(draft.data->'variants')='array'
             THEN draft.data->'variants' ELSE '[]'::JSONB END
      ) AS variant(value)
    UNION ALL
    SELECT 'data.listingDraft.sourceCategory',
           draft.data->'listingDraft'->'sourceCategory'
    UNION ALL
    SELECT 'data.listingDraft.variants[].sourceCategory',variant.value->'sourceCategory'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(draft.data->'listingDraft'->'variants')='array'
             THEN draft.data->'listingDraft'->'variants' ELSE '[]'::JSONB END
      ) AS variant(value)
  ) AS fact
 WHERE fact.category_json IS NOT NULL
   AND fact.category_json<>'null'::JSONB;

INSERT INTO account_shared_category_raw_facts (
  account_id,source_kind,source_record_id,source_version,collect_item_id,
  product_draft_id,enrichment_source,enrichment_sku,enrichment_contract_version,
  raw_response_hash,raw_response_ref,captured_at,taxonomy_scope,category_json,provenance
)
SELECT cache.account_id,'ENRICHMENT_CACHE',
       cache.source || ':' || cache.sku || ':' || cache.contract_version,
       COALESCE(NULLIF(cache.response_hash,''),cache.contract_version),NULL,
       NULL,cache.source,cache.sku,cache.contract_version,
       cache.response_hash,
       'collector_ozon_enrichment_cache:' || cache.source || ':' || cache.sku || ':' || cache.contract_version,
       cache.captured_at,'OZON:DEFAULT',cache.result_json->'sourceCategory',
       jsonb_build_object(
         'sourceKind','ENRICHMENT_CACHE',
         'sourceRecordId',cache.source || ':' || cache.sku || ':' || cache.contract_version,
         'sourceVersion',COALESCE(NULLIF(cache.response_hash,''),cache.contract_version),
         'enrichmentSource',cache.source,'sku',cache.sku,
         'contractVersion',cache.contract_version
       )
  FROM collector_ozon_enrichment_cache AS cache
 WHERE cache.status='COMPLETE'
   AND cache.result_json->'sourceCategory' IS NOT NULL
   AND cache.result_json->'sourceCategory'<>'null'::JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM account_shared_category_raw_facts
     WHERE jsonb_typeof(category_json)<>'object'
        OR (
          category_json ? 'descriptionCategoryId'
          AND NULLIF(BTRIM(category_json->>'descriptionCategoryId'),'') IS NOT NULL
          AND NOT account_shared_category_positive_bigint(category_json->>'descriptionCategoryId')
        )
        OR (
          category_json ? 'typeIdCandidate'
          AND NULLIF(BTRIM(category_json->>'typeIdCandidate'),'') IS NOT NULL
          AND NOT account_shared_category_positive_bigint(category_json->>'typeIdCandidate')
        )
  ) THEN
    RAISE EXCEPTION 'category migration preflight found malformed positive source IDs'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_shared_category_raw_facts
     WHERE account_shared_category_positive_bigint(category_json->>'descriptionCategoryId')
       AND account_shared_category_positive_bigint(category_json->>'typeIdCandidate')
       AND (
         raw_response_hash IS NULL
         OR LOWER(raw_response_hash) !~ '^[0-9a-f]{64}$'
         OR NULLIF(BTRIM(raw_response_ref),'') IS NULL
         OR captured_at IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'category migration preflight found incomplete immutable provenance'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM account_shared_category_raw_facts
     WHERE account_shared_category_positive_bigint(category_json->>'descriptionCategoryId')
       AND account_shared_category_positive_bigint(category_json->>'typeIdCandidate')
     GROUP BY account_id,source_kind,source_record_id,source_version
    HAVING COUNT(DISTINCT (
      category_json->>'descriptionCategoryId') || ':' ||
      (category_json->>'typeIdCandidate') || ':' || taxonomy_scope
    )>1
  ) THEN
    RAISE EXCEPTION 'category migration preflight found duplicate incompatible source facts'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE TEMP TABLE account_shared_category_candidates ON COMMIT DROP AS
SELECT DISTINCT ON (account_id,source_kind,source_record_id,source_version)
       account_id,source_kind,source_record_id,source_version,collect_item_id,
       product_draft_id,enrichment_source,enrichment_sku,enrichment_contract_version,
       (category_json->>'descriptionCategoryId')::BIGINT AS source_description_category_id,
       (category_json->>'typeIdCandidate')::BIGINT AS source_type_id,
       taxonomy_scope,LOWER(raw_response_hash) AS raw_response_hash,
       raw_response_ref,captured_at,provenance
  FROM account_shared_category_raw_facts
 WHERE account_shared_category_positive_bigint(category_json->>'descriptionCategoryId')
   AND account_shared_category_positive_bigint(category_json->>'typeIdCandidate')
 ORDER BY account_id,source_kind,source_record_id,source_version,
          provenance->>'canonicalPath' NULLS LAST;

CREATE UNIQUE INDEX product_drafts_collect_item_id_id_key
  ON product_drafts(collect_item_id,id);

CREATE TABLE collect_ozon_category_source_evidence (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('PRODUCT_DRAFT','ENRICHMENT_CACHE')),
  source_record_id TEXT NOT NULL CHECK (NULLIF(BTRIM(source_record_id),'') IS NOT NULL),
  source_version TEXT NOT NULL CHECK (NULLIF(BTRIM(source_version),'') IS NOT NULL),
  collect_item_id TEXT,
  product_draft_id TEXT,
  enrichment_source TEXT,
  enrichment_sku TEXT,
  enrichment_contract_version TEXT,
  source_description_category_id BIGINT NOT NULL CHECK (source_description_category_id > 0),
  source_type_id BIGINT NOT NULL CHECK (source_type_id > 0),
  taxonomy_scope TEXT NOT NULL CHECK (NULLIF(BTRIM(taxonomy_scope),'') IS NOT NULL),
  captured_at TIMESTAMPTZ NOT NULL,
  raw_response_hash TEXT NOT NULL CHECK (raw_response_hash ~ '^[0-9a-f]{64}$'),
  raw_response_ref TEXT NOT NULL CHECK (NULLIF(BTRIM(raw_response_ref), '') IS NOT NULL),
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,id),
  UNIQUE (account_id,source_kind,source_record_id,source_version),
  FOREIGN KEY (account_id,collect_item_id) REFERENCES collect_items(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (collect_item_id,product_draft_id) REFERENCES product_drafts(collect_item_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,enrichment_source,enrichment_sku,enrichment_contract_version) REFERENCES collector_ozon_enrichment_cache(account_id,source,sku,contract_version) ON DELETE CASCADE,
  CHECK (
    (source_kind='PRODUCT_DRAFT'
      AND collect_item_id IS NOT NULL AND product_draft_id IS NOT NULL
      AND enrichment_source IS NULL AND enrichment_sku IS NULL
      AND enrichment_contract_version IS NULL)
    OR
    (source_kind='ENRICHMENT_CACHE'
      AND collect_item_id IS NULL AND product_draft_id IS NULL
      AND enrichment_source IS NOT NULL AND enrichment_sku IS NOT NULL
      AND enrichment_contract_version IS NOT NULL)
  )
);

CREATE INDEX collect_ozon_category_source_evidence_account_capture_idx
  ON collect_ozon_category_source_evidence(account_id,captured_at DESC,id);
CREATE INDEX collect_ozon_category_source_evidence_signature_idx
  ON collect_ozon_category_source_evidence(
    account_id,source_description_category_id,source_type_id,taxonomy_scope,captured_at DESC
  );

CREATE TABLE account_ozon_shared_categories (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_description_category_id BIGINT NOT NULL CHECK (source_description_category_id > 0),
  source_type_id BIGINT NOT NULL CHECK (source_type_id > 0),
  taxonomy_scope TEXT NOT NULL CHECK (NULLIF(BTRIM(taxonomy_scope),'') IS NOT NULL),
  current_description_category_id BIGINT NOT NULL CHECK (current_description_category_id > 0),
  current_type_id BIGINT NOT NULL CHECK (current_type_id > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','INVALIDATED','NEEDS_REVIEW')),
  source TEXT NOT NULL CHECK (source IN ('SOURCE_DIRECT','OZON_REFRESH','MANUAL')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  taxonomy_fingerprint TEXT NOT NULL CHECK (taxonomy_fingerprint ~ '^[0-9a-f]{64}$'),
  safe_failure_code TEXT NOT NULL DEFAULT '',
  source_evidence_id TEXT NOT NULL,
  validated_at TIMESTAMPTZ,
  next_refresh_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,id),
  UNIQUE (account_id,source_description_category_id,source_type_id,taxonomy_scope),
  FOREIGN KEY (account_id,source_evidence_id) REFERENCES collect_ozon_category_source_evidence(account_id,id) ON DELETE CASCADE,
  CHECK (
    (status='ACTIVE' AND safe_failure_code='')
    OR (status IN ('INVALIDATED','NEEDS_REVIEW') AND NULLIF(BTRIM(safe_failure_code),'') IS NOT NULL)
  )
);

CREATE INDEX account_ozon_shared_categories_due_idx
  ON account_ozon_shared_categories(account_id,status,next_refresh_at,id)
  WHERE next_refresh_at IS NOT NULL;
CREATE INDEX account_ozon_shared_categories_read_idx
  ON account_ozon_shared_categories(
    account_id,taxonomy_scope,source_description_category_id,source_type_id,status
  );

CREATE TABLE account_ozon_shared_category_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shared_category_id TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (NULLIF(BTRIM(event_type),'') IS NOT NULL),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('ACTIVE','INVALIDATED','NEEDS_REVIEW')),
  to_status TEXT NOT NULL CHECK (to_status IN ('ACTIVE','INVALIDATED','NEEDS_REVIEW')),
  from_version INTEGER CHECK (from_version IS NULL OR from_version > 0),
  to_version INTEGER NOT NULL CHECK (to_version > 0),
  taxonomy_fingerprint TEXT NOT NULL CHECK (taxonomy_fingerprint ~ '^[0-9a-f]{64}$'),
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id,shared_category_id,to_version,event_type),
  FOREIGN KEY (account_id,shared_category_id) REFERENCES account_ozon_shared_categories(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY (account_id,source_evidence_id) REFERENCES collect_ozon_category_source_evidence(account_id,id) ON DELETE CASCADE
);

CREATE INDEX account_ozon_shared_category_events_read_idx
  ON account_ozon_shared_category_events(account_id,shared_category_id,created_at,id);

CREATE OR REPLACE FUNCTION reject_collect_ozon_category_source_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR (OLD.source_kind='PRODUCT_DRAFT' AND NOT EXISTS (
      SELECT 1 FROM product_drafts WHERE id=OLD.product_draft_id
    ))
    OR (OLD.source_kind='ENRICHMENT_CACHE' AND NOT EXISTS (
      SELECT 1 FROM collector_ozon_enrichment_cache
       WHERE account_id=OLD.account_id AND source=OLD.enrichment_source
         AND sku=OLD.enrichment_sku AND contract_version=OLD.enrichment_contract_version
    ))
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Ozon category source evidence is immutable' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER collect_ozon_category_source_evidence_immutable
BEFORE UPDATE OR DELETE ON collect_ozon_category_source_evidence
FOR EACH ROW EXECUTE FUNCTION reject_collect_ozon_category_source_evidence_mutation();

CREATE OR REPLACE FUNCTION guard_account_ozon_shared_category_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_source_evidence
       WHERE account_id=OLD.account_id AND id=OLD.source_evidence_id
    )
  ) THEN
    RETURN OLD;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'account-shared Ozon category rows require exact parent cleanup'
      USING ERRCODE='23514';
  END IF;
  IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id
    OR NEW.source_description_category_id<>OLD.source_description_category_id
    OR NEW.source_type_id<>OLD.source_type_id
    OR NEW.taxonomy_scope<>OLD.taxonomy_scope
    OR NEW.created_at<>OLD.created_at
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_at<=OLD.updated_at
  THEN
    RAISE EXCEPTION 'invalid account-shared Ozon category transition'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_ozon_shared_categories_transition_guard
BEFORE UPDATE OR DELETE ON account_ozon_shared_categories
FOR EACH ROW EXECUTE FUNCTION guard_account_ozon_shared_category_transition();

CREATE OR REPLACE FUNCTION reject_account_ozon_shared_category_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    NOT EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id)
    OR NOT EXISTS (
      SELECT 1 FROM account_ozon_shared_categories
       WHERE account_id=OLD.account_id AND id=OLD.shared_category_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM collect_ozon_category_source_evidence
       WHERE account_id=OLD.account_id AND id=OLD.source_evidence_id
    )
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'account-shared Ozon category events are append-only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER account_ozon_shared_category_events_append_only
BEFORE UPDATE OR DELETE ON account_ozon_shared_category_events
FOR EACH ROW EXECUTE FUNCTION reject_account_ozon_shared_category_event_mutation();

CREATE OR REPLACE FUNCTION record_account_ozon_shared_category_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_ozon_shared_category_events (
    id,account_id,shared_category_id,source_evidence_id,event_type,from_status,
    to_status,from_version,to_version,taxonomy_fingerprint,provenance,created_at
  ) VALUES (
    'ozon-shared-category-event-' || MD5(
      NEW.account_id || ':' || NEW.id || ':' || NEW.version::TEXT || ':' || NEW.updated_at::TEXT
    ),
    NEW.account_id,NEW.id,NEW.source_evidence_id,'CURRENT_ROW_TRANSITION',
    OLD.status,NEW.status,OLD.version,NEW.version,NEW.taxonomy_fingerprint,
    jsonb_build_object(
      'sharedCategoryId',NEW.id,
      'sourceEvidenceId',NEW.source_evidence_id,
      'fromVersion',OLD.version,
      'toVersion',NEW.version,
      'taxonomyFingerprint',NEW.taxonomy_fingerprint,
      'updatedAt',NEW.updated_at
    ),
    NEW.updated_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_ozon_shared_categories_transition_event
AFTER UPDATE ON account_ozon_shared_categories
FOR EACH ROW EXECUTE FUNCTION record_account_ozon_shared_category_transition();

INSERT INTO collect_ozon_category_source_evidence (
  id,account_id,source_kind,source_record_id,source_version,collect_item_id,
  product_draft_id,enrichment_source,enrichment_sku,enrichment_contract_version,
  source_description_category_id,source_type_id,taxonomy_scope,captured_at,
  raw_response_hash,raw_response_ref,provenance,created_at
)
SELECT 'ozon-cat-evidence-' || MD5(
         account_id || ':' || source_kind || ':' || source_record_id || ':' || source_version
       ),
       account_id,source_kind,source_record_id,source_version,collect_item_id,
       product_draft_id,enrichment_source,enrichment_sku,enrichment_contract_version,
       source_description_category_id,source_type_id,taxonomy_scope,captured_at,
       raw_response_hash,raw_response_ref,provenance,captured_at
  FROM account_shared_category_candidates;

INSERT INTO account_ozon_shared_categories (
  id,account_id,source_description_category_id,source_type_id,taxonomy_scope,
  current_description_category_id,current_type_id,status,source,version,
  taxonomy_fingerprint,safe_failure_code,source_evidence_id,validated_at,
  next_refresh_at,created_at,updated_at
)
SELECT 'ozon-shared-category-' || MD5(
         account_id || ':' || source_description_category_id::TEXT || ':' ||
         source_type_id::TEXT || ':' || taxonomy_scope
       ),
       account_id,source_description_category_id,source_type_id,taxonomy_scope,
       source_description_category_id,source_type_id,'ACTIVE','SOURCE_DIRECT',1,
       raw_response_hash,'',evidence_id,captured_at,NULL,captured_at,captured_at
  FROM (
    SELECT DISTINCT ON (
             candidate.account_id,candidate.source_description_category_id,
             candidate.source_type_id,candidate.taxonomy_scope
           )
           candidate.account_id,candidate.source_description_category_id,
           candidate.source_type_id,candidate.taxonomy_scope,candidate.raw_response_hash,
           candidate.captured_at,evidence.id AS evidence_id
      FROM account_shared_category_candidates AS candidate
      JOIN collect_ozon_category_source_evidence AS evidence
        ON evidence.account_id=candidate.account_id
       AND evidence.source_kind=candidate.source_kind
       AND evidence.source_record_id=candidate.source_record_id
       AND evidence.source_version=candidate.source_version
     ORDER BY candidate.account_id,candidate.source_description_category_id,
              candidate.source_type_id,candidate.taxonomy_scope,
              candidate.captured_at DESC,evidence.id
  ) AS selected;

INSERT INTO account_ozon_shared_category_events (
  id,account_id,shared_category_id,source_evidence_id,event_type,from_status,
  to_status,from_version,to_version,taxonomy_fingerprint,provenance,created_at
)
SELECT 'ozon-shared-category-event-' || MD5(shared.account_id || ':' || shared.id || ':1'),
       shared.account_id,shared.id,shared.source_evidence_id,'MIGRATED_SOURCE_DIRECT',
       NULL,shared.status,NULL,shared.version,shared.taxonomy_fingerprint,
       jsonb_build_object(
         'sharedCategoryId',shared.id,'sourceEvidenceId',evidence.id,
         'sourceRecordId',evidence.source_record_id,
         'sourceVersion',evidence.source_version,
         'rawResponseHash',evidence.raw_response_hash,
         'rawResponseRef',evidence.raw_response_ref,
         'capturedAt',evidence.captured_at,
         'sourceProvenance',evidence.provenance
       ),shared.created_at
  FROM account_ozon_shared_categories AS shared
  JOIN collect_ozon_category_source_evidence AS evidence
    ON evidence.account_id=shared.account_id AND evidence.id=shared.source_evidence_id;

DO $$
DECLARE
  expected_evidence INTEGER;
  expected_shared INTEGER;
BEGIN
  SELECT COUNT(*)::INT INTO expected_evidence FROM account_shared_category_candidates;
  IF (SELECT COUNT(*) FROM collect_ozon_category_source_evidence)<>expected_evidence THEN
    RAISE EXCEPTION 'category migration evidence count validation failed' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*)::INT INTO expected_shared FROM (
    SELECT DISTINCT account_id,source_description_category_id,source_type_id,taxonomy_scope
      FROM account_shared_category_candidates
  ) AS signatures;
  IF (SELECT COUNT(*) FROM account_ozon_shared_categories)<>expected_shared
    OR (SELECT COUNT(*) FROM account_ozon_shared_category_events)<>expected_shared
  THEN
    RAISE EXCEPTION 'category migration shared/event count validation failed' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM account_ozon_shared_categories AS shared
      LEFT JOIN collect_ozon_category_source_evidence AS evidence
        ON evidence.account_id=shared.account_id AND evidence.id=shared.source_evidence_id
     WHERE evidence.id IS NULL
        OR shared.current_description_category_id<>shared.source_description_category_id
        OR shared.current_type_id<>shared.source_type_id
        OR shared.status<>'ACTIVE' OR shared.source<>'SOURCE_DIRECT'
  ) THEN
    RAISE EXCEPTION 'category migration tenant/signature validation failed' USING ERRCODE='23514';
  END IF;
END;
$$;

DROP TABLE collect_category_resolution_runtime_cursors;
DROP TABLE collect_category_resolutions;
DROP FUNCTION account_shared_category_positive_bigint(TEXT);
