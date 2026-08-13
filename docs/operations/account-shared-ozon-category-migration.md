# Account-shared Ozon category migration runbook

## Scope and safety boundary

This runbook covers the forward-only migration from retired store/collect-item category matches to immutable collected source evidence and one account-shared Ozon category state. The tested migration chain is **001–069**. Migration 063 performs the destructive replacement; 064 adds lookup/manual-confirmation evidence; 065–069 close lease, graph handoff, recovery-attempt, corrected-item, and recovery-child-result contracts.

The authoritative tested implementation SHA is recorded in `docs/verification/2026-08-12-account-shared-ozon-category-recovery.md`. Deploy only that exact SHA (or a separately reverified descendant) with the matching 001–069 migration set.

> Production automatic category recovery is disabled. The V1 production structured-error allowlist is intentionally empty. The E2E proof uses a clearly labelled, test-only historical evidence fixture inserted only into disposable PostgreSQL. Do not copy that fixture or create an evidence-injection route in production.

## Maintenance window: stop list

Before backup or migration, stop and verify quiescence of:

1. HTTP/API instances that create or mutate collection, auto-listing, submission, category-confirmation, or warehouse records.
2. Listing, auto-listing AI, reconciliation, outbox, cleanup, and category-recovery workers.
3. Scheduled collection/enrichment/category refresh jobs.
4. Any ad-hoc importer, replay script, or administrator session that can write these tables.

Do not proceed while any write-capable old-code process remains connected. Record the maintenance start, deployed SHA, database identity, operator, and correlation/change ticket in the operations log.

## Backup without embedded credentials

Supply credentials through the approved secret manager or `.pgpass`; never paste them into this document, shell history, CI logs, or tickets.

```bash
export DATABASE_URL='provided-by-secret-manager'
export BACKUP_PATH='/approved-encrypted-backup/account-shared-category-pre-upgrade.dump'
pg_dump --format=custom --no-owner --no-privileges --file "$BACKUP_PATH" "$DATABASE_URL"
pg_restore --list "$BACKUP_PATH"
```

Restore rehearsal must target a second disposable or approved recovery database, never the developer or production database:

```bash
export RESTORE_DATABASE_URL='provided-by-secret-manager-for-empty-restore-target'
pg_restore --no-owner --no-privileges --dbname "$RESTORE_DATABASE_URL" "$BACKUP_PATH"
```

Restore verification checklist:

- the backup command exited zero and the file is non-empty;
- `pg_restore --list` exits zero;
- the restore target is a distinct empty database;
- pre-upgrade `collect_category_resolutions` and `collect_category_resolution_runtime_cursors` are readable in the restored database;
- source payloads, drafts, audit events, current jobs, submission events, and account/store ownership counts match the source snapshot;
- the pre-upgrade application SHA can perform its read-only category query against the restored database;
- no external Ozon, AI, object-storage, inventory, or stock write is executed during rehearsal.

## Preflight before migration 063

Run these read-only checks in the maintenance window. Any returned row is a stop condition that requires correcting the source record or restoring a known-good snapshot; never infer replacement category IDs from retired target matches.

Build the same raw-fact set that migration 063 reads. This includes every product draft (not only
the current draft), all four canonical draft paths, and every completed enrichment-cache row:

