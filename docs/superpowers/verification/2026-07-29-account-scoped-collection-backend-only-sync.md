# Account-Scoped Collection and Backend-Only Sync Verification

- Verification date: 2026-07-30
- Verified implementation head: `293b8b8`
- Overall status: **PASS WITH EXPLICIT BROWSER-PROFILE GAPS**
- Automated gate status: **PASS**
- Disposable PostgreSQL 16 status: **PASS**
- Browser-profile status: **PARTIAL — one isolated Web flow passed; the real
  extension profile was explicitly blocked because the target extension was not
  loaded**

This is a final verification record. It does not claim a complete real-extension
profile pass: each blocked browser check and its supplemental evidence are
recorded explicitly below.

## Delivered change

The implementation changes collection ownership and synchronization around four
stable boundaries:

1. Collector authentication derives account and permission scope on the server.
   One-use tickets expire after 60 seconds; collector sessions hold exactly
   `collector.upload`, `collector.job.read`, and `collector.config.read`, and are
   capped by the parent Web session and an eight-hour maximum.
2. New collection writes are account-owned and store-neutral. The authenticated
   account, stable source identity, request identity, and content hash control
   authorization and idempotency. Caller-provided account/store scope is rejected.
3. Listing preparation requires and freezes an account-owned target operating
   store. Later current-store changes do not retarget an accepted submission.
4. Web store sync is backend-only. The extension retains visible-page collection
   and Collector upload behavior but has no Seller API synchronization module,
   message, alarm, permission, or independent account-login UI.

Runtime data-collection-store pages, APIs, filters, and blocking rules are retired.
Historical tables, columns, and trusted `legacyScope` projections remain read-only
for migration, audit, privacy deletion, and rollback evidence.

## Stable contracts and changed modules

### Database and ownership

- Migration
  `server/db/migrations/019_account_scoped_collection_and_collector_sessions.sql`
  adds collector ticket/session storage, fail-closed ownership backfills,
  account-scoped indexes, and nullable collection-stage store references without
  dropping historical data-store evidence.
- Collection ownership is mandatory in `collect_items`,
  `collect_raw_payloads`, and `collect_requests`.
- Collection request identity is scoped by account, source, source SKU, and request
  key. The compatibility two-column request index remains during this rollout.

### Collector authentication and upload

- `server/collector-auth-service.mjs`,
  `server/collector-auth-repository.mjs`,
  `server/collector-auth-runtime.mjs`, and
  `server/collector-auth-routes.mjs` own ticket issue/exchange, scoped session
  authentication, revocation, persistence, and HTTP contracts.
- The extension stores collector tokens only in `chrome.storage.session`.
- `extension/background/collector-client.js` exposes fixed Collector actions rather
  than arbitrary credentialed transport.
- Collector queue mutations are serialized, account-qualified, retryable only for
  classified failures, and bound to immutable session snapshots.

### Account collection and listing

- `server/collection-pipeline.mjs`,
  `server/account-scoped-collection-routes.mjs`, and collector services enforce
  account ownership, store-neutral ingress, and account-scoped idempotency.
- `server/listing-pipeline.mjs` and
  `server/listing-submission-policy.mjs` validate and freeze the explicit target
  operating store and submission intent.
- Public collection projection removes retired runtime scope while retaining only
  trusted persisted historical evidence under `legacyScope`.

### Backend-only synchronization and retired capabilities

- `server/ozon-sync-service.mjs` owns typed backend synchronization, per-type
  result state, safe retry, audit, and same-process single-flight behavior.
- `app/src/store-sync-coordinator.js` calls backend routes for `WAREHOUSES`,
  `PRODUCTS`, `POSTINGS`, and `PROMOTIONS`; successful type results survive another
  type's failure and failed types can be retried independently.
- Extension Seller synchronization modules and old sync message/API contracts are
  removed. Old extension-only server routes return stable
  `410 EXTENSION_SYNC_REMOVED` without external calls or mutation.

### Runtime data-store retirement and history

- Runtime APIs return stable retirement responses and no user-facing or local-state
  data-store selection remains.
- `server/legacy-data-collection-store.mjs` migrates old JSON evidence into a
  private read-only archive and supports explicit account-scoped privacy purge.
- Relational historical data-store reads and purge require explicit account,
  reason, actor, time, transaction, counts, and audit.
- Generated extension artifacts under `app/public` and the ignored `app/dist` ZIP
  are exact packages of the reviewed source tree.

## Complete automated gate

The command was run with the bundled Node `v24.14.0`, pnpm `11.9.0`, the reviewed
upstream extension source, and disposable non-production Compose interpolation
values:

