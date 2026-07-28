# Ozon category query extraction — final handoff

Date: 2026-07-28 (Asia/Shanghai)

Work item: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`

State: implemented, complete engineering validation passed, and final
independent review approved (`Ready: Yes`, `Critical: 0`, `Important: 0`).

Target: `/Users/songliang/Documents/sonli ozon3.0`

Recovery commit: `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`

## Outcome

- Category tree, category attributes and dictionary values now have a focused
  real-Ozon-only service and an authenticated HTTP route boundary.
- Successful real Ozon responses may be reused only through an
  account/store/language/query-scoped in-memory cache whose TTL is capped at
  six hours. Expired data is never used after a failed refresh.
- Local synchronized products, other stores, historical tasks and collection
  data can no longer infer a category tree or `description_category_id`.
- Category-service failures are fixed, redacted, non-success errors. They
  cannot be converted into a successful empty list.
- Caller IDs are validated as positive integers before cache or Ozon access;
  invalid input fails safely with 400, and a valid type absent from the real
  tree fails safely with 422. Successful response IDs remain numeric.
- Preview and final listing normalization consume the shared service.
  Unavailable required category/dictionary data stops snapshot, task and
  external-write creation.
- The app requires independent non-empty Chinese and Russian real trees,
  prevents stale store/item responses from being consumed, shows a retryable
  error and blocks category-dependent actions until ready.
- Dictionary requests have a focused store/item/category/type/attribute/request
  scope. Failures and malformed 2xx shapes remain visible and not ready;
  explicit successful `items: []` or `data: []` remains a valid empty result.
- The extension wizard has one readiness owner, revalidates restored drafts
  with current real tree and attribute data, and rejects stale
  store/tree/category/request continuations before publish.

## Stable contracts and ownership

- `server/ozon-category-service.mjs` owns Ozon category reads, response
  validation, pagination, deduplication, type resolution, cache isolation and
  provenance.
- `server/ozon-category-routes.mjs` owns exact path matching, backend
  authentication, account/store ownership validation and HTTP mapping.
- Within the category flow, `server/index.mjs` owns only composition and
  downstream service injection.
- Existing successful category paths retain `data`, `items` and `total`.
  `meta.source`, `meta.fetchedAt` and `meta.expiresAt` are additive.
- Stable category failures use an allowlisted code, safe non-2xx status,
  fixed user-facing message, operation metadata and `cause: null`.
- `app/src/category-readiness.js` and
  `app/src/use-category-tree-readiness.js` own tree/action readiness.
- `app/src/use-category-dictionary-readiness.js` owns dictionary response
  validation, request scope, stale completion rejection, retry and readiness.
- `extension/lib/category-readiness.js` owns extension readiness and
  immutable action-scope checks.

## Files and contract areas changed

Primary production boundary:

- `server/ozon-category-service.mjs`
- `server/ozon-category-routes.mjs`
- `server/index.mjs`
- `app/src/category-readiness.js`
- `app/src/use-category-tree-readiness.js`
- `app/src/use-category-dictionary-readiness.js`
- `app/src/App.jsx`
- `extension/lib/category-readiness.js`
- `extension/content/1688-ai-wizard.js`
- `extension/manifest.json`

Focused tests and permanent guards:

- `server/tests/ozon-category-service.test.mjs`
- `server/tests/ozon-category-routes.test.mjs`
- `server/tests/category-listing-readiness.test.mjs`
- `server/tests/cache-route-isolation.test.mjs`
- `server/tests/module-boundaries.test.mjs`
- `app/tests/category-readiness.test.mjs`
- `app/tests/category-dictionary-readiness.test.mjs`
- `extension/tests/category-readiness.test.js`

Contracts, documentation and generated extension artifacts:

- `scripts/check-extension-source-parity.mjs`
- `scripts/check-extension-diff-contract.mjs`
- `scripts/check-collect-edit-listing-contract.mjs`
- `docs/architecture/module-boundaries.md`
- `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`
- `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`
- `app/public/sonli-extension-0.13.46.1/`
- `app/public/sonli-extension-0.13.46.1.zip`
- `app/dist/sonli-extension-0.13.46.1.zip`

No database table, migration, runtime dependency, lockfile, environment,
Docker or deployment change was made by this work package.

## AGENTS.md review

### Code structure

- Category query behavior is separated from HTTP routing and entry
  composition. The service has no business-state or response dependency;
  routes have no cache, pagination or fallback implementation.
- `server/index.mjs` is 5183 lines, below its 5200 guard.
  `app/src/App.jsx` is 9838 physical lines and remains below the unchanged
  9850 guard. The app readiness state machine is extracted into focused
  executable modules.
- Permanent module tests reject legacy category function declarations and
  locally inferred category responses.

### Business correctness

- Tree and attribute response shapes, both supported language trees,
  dictionary pagination, continuation cursors, deduplication, limits,
  required dictionary values, cache expiry, failure atomicity and stale
  response rejection have executable coverage.
- Numeric HTTP compatibility, invalid-ID zero-call behavior, missing-type
  422 behavior, dictionary retry, authentic empty values and malformed-2xx
  rejection have executable coverage.
- Preview and final listing tests verify that category failure stops before
  `createSubmissionV3`, local job creation and external writes.
- No Ozon platform rule was guessed. The implementation deliberately retains
  the project's current `/v1/description-category/*` contract pending a
  separate official-version/permission check.

### Security and data

- Authentication and store ownership are enforced by the backend before a
  category call and revalidated after asynchronous category resolution.
- Cache keys include collision-proof account, store, language and query
  dimensions. App and extension continuations also reject cross-store or
  stale scope.
- Category errors do not include upstream bodies, credentials, API keys,
  raw causes or production payloads.
- The category flow is read-only. External-write safety tests confirm no
  publish side effect occurs on failed readiness.

### Engineering delivery

- Existing successful HTTP response fields remain compatible and provenance
  is additive.
- Focused unit/contract/integration tests cover the changed modules and their
  direct preview, listing, UI, extension, account/store and sync consumers.
- The complete production build, extension parity/package smoke, PostgreSQL
  integration, whitespace and credential checks pass.
- Recovery is file-scoped and does not require destructive Git or data
  rollback.

## Validation evidence

### Changed modules

All originally planned changed-module commands passed, plus the final-review
dictionary and ID compatibility regressions:

1. Ozon client.
2. Category service.
3. Category routes.
4. Category listing readiness.
5. Real-entry cache/route isolation.
6. Import preview route.
7. Import currency contract.
8. Collect listing failure containment.
9. External-write safety.
10. Account/store isolation.
11. Module boundaries.
12. App category readiness: 9/9.
13. Prototype style contract: 15/15.
14. Extension category readiness.
15. App dictionary readiness: 5/5.

### Protected completed behavior

The Ozon sync service, account/device lease isolation, account/store
ownership, external-write safety and operating-store data isolation checks
all passed.

### Complete engineering gate

Command:

```text
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify.mjs
```

Fresh final result:

- 19/19 verification checks passed.
- Test inventory: 78 active files and 9 historical/manual files.
- Complete active suite: 116 passed, 0 failed, 0 skipped.
- Vite production build passed.
- Extension source/UI/exact-diff parity passed.
- Both 94-file extension ZIPs matched the source tree and passed packaged
  bridge/dry-run smoke tests.
- PostgreSQL integration, Docker Compose interpolation, module/contract
  checks, whitespace check and credential-literal scan passed.
- Vite retained its non-blocking advisory that the main JavaScript chunk is
  larger than 500 kB; bundle splitting is outside this category work item.

The first complete gate stopped at an obsolete source-pattern check. The
page still searched collect-box then product caches, but now called the
untrusted result `candidateItem` and admitted it only after store-scope
validation. Formal listing also gained an authentic-category readiness
condition. `scripts/check-collect-edit-listing-contract.mjs` was updated to
require both protections. Its focused rerun and the fresh full gate passed.

The first independent review then found three Important issues: numeric ID
compatibility, invalid/missing ID handling and App dictionary readiness.
Fix round 1 restored numeric responses, added pre-call 400/real-tree 422
failures, and introduced scoped visible dictionary readiness. Its scoped
review found one residual malformed-2xx empty fallback. Fix round 2 extracted
and tested the response adapter so only explicit arrays are accepted.
The final scoped review reported `Ready: Yes`, `Critical: 0`, `Important: 0`;
the 116-test complete gate above was run fresh after that source result.

## Scope and external effects

- Baseline: dirty `main`, 180 status entries, no staged files.
- Final: 191 status entries. The 11 newly visible entries are exactly the
  modified `extension/content/1688-ai-wizard.js` plus ten new category
  implementation/test modules listed by the status comparison.
- Pre-existing dependency, lockfile, migration, environment, Docker and
  deployment changes retain timestamps from before this work package and
  were not altered by it.
- No file was staged or committed. No branch, stash, rebase, push, reset or
  checkout was performed.
- No real Ozon request, real account operation, production publish, inventory
  update, price change, data deletion or production write occurred.
- The local `sonli-postgres` container was started only for tests and is
  restored to `Exited (0)`.

## Unverified areas and risks

- The real Ozon endpoint version, current official contract and production
  account permissions were intentionally not verified with live credentials.
- Real-network rate limiting, retry hints and live payload variations remain
  unverified; no live call was authorized.
- Manual browser interaction in the app and extension remains unverified.
  Executable readiness behavior, production build and packaged smoke tests
  cover the automated portion.
- The six-hour cache is intentionally process-local. Cross-process persistence
  or shared cache invalidation is not part of this design.
- The app bundle-size advisory is unchanged in nature and not addressed here.

## Recovery and rollback

- Do not use `git reset --hard`, checkout, stash or broad cleanup in this
  dirty worktree.
- Existing planned files can be restored individually from
  `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/`.
  Task-specific snapshot directories preserve the state before each change
  and review fix.
- Final-review fixes have exact recovery points in
  `snapshots/task-10-fix-r1-before/` and
  `snapshots/task-10-fix-r2-before/`.
- Remove only the new category modules/tests listed in this report if the
  entire work item is abandoned.
- After restoring the Task 8 extension source/manifest/contract snapshot,
  rerun the existing extension packaging command to regenerate the unpacked
  tree and both ZIPs.
- The recovery commit remains
  `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`, but broad Git restoration must
  not be used because unrelated user changes predate this work.
- No database or external-system rollback is required.

## Next safe action

Before enabling a real store, separately verify the current official Ozon
endpoint/version and that store's production permissions, then run a
user-approved read-only live category smoke. Manual app/extension browser
interaction can be checked in the same separately authorized acceptance pass.