```sql
WITH product_draft_facts AS (
  SELECT item.account_id,'PRODUCT_DRAFT'::text AS source_kind,draft.id AS source_record_id,
         draft.version::text AS source_version,item.id AS collect_item_id,
         raw.account_id AS raw_account_id,raw.collect_item_id AS raw_collect_item_id,
         raw.payload_hash AS raw_hash,raw.id AS raw_ref,
         COALESCE(raw.collected_at,raw.created_at) AS captured_at,fact.canonical_path,
         fact.category_json
    FROM product_drafts AS draft
    JOIN collect_items AS item ON item.id=draft.collect_item_id
    LEFT JOIN collect_raw_payloads AS raw ON raw.id=draft.source_payload_id
    CROSS JOIN LATERAL (
      SELECT 'data.sourceCategory'::text,draft.data->'sourceCategory'
      UNION ALL
      SELECT 'data.variants[].sourceCategory',variant.value->'sourceCategory'
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(draft.data->'variants')='array'
          THEN draft.data->'variants' ELSE '[]'::jsonb END) AS variant(value)
      UNION ALL
      SELECT 'data.listingDraft.sourceCategory',draft.data->'listingDraft'->'sourceCategory'
      UNION ALL
      SELECT 'data.listingDraft.variants[].sourceCategory',variant.value->'sourceCategory'
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(draft.data->'listingDraft'->'variants')='array'
          THEN draft.data->'listingDraft'->'variants' ELSE '[]'::jsonb END) AS variant(value)
    ) AS fact(canonical_path,category_json)
   WHERE fact.category_json IS NOT NULL AND fact.category_json<>'null'::jsonb
), enrichment_facts AS (
  SELECT cache.account_id,'ENRICHMENT_CACHE'::text AS source_kind,
         cache.source||':'||cache.sku||':'||cache.contract_version AS source_record_id,
         COALESCE(NULLIF(cache.response_hash,''),cache.contract_version) AS source_version,
         NULL::text AS collect_item_id,NULL::text AS raw_account_id,NULL::text AS raw_collect_item_id,
         cache.response_hash AS raw_hash,
         'collector_ozon_enrichment_cache:'||cache.source||':'||cache.sku||':'||cache.contract_version AS raw_ref,
         cache.captured_at,NULL::text AS canonical_path,cache.result_json->'sourceCategory' AS category_json
    FROM collector_ozon_enrichment_cache AS cache
   WHERE cache.status='COMPLETE' AND cache.result_json->'sourceCategory' IS NOT NULL
     AND cache.result_json->'sourceCategory'<>'null'::jsonb
), raw_facts AS (
  SELECT * FROM product_draft_facts UNION ALL SELECT * FROM enrichment_facts
)
SELECT * FROM raw_facts
 WHERE jsonb_typeof(category_json)<>'object'
    OR ((category_json?'descriptionCategoryId')
      AND NULLIF(BTRIM(category_json->>'descriptionCategoryId'),'') IS NOT NULL
      AND NOT CASE WHEN category_json->>'descriptionCategoryId' ~ '^[1-9][0-9]*$'
        THEN (category_json->>'descriptionCategoryId')::numeric<=9223372036854775807 ELSE false END)
    OR ((category_json?'typeIdCandidate')
      AND NULLIF(BTRIM(category_json->>'typeIdCandidate'),'') IS NOT NULL
      AND NOT CASE WHEN category_json->>'typeIdCandidate' ~ '^[1-9][0-9]*$'
        THEN (category_json->>'typeIdCandidate')::numeric<=9223372036854775807 ELSE false END)
    OR (source_kind='PRODUCT_DRAFT'
      AND category_json->>'descriptionCategoryId' ~ '^[1-9][0-9]*$'
      AND category_json->>'typeIdCandidate' ~ '^[1-9][0-9]*$'
      AND (raw_account_id IS DISTINCT FROM account_id
        OR raw_collect_item_id IS DISTINCT FROM collect_item_id))
    OR (category_json->>'descriptionCategoryId' ~ '^[1-9][0-9]*$'
      AND category_json->>'typeIdCandidate' ~ '^[1-9][0-9]*$'
      AND (raw_hash IS NULL OR LOWER(raw_hash)!~'^[0-9a-f]{64}$'
        OR NULLIF(BTRIM(raw_ref),'') IS NULL OR captured_at IS NULL));
```

Cross-account legacy ownership conflicts:

```sql
SELECT resolution.id,resolution.account_id,item.account_id AS item_account_id,resolution.collect_item_id
  FROM collect_category_resolutions AS resolution
  JOIN collect_items AS item ON item.id=resolution.collect_item_id
 WHERE resolution.account_id<>item.account_id;
```

Using the same `raw_facts` CTE above, source identities that disagree on category signature are a
stop condition (run this in the same statement by replacing the final `SELECT`):

```sql
SELECT account_id,source_kind,source_record_id,source_version,
       COUNT(DISTINCT (category_json->>'descriptionCategoryId')||':'||
         (category_json->>'typeIdCandidate')||':OZON:DEFAULT') AS signatures
  FROM raw_facts
 WHERE category_json->>'descriptionCategoryId' ~ '^[1-9][0-9]*$'
   AND category_json->>'typeIdCandidate' ~ '^[1-9][0-9]*$'
 GROUP BY account_id,source_kind,source_record_id,source_version
HAVING COUNT(DISTINCT (category_json->>'descriptionCategoryId')||':'||
         (category_json->>'typeIdCandidate')||':OZON:DEFAULT')>1;
```

