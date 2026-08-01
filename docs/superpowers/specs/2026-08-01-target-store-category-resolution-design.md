# Target Store Category Resolution Design

## Goal

Preserve the source Ozon category evidence captured by the browser extension, then resolve and validate the numeric `type_id` against the selected operating store's current Ozon category tree before listing. A failed or ambiguous match must remain pending instead of writing a guessed platform category.

## Confirmed Business Rules

- Collection remains account-scoped and does not require an operating store.
- The extension captures source product facts only; it does not select a target store or trigger synchronization.
- Target category resolution starts only after an operating store is selected in Web.
- A numeric source type candidate is accepted only when it exists in the selected store's real Ozon category tree.
- Text matching may use exact or normalized equality only. Partial, stem-only, AI, and fixed-code guesses are not accepted for automatic listing.
- No match and multiple matches are recoverable pending states. The source evidence remains stored and the user may select a leaf category manually.
- Category resolution must be traceable to its source evidence, target store, match method, and resolution time.

## Current Failure

The Seller `/api/v1/search` response provides `description_type_dict_value`. The extension normalizes it into attribute `8229.dictionary_value_id`, and the import normalizer already knows how to validate that candidate against the target store tree. The Collector agent's product projection currently retains only `key`, `value`, and `collection`, so it drops `dictionary_value_id` before the result reaches Web. The backend then falls back to type-name matching and the collected item can remain at `description_category_id: <value> / type_id: —`.

## Approaches Considered

### 1. Preserve source evidence and resolve in Web/backend — selected

Keep the account-level collection store-neutral. Preserve the safe category fields across the Collector boundary, validate the numeric candidate against the target store tree, and expose a resolution record to the Web draft.

This follows the existing architecture, has a stable contract, and avoids guessing or binding collection to a store.

### 2. Make the extension assign the final `type_id`

Rejected because collection does not yet have a target operating store. A value valid for one store or category-tree version must not be treated as authoritative for another target.

### 3. Infer the target category from product text or AI

Rejected because category choice is a platform-critical listing rule. A plausible category name is not sufficient evidence for a numeric Ozon `type_id`.

## Architecture

### Extension capture boundary

`collector-ozon-enrichment-agent.js` continues to project a minimal allowlisted product payload. The attribute projection adds only a canonical positive `dictionary_value_id`; it still rejects arbitrary nested values and portal/account metadata. The category projection retains only `id`, `level`, `name`, and `title` for source-path display.

No account ID, store ID, Seller company ID, cookie, URL control field, or credential may cross this boundary.

### Enrichment contract

The existing additive `collector.ozon.enrichment.v1` response remains compatible. `variantData` may now retain:

```json
{
  "description_category_id": 17039736,
  "attributes": [
    {
      "key": "8229",
      "value": "Заварочный чайник",
      "dictionary_value_id": 123456
    }
  ],
  "categories": [
    { "id": 17039736, "level": 3, "name": "Заварочный чайник", "title": "Заварочный чайник" }
  ]
}
```

The fields are optional for backward compatibility. Category ID and logistics remain the only required enrichment fields.

### Target-store resolver

`ozon-import-normalizer.mjs` produces both the normalized listing item and a parallel category-resolution record.

Resolution priority:

1. Validate an explicit top-level `type_id` in the target store tree.
2. Validate `8229.dictionary_value_id` in the target store tree.
3. Within the source `description_category_id`, accept exactly one type whose name is byte-for-byte equal to the source type name.
4. Accept exactly one type whose normalized name is equal after case, whitespace, and punctuation normalization.
5. Otherwise return a pending result. Do not use partial or stem matching for automatic collection editing.

The selected candidate determines both target `description_category_id` and target `type_id`; a source category ID is not allowed to override the parent category returned by the validated target-tree leaf.

### Resolution record

Preview returns an additive `categoryResolution` object:

```json
{
  "status": "MATCHED",
  "method": "DICTIONARY_VALUE_ID",
  "source": {
    "descriptionCategoryId": 17039736,
    "typeName": "Заварочный чайник",
    "typeIdCandidate": 123456,
    "path": ["家用电器", "Заварочный чайник"]
  },
  "target": {
    "storeId": "store-id",
    "descriptionCategoryId": 17039736,
    "typeId": 123456
  },
  "resolvedAt": "2026-08-01T00:00:00.000Z"
}
```

Pending responses use `status: "PENDING"`, omit target category IDs, and provide one stable reason: `SOURCE_TYPE_MISSING`, `TARGET_TYPE_NOT_FOUND`, or `TARGET_TYPE_AMBIGUOUS`. Raw platform errors and credentials are never returned.

The Web listing draft stores this record. Switching the target store clears the previous target resolution and starts a new store-scoped preview.

## Web Experience

The category section shows two distinct states:

- Source category: captured source ID, readable type name, and path when available.
- Target-store category: matching, matched with numeric IDs, pending manual selection, or unavailable because the real category tree could not be read.

The existing category cascader remains the manual recovery path. Manual selection writes `method: "MANUAL"` with the selected store and IDs.

The UI must not label source capture as failed merely because target-store matching is pending.

## Error Handling

- Missing source category evidence: keep the collection item and show `SOURCE_TYPE_MISSING`.
- Target tree unavailable: show the existing retry control and do not mutate the draft category.
- Candidate absent in target tree: show pending manual selection.
- Multiple exact normalized matches: show pending manual selection.
- Store switch during a request: discard the stale response using the existing request-scope guard.
- Repeated preview: read-only and idempotent; no Ozon product or bundle write is performed.

## Security and Data Boundaries

- Target-store tree reads continue to resolve account and store on the backend.
- The client-supplied store header is validated by existing account/store request context.
- Collector requests remain store-neutral and cannot carry account or store scope.
- Only allowlisted product category fields cross the Collector boundary.
- Logs and audit records may contain category IDs and match methods, but not cookies, Seller company IDs, tokens, or raw portal responses.

## Persistence and Compatibility

- No database schema migration is required because collection records and listing drafts already store JSON data.
- Existing collected items without dictionary IDs remain readable and may use exact name matching or manual selection.
- Existing listing drafts with valid category IDs retain them until the user changes the target store.
- The enrichment contract change is additive and keeps version `collector.ozon.enrichment.v1`.

## Tests

- Agent projection preserves a positive `dictionary_value_id` and safe category path fields while rejecting nested/credential-shaped data.
- Enrichment contract preserves the additive category evidence without changing required-field validation.
- Target resolver validates a dictionary candidate against the selected store tree.
- Target resolver rejects a candidate absent from the selected store tree.
- Exact and normalized text matches succeed only when unique.
- Partial, stem-only, and ambiguous matches remain pending for the collection-edit policy.
- Preview exposes a safe resolution record; submission continues to send only normalized Ozon item fields.
- Switching stores discards stale resolution and triggers a store-scoped preview.
- Web renders source and target states separately and persists manual/matched resolution metadata.
- Existing account isolation, category readiness, multivariant, Collector, extension parity, and full verification suites remain green.

## Rollout and Rollback

The change is backward-compatible and requires rebuilding the unpacked extension and both ZIP artifacts. Rollback consists of reverting the additive projection, resolver metadata, and UI rendering together; no stored record or database migration needs reversal. Existing source category data remains usable after rollback.