```bash
pnpm verify
```

Exit code: `0`.

All 19 top-level checks passed:

1. App build
2. Extension source parity
3. Extension UI parity
4. Extension diff contract
5. Extension ZIP parity
6. Extension ZIP bridge smoke
7. Server syntax
8. Test inventory
9. Complete active test suite
10. Docker Compose interpolation
11. Import history type filter
12. Plugin readiness gate
13. Collect edit listing contract
14. Collect box delete persistence
15. Operating store data isolation
16. Bridge syntax
17. Manifest JSON
18. Diff whitespace
19. Personal data and credential scan

Detailed results:

- App production build transformed 4,827 modules and completed successfully.
- Vite reported a non-failing warning that one minified chunk exceeds 500 kB.
- Test inventory: 116 active and 14 historical/manual tests.
- Complete active suite: 317 tests, 316 passed, 0 failed, 1 skipped.
- The one skip was explicitly
  `account-scoped collection PostgreSQL behavior — PostgreSQL is not configured`
  inside the general suite. It is not counted as a pass here; dedicated PostgreSQL
  verification is recorded below.
- Public and ignored dist extension ZIPs each matched the 102-file source tree.
- Both ZIPs passed packaged service-worker startup, Collector session 19/19,
  capture-only behavior 7/7, popup Collector-session runtime, popup routing, bridge
  smoke, and dry-run route guard.
- Plugin readiness independently passed capture-only behavior 7/7.
- No top-level check failed or was blocked.

## Explicit retirement and security scan

The required scan was run:

```bash
rg -n \
  "api-seller\\.ozon\\.ru|jzManualSync|sync\\.request|sync\\.response|tryWebSync|syncAuthFromWeb|dataCollectionStoreId|currentDataCollectionStoreId" \
  extension app/src server desktop
```

All 168 matches were classified:

- 125 test/fixture matches assert removal, rejection, sanitization, account
  isolation, or historical compatibility.
- 39 historical-only matches are confined to migration SQL, private legacy archive
  handling, trusted `legacyScope` projection, or desktop legacy-input
  sanitization. They do not select a runtime data store for new work.
- 3 runtime denylist matches reject or remove caller-supplied retired scope at
  account-collection, collector, and listing boundaries.
- 1 required backend-only match is the Seller API base in
  `server/ozon-client.mjs`. The Web/backend contract requires this server-side
  client; it is not present in extension runtime.

There were no matches in `app/src`, and no match in extension runtime code. No
retired runtime data-store or extension synchronization dependency was found.

`node scripts/check-personal-data.mjs` passed both during `pnpm verify` and as an
explicit standalone run.

## Disposable PostgreSQL 16 verification

A PostgreSQL 16 Alpine container was started with:

- no persistent volume;
- an automatically assigned loopback-only host port;
- a fresh dedicated database;
- disposable credentials used only for this verification.

No existing database, container, port, credential, development data, or production
data was inspected or reused.

### Migration evidence

Before migration:

- public tables: 0.

`pnpm db:migrate` exited `0` and applied all 20 migration versions through
`019_account_scoped_collection_and_collector_sessions`.

After migration:

- public tables: 53;
- applied migration rows: 20;
- `collect_items.account_id`: `NOT NULL`;
- `collect_raw_payloads.account_id`: `NOT NULL`;
- `collect_requests.account_id`: `NOT NULL`;
- `collect_items.store_id`: nullable;
- `collect_items.data_collection_store_id`: nullable;
- historical `data_collection_stores` table: present;
- account-scoped collection item and request indexes: present, including the
  four-column request identity index and compatibility idempotency index.

### Dedicated integrations

All required commands exited `0`:

```bash
node server/tests/collection-pipeline-v4.integration.mjs
# collection pipeline v4 integration passed

node server/tests/collector-desktop.integration.mjs
# collector desktop integration passed

node server/tests/listing-pipeline-v3.integration.mjs
# listing pipeline v3 integration passed
```

Observed ownership and recovery coverage includes:

- account A/B store-neutral collection, replay/conflict idempotency, cross-account
  read/delete isolation, nullable collection scope, ticket consumption, and
  account/session cascade behavior;
- account A/B desktop task, run, item, event, snapshot, mapping, export, pricing,
  and legacy-scope isolation;
- explicit account-owned listing target validation, foreign/missing target
  nondisclosure, credential-free target snapshots, frozen replay, concurrent
  idempotency, and route-level target isolation;