Also verify every admissible product-draft source has a same-account/same-item raw payload reference, a lowercase 64-hex payload hash, and a capture time. Confirm sufficient disk space, no long-running write transaction, no failed migration row, and the exact tested code/migration checksums.

## Apply and verify 063–069

Run the repository migration command once with the approved deployment environment. Stop immediately on any non-zero result. Do not manually mark a failed migration as applied.

Expected behavior:

- 063 derives evidence/shared rows only from canonical product-draft or completed enrichment-cache source facts;
- retired `collect_category_resolutions` and `collect_category_resolution_runtime_cursors` are dropped;
- conflicting old target IDs are not copied;
- audit, job, submission, raw payload, draft, and enrichment history remains;
- 064 adds exact read-only lookup evidence/current pointers/manual-confirmation audit;
- 065–067 add preparation lease and graph/replay closure;
- 068 adds one immutable category recovery attempt/corrected-item contract;
- 069 adds append-only, tenant-bound retry child results without rewriting original failed submission items.

Integrity queries after migration:

```sql
SELECT to_regclass('collect_category_resolutions') AS retired_matches,
       to_regclass('collect_category_resolution_runtime_cursors') AS retired_cursors;

SELECT COUNT(*) AS evidence_rows FROM collect_ozon_category_source_evidence;
SELECT COUNT(*) AS shared_rows FROM account_ozon_shared_categories;
SELECT COUNT(*) AS event_rows FROM account_ozon_shared_category_events;

SELECT account_id,source_description_category_id,source_type_id,taxonomy_scope,COUNT(*)
  FROM account_ozon_shared_categories
 GROUP BY account_id,source_description_category_id,source_type_id,taxonomy_scope
HAVING COUNT(*)<>1;

SELECT shared.id
  FROM account_ozon_shared_categories AS shared
  LEFT JOIN collect_ozon_category_source_evidence AS evidence
    ON evidence.account_id=shared.account_id AND evidence.id=shared.source_evidence_id
 WHERE evidence.id IS NULL;

SELECT event.id
  FROM account_ozon_shared_category_events AS event
  LEFT JOIN account_ozon_shared_categories AS shared
    ON shared.account_id=event.account_id AND shared.id=event.shared_category_id
  LEFT JOIN collect_ozon_category_source_evidence AS evidence
    ON evidence.account_id=event.account_id AND evidence.id=event.source_evidence_id
 WHERE shared.id IS NULL OR evidence.id IS NULL;
```

Both `to_regclass` values must be null. All duplicate/orphan queries must return zero rows. Compare protected-table counts and sentinel audit/job identifiers with the preflight snapshot.

## Safe smoke tests and resume order

While outbound writes remain blocked:

1. Start one API instance with workers disabled.
2. Verify a collection row shows source/shared/manual category state and no store-category wording.
3. Verify two stores in the same account reuse the same shared category row while credentials, currency, warehouse, inventory, permissions, and submission links remain store-scoped.
4. Verify another account cannot read or confirm that row.
5. Verify ordinary task lists show only the latest row per product/store, use the persisted creation time, and historical detail remains readable.
6. Verify unresolved source category performs only the exact read lookup and stops before AI/product/stock writes.
7. Verify fixed safe Chinese copy is shown; raw platform text must not be rendered.

Resume in this order: read-only API traffic, collection/enrichment, ordinary background jobs, listing reconciliation/outbox, listing workers, then administrative confirmation. Monitor error rates, state transitions, outbox depth, reconciliation backlog, account-boundary denials, and database constraints after each step. Automatic production category recovery remains disabled until a separately authorized structured policy version is implemented and verified.

## Rollback and external reconciliation

There is no reverse-SQL rollback. Migration 063 deletes store-scoped records and **reverse SQL cannot reconstruct them**.

If rollback is required:

1. Stop all API instances, workers, schedules, imports, replays, and administrator writes again.
2. Record the failed deployment SHA, migration reached, database time, and all potentially submitted Ozon task/offer IDs.
3. Restore the verified pre-upgrade database backup into the approved production database according to the database recovery procedure.
4. Deploy the matching pre-upgrade application SHA.
5. Before replay, reconcile every external Ozon product/import/stock operation that may have occurred after the backup. Unknown or response-loss outcomes stay on the existing reconciliation/manual-review path; never blindly resubmit.
6. Resume in the safe order above and retain the failed database snapshot for investigation under the data-retention policy.

Do not attempt to merge new shared rows back into the restored old schema, and do not guess deleted legacy target IDs.
