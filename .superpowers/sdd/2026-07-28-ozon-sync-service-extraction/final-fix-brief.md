# Final review fix brief

## Files

- Modify: `server/ozon-client.mjs`
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-client.test.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/tests/store-cache-scope.test.mjs`

## Fix 1 — non-2xx sanitization

- Add a failing client test whose non-2xx response text contains the configured test `clientId`, `apiKey`, an email, and a nested payload.
- The resulting error `message`, serialized `body`, and `cause` must contain none of those values.
- The non-2xx message must be stable and based only on API path, HTTP status, and error code.
- `error.body` may contain only allowlisted fields: `apiPath`, numeric `status`, stable internal `code`, response format (`json`, `text`, or `empty`), and a bounded Ozon machine code containing only letters, digits, `_`, `-`, or `.`.
- Never retain raw response text or arbitrary response object fields on the error.
- Add a service test with a non-2xx Ozon payload containing credentials and an email; persisted `jobs[jobId].error` and terminal audit metadata must contain none of them.
- If necessary, add a service-level report-error formatter so Ozon HTTP errors always use the stable safe summary.

## Fix 2 — cache helper coverage

- Add assertions for:
  - client-ID fallback match;
  - case/whitespace-normalized store-name fallback;
  - explicit mismatched store ID taking precedence over matching client/name;
  - `true` on insert and `false` on update for both upsert helpers.
- Do not change production helper behavior unless a test reveals a real defect.

## Fix 3 — repeated FBO token

- Add a failing POSTINGS test: first FBO page returns a non-empty `last_id`; second page returns the same non-empty token.
- Detect the repeated token before applying the stalled page rows.
- Throw a deterministic `502 / OZON_PAGINATION_STALLED`, close the job to FAILED, and preserve the old target-store posting cache.
- Assert exactly two FBO requests; do not loop to the 50-page cap.
- Do not change the existing FBS range-split behavior.

## Validation

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/store-cache-scope.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-client.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-sync-service.mjs
```

Also run `git diff --check` for tracked files and whitespace checks for the untracked target files.

## Constraints

- Use TDD and record RED then GREEN.
- No real Ozon request, database/container change, dependency/config change, or entry-route change.
- Use `apply_patch`.
- No commit, staging, push, stash, branch change, or destructive Git.