- migration fail-closed checks create deliberately unowned rows inside a
  transaction, require migration 019 to reject them, and execute `ROLLBACK` in
  `finally`.

After all integrations and their cleanup:

- accounts: 0;
- collection items: 0;
- raw payloads: 0;
- collection requests: 0;
- collector tasks: 0;
- historical data stores: 0;
- missing-owner rows: 0.

The disposable container was stopped and automatically removed. A final container
query returned no remaining Task 12 container.

## Browser-profile smoke status

### Environment and evidence boundary

- Feature worktree HEAD: `293b8b8`, including browser-discovered fixes
  `405e519` and `293b8b8`.
- Isolated stack: Web `http://127.0.0.1:3200`, API
  `http://127.0.0.1:3201`, and a fresh temporary JSON data directory with zero
  stores.
- Processes already listening on ports 3000 and 3001 belonged to the main
  repository's older runtime and were explicitly excluded from this verification.
- Controlled Chrome profile: `您的 Chrome`.
- After a fresh isolated Web login, `/extension` settled to
  `未连接 / 插件桥接未响应`. The target Sonli extension was therefore not loaded
  in that controlled profile.
- Browser security policy blocked inspection of `chrome://extensions`. The
  verifier did not bypass that policy or infer extension state from a different
  profile.

The statuses below distinguish direct browser evidence from supplemental
packaged-runtime and automated evidence. Supplemental evidence is not represented
as a real-extension-profile pass.

1. **BLOCKED — real extension profile.** The extension was absent, so the actual
   logged-out popup could not be opened. Supplemental browser evidence from the
   canonical packaged popup showed only `请先登录 Web 管理后台` and
   `前往登录/重新检查`, with no SMS or password input.
2. **BLOCKED — real extension profile.** The actual popup button could not be
   exercised. Supplemental packaged routing tests passed for the trusted exact
   `/login` destination. A normal static popup preview cannot execute
   `chrome.tabs`, so it was not used to claim interactive success.
3. **BLOCKED — real extension profile.** Ticket exchange through the actual
   extension could not be exercised. Supplemental isolated browser evidence
   passed a fresh Web administrator login on ports 3200/3201; ticket/runtime
   automation also passed and the canonical popup had no plugin password field.
4. **BLOCKED — extension absent.** Closing the Web page while retaining an actual
   extension Collector session could not be exercised.
5. **BLOCKED — real Ozon/1688 extension pages.** Actual page capture could not be
   exercised without the extension. Supplemental isolated browser evidence passed
   zero-store manual URL collection after `293b8b8`: `POST /ozon/collect-box`
   returned 200, the public response contained neither `storeId` nor
   `dataCollectionStoreId`, the browser collection count changed from 1 to 2, and
   a success toast appeared. Automated Ozon and 1688 capture contracts passed.
6. **BLOCKED — extension absent.** A real queued upload across account switching
   could not be exercised. Automated queue ownership and account-switch
   invalidation coverage passed.
7. **PASS — isolated browser and API.** A zero-store account collected an item.
   Its detail page showed `店铺与基础 未绑定`, the target-store combobox placeholder
   was `明确选择目标经营店铺`, the missing-field list included `上架店铺`, and preview
   and submit remained disabled. Direct backend preview and submit calls without a
   target both returned 422 `TARGET_STORE_REQUIRED`.
8. **BLOCKED — safe external-sync browser interaction unavailable.** The isolated
   account had no Ozon store or credentials, and no safe browser-level API mock was
   available. No fake or real Ozon call was sent. Supplemental backend-only
   coordinator and per-type retry tests passed; source/runtime scans found no
   extension synchronization path.
9. **BLOCKED — real extension profile.** The actual popup could not be inspected.
   The canonical packaged popup snapshot contained no synchronization button,
   status, or error, and `/extension` now labels the retained capabilities
   `Seller 页面采集桥` and `采集会话与上传调度`.
10. **BLOCKED — extension absent.** Browser restart could not exercise a real
    Collector session. The session-storage runtime automation passed.

The browser run found two defects and did not waive them:

- `405e519` replaced the stale Web extension preview with the reviewed
  capture-only packaged popup and updated the capability labels.
- `293b8b8` removed the stale bind-store gate from Web collection, made legacy Web
  single/scrape/batch writes account-owned and store-neutral, recursively removed
  caller scope, and retained explicit target-store validation for listing preview
  and submit.

Final browser conclusion: **PASS WITH EXPLICIT BROWSER-PROFILE GAPS**. The isolated
zero-store Web collection and listing boundary passed. Checks requiring the real
extension remain unverified for the exact reason that the target extension was not
loaded in the controlled profile and extension inspection was blocked by browser
security policy.

