# Final review fix 1 — manual confirmation after unresolved lookup

Date: 2026-08-13

## Reviewed defect and business goal

The review is technically valid. An exact lookup that returns `UNRESOLVED` intentionally writes no lookup evidence, but administrator confirmation currently requires a current evidence row and therefore returns `OZON_CATEGORY_CONFIRMATION_ITEM_NOT_FOUND`. The desired flow is:

1. keep unresolved lookup at zero writes;
2. accept only the existing closed administrator request with exact account, item, current draft/version, idempotency and correlation scope;
3. in one JSON commit or PostgreSQL transaction append a new immutable `MANUAL_CONFIRMATION` observation, CAS the item's current-source pointer, create/activate an account-shared `MANUAL` selection and append transition/audit records;
4. exact response-loss replay returns the same evidence/shared version and writes nothing;
5. another store in the same account reuses the selection through the account-shared signature.

Old source evidence and events remain append-only. Existing rows created by the earlier manual-transition implementation remain readable; no new request may rewrite or impersonate `PRODUCT_DRAFT` or `OZON_READ_LOOKUP` evidence.

## Closed provenance contract

`MANUAL_CONFIRMATION` is a fourth source kind. Its private observation binds:

- account and collect item;
- the collect item's exact current product draft ID and positive version;
- selected description-category ID, type ID and `OZON:DEFAULT` scope;
- administrator actor ID;
- canonical confirmation time;
- exact correlation ID and idempotency key;
- fixed contract version and lowercase request hash.

The observation identity is a SHA-256 over the ordered closed fields. Evidence source record/reference and version use fixed `manual-confirmation:v1:<hash>` forms. No credential, raw request, vendor error or arbitrary payload is stored or returned publicly.

## Schema amendment

Add migration `070_account_shared_ozon_category_manual_confirmation_evidence.sql`; do not edit published 063/064. It will:

- extend source/current-pointer checks with `MANUAL_CONFIRMATION`;
- add an append-only manual-observation table with tenant/item/draft/evidence composite foreign keys and unique account/idempotency replay identity;
- bind the existing confirmation audit to the new evidence while retaining old nullable-compatible rows;
- preserve parent-cleanup cascades while direct update/delete remains SQLSTATE `23514`.

## TDD and acceptance

RED must reproduce the real chain in JSON, route/composition and disposable PostgreSQL: missing source IDs → exact lookup unresolved → administrator confirmation → second-store reuse. It must also prove stale draft, ordinary user, cross-account, conflicting replay and hostile carrier paths write zero rows; response-loss replay returns the same evidence/version; direct mutation is `23514`.

GREEN must use migrations 001–070 with zero skip, retain current public DTO shapes, and leave production category-error policy V1 unchanged and disabled.

## File boundary

Expected production boundary: contract, repository, runtime, additive 070 migration, and only the focused existing tests/migration tests needed to prove the chain. Route/UI DTO names and payload fields must not change.
