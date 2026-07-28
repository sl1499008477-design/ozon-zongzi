### Strengths

- Seller API transport has one clear implementation with symmetric GET/POST behavior, credentials validation, abort-based timeout handling, and network-path credential redaction (`server/ozon-client.mjs:57-116`). The service and entry consume this contract rather than reimplementing Seller API fetches.
- Store-scoped cache behavior is isolated in a pure module (`server/store-cache-scope.mjs:13-72`), and service commits reload state, revalidate ownership, then mutate only the requested store/type fragment in the successful save (`server/ozon-sync-service.mjs:197-218`, `server/ozon-sync-service.mjs:607-672`).
- The synchronization state machine persists RUNNING before work, closes supported and unsupported operations to SUCCESS/FAILED, and emits correlation-linked terminal audit events (`server/ozon-sync-service.mjs:165-195`, `server/ozon-sync-service.mjs:675-760`).
- Product sync uses a work copy and delays cache replacement until the atomic commit; FBS range splitting keeps cursors bound to their split range and propagates required-page failures (`server/ozon-sync-service.mjs:327-405`, `server/ozon-sync-service.mjs:407-464`).
- Same-identity POSTINGS commits now apply a per-run Ozon-field patch to the latest row, preserving concurrent non-Ozon fields; the regression test covers FBS, FBO, and a concurrent update to the same posting (`server/ozon-sync-service.mjs:466-474`, `server/ozon-sync-service.mjs:623-649`, `server/tests/ozon-sync-service.test.mjs:801-860`).
- The local sync route now passes only the stable seven-field service contract and gets `accountId` from authenticated server state (`server/index.mjs:3169-3183`); the boundary guard prevents the old HTTP/sync functions returning to the entry (`server/tests/module-boundaries.test.mjs:32-48`).

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

1. **HTTP non-2xx response bodies can be persisted and exposed through sync reports.**
   - File: `server/ozon-client.mjs:96-102`, `server/ozon-sync-service.mjs:751-752`, `server/audit-event.mjs:8-25`, `server/index.mjs:727-729,767`
   - The client constructs the non-2xx `Error.message` from the raw response text without `redactedText` or an allowlisted summary. The service copies that message to `report.error`; terminal audit metadata also retains it because `error` is not a sensitive key. Jobs are included in authenticated local state responses. Consequently, an Ozon error payload containing credentials, personal data, or other sensitive business content can be stored in reports/audit records and returned to the account UI. This violates the design requirement for a redacted HTTP-error summary and the global rule that sensitive data must not appear in logs or user-visible reports.
   - Fix: make non-2xx errors use a stable message based on status/code only and store an allowlisted, bounded, structurally sanitized response summary. Ensure the same sanitized value is the only value copied to `report.error` and audit metadata. Add client and service tests using a non-2xx payload containing the configured credentials and sensitive-looking fields, asserting neither reports nor audit events contain them.

#### Minor (Nice to Have)

1. **Deferred ledger item: fallback and return-value behavior is still untested.**
   - File: `server/store-cache-scope.mjs:13-31,47-72`; `server/tests/store-cache-scope.test.mjs:13-47`
   - `cacheItemMatchesStore` has client-ID and normalized-name fallback branches, and both upserts have a documented insert/update boolean return value. The tests cover explicit `storeId` isolation and mutation but assert neither fallback branch nor either boolean outcome.
   - Impact: a future change to legacy cache compatibility or caller branching can regress without a focused signal.
   - Fix: add compact tests for client fallback, case-normalized name fallback, explicit store/client precedence, and true-on-insert/false-on-update for both upserts.

2. **Deferred ledger item: FBO pagination does not stop on a repeated non-empty `last_id`.**
   - File: `server/ozon-sync-service.mjs:517-552`
   - FBS detects a repeated cursor, but FBO assigns `fboLastId` and only stops when it becomes empty. A repeated Ozon token makes the service reread the same page until the 50-page cap; cache upsert masks duplicate rows but `fetchedCount` is inflated and API quota is wasted.
   - Impact: bounded rather than infinite, so this is non-blocking, but it weakens terminal-pagination correctness and can turn an Ozon pagination fault into rate limiting.
   - Fix: retain the prior token and stop or fail deterministically when a non-empty next `last_id` equals it; add a two-page/repeated-token test that asserts the request count and accurate count semantics.

### Recommendations

- Treat the non-2xx sanitization repair as a small security-focused TDD task before production use; verify message, `body`, `report.error`, and audit metadata independently rather than relying only on network-error redaction tests.
- Run the recorded complete verification in an isolated PostgreSQL environment before release. The six current `ECONNREFUSED 127.0.0.1:5432` integration failures match the Task 1 baseline and are not attributed to this extraction, but their success paths remain unverified.
- Keep new behavior out of `server/index.mjs`: it is 5,380 lines against a 5,400-line guard, leaving little safe headroom.

### Assessment

**Ready to merge?** With fixes.

**Reasoning:** The extraction, account/store isolation, atomic commit path, route contract, and concurrency repair are well structured and the recorded verification distinguishes the six PostgreSQL-offline baseline failures from new regressions. However, raw non-2xx payload text can currently reach persistent, user-visible synchronization reports, which conflicts with the required redaction boundary and must be fixed before release.

### Review Scope

- Read the design, plan, global rules, final package, ledger, Task 9 evidence, current client/cache/service/entry modules, all listed focused tests, and the static isolation guard. No code was modified and the complete verification suite was not rerun.