## Regression coverage

Automated coverage passed for:

- Web login/logout and account lifecycle revocation;
- one-use ticket and bounded scoped Collector session;
- session-only extension storage and account-switch races;
- Ozon and 1688 routing/capture contracts;
- account collection query, edit, delete, export, selection, and raw evidence;
- AI/category/pricing helpers used by the collection/listing workflow;
- target operating-store validation and safe listing submission;
- backend typed synchronization, partial failure, single-type retry, idempotency,
  and account isolation;
- retired extension/data-store routes returning fail-closed responses;
- extension source, manifest, UI, distributed directory, and both ZIPs;
- desktop collection contract, account isolation, Excel/export sanitization, and
  Seller analytics source identity.

The isolated zero-store Web UI flow passed. Real-extension popup/session behavior
and real-page capture remain explicitly blocked as recorded in the browser
section.

## Final repository and security review

At final verification:

- implementation HEAD was `293b8b8`;
- `git status --short` contained only this untracked verification document; the
  explicitly requested Task 12 ledger append remained under the SDD directory's
  existing ignore rule until precise forced staging;
- `git diff --check`: passed;
- `git diff --cached --check`: passed;
- implementation history through `293b8b8` was reviewed;
- the implementation range whitespace check passed;
- tracked personal-data and credential scan passed;
- no temporary database/container artifact remained.

This document contains no secret, disposable credential, personal filesystem path,
production endpoint credential, or copied browser token.

## Unverified scope and known risks

- The real Sonli extension was not loaded in the controlled Chrome profile.
  Consequently, checks 1–6 and 9–10 could not validate the actual popup,
  `chrome.tabs` routing, ticket exchange, retained/restarted Collector session,
  account-switch queue behavior, or Ozon/1688 page capture. Browser security
  policy also blocked direct `chrome://extensions` inspection, and this was not
  bypassed.
- Browser sync interaction was not exercised because the isolated account had no
  Ozon store or credentials and no safe browser-level API mock was available. No
  fake or real Ozon write was sent.
- No production database migration, deployment, production data check, or real
  Ozon external write was authorized or performed.
- Backend sync same-request single-flight is proven for one service process.
  Horizontal multi-process API deployment requires a separately reviewed
  PostgreSQL-backed atomic claim.
- The old two-column collection-request compatibility index remains intentionally
  stricter until all old runtimes are retired and a later migration is reviewed.
- Collector-auth PostgreSQL SQL shape and migration behavior are covered, but this
  Task 12 run did not add a new multi-process concurrent ticket-exchange load test.
- A deferred audit-quality issue remains: some collector audit entity IDs are
  prefixes derived from credential hashes. Secret text is not serialized, but a
  future cleanup should use independent entity IDs or omit them.
- A malformed ownerless archive record with an invalid archive key may contribute
  to a garbage account count. The record remains private and cannot retain
  confirmed-account evidence.
- The production app build retains the non-failing large-chunk warning noted above.

## Rollback and recovery

1. Revert application, server, desktop, and extension commits as one compatible
   release set; do not mix an old extension with incompatible retired backend
   endpoints.
2. Keep migration 019. It is additive, preserves historical evidence, and new
   collection rows depend on mandatory account ownership.
3. Restore the previous packaged extension together with compatible backend
   endpoints only after explicit approval. Re-enabling old Seller synchronization
   is a security and business-policy decision, not an automatic rollback step.
4. Regenerate tracked and ignored extension packages only through
   `pnpm package-extension`; never hand-edit generated copies or ZIPs.
5. Never drop historical data-store tables or columns during rollback. Any future
   physical deletion requires a backup, row-count/ownership reconciliation,
   independent migration review, and explicit approval.
6. Preserve account-scoped collection data and audit/history records during
   application rollback. Use a forward reviewed recovery migration for database
   corrections instead of destructive manual SQL.

## Completion gate

**SATISFIED WITH EXPLICIT BROWSER-PROFILE GAPS.**

- All ten browser checks are recorded as passed or explicitly blocked with an
  exact reason.
- Both browser-discovered defects followed focused fixes and automated regression
  coverage in `405e519` and `293b8b8`.
- The final automated gate passed at implementation HEAD `293b8b8`: 317 total,
  316 passed, 0 failed, and 1 general-suite PostgreSQL skip; the dedicated
  disposable PostgreSQL verification remains passed.
- Final repository status, whitespace/diff checks, history, and personal-data
  checks were rerun after this section was updated.
