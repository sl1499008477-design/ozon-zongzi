### Spec Compliance

- ✅ Spec compliant. `server/index.mjs:48-54` imports all five helpers from the new module; the scoped before/current diff shows the former local definitions were removed without changing their bodies. `server/index.mjs:6091-6105` preserves every pre-existing `testExports` name.
- ✅ The extracted module follows the required pure boundary. `server/store-cache-scope.mjs:1-72` has no imports and only operates on supplied objects and arrays; it does not access a database, network, environment, global state, or current-account context.
- ✅ Matching and update contracts are preserved. `server/store-cache-scope.mjs:13-31` retains the exact store-ID → client-ID → store-name precedence, while `server/store-cache-scope.mjs:47-71` preserves the existing boolean return values and update/insert behavior.
- ✅ Required isolation behavior is represented in tests. `server/tests/store-cache-scope.test.mjs:22-34` covers same product ID across two stores, and `server/tests/store-cache-scope.test.mjs:36-47` covers same-store update.
- ✅ The static isolation verifier was moved rather than weakened. `scripts/check-store-data-isolation.mjs:38-47` checks helper definitions in the new module and still checks the product-sync call in the server entry; `scripts/check-store-data-isolation.mjs:48-62` keeps the existing plugin-import and persistence isolation guards.
- ✅ Scope is exact: the review package comparisons show only `server/index.mjs` and `scripts/check-store-data-isolation.mjs` changed, plus the two required new files.
- ⚠️ Cannot verify from the scoped diff alone: the historical RED run and reported test command outputs. The implementer report records `ERR_MODULE_NOT_FOUND` before implementation and the specified passing checks afterward; per review instructions these were not re-run.

### Strengths

- The extraction is mechanically narrow: `server/index.mjs` drops from 6186 to 6122 lines with only one new import block and removal of the five local helpers.
- `server/store-cache-scope.mjs:13-71` exposes a small, cohesive API and keeps the existing behavior intact instead of expanding upsert semantics to inject scope implicitly.
- The corrected fixtures at `server/tests/store-cache-scope.test.mjs:23-31` and `server/tests/store-cache-scope.test.mjs:37-45` explicitly add `cacheItemScope`, so the tests model the production contract rather than forcing a new hidden behavior into the helper.
- `scripts/check-store-data-isolation.mjs:6-9` names the new module as the source of helper definitions while continuing to inspect `server/index.mjs` for real call-site enforcement.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None.

#### Minor (Nice to Have)

- `server/tests/store-cache-scope.test.mjs:13-47` does not pin two parts of the public contract: the `true`/`false` return values of both upsert helpers, and the client-ID/name fallback branches of `cacheItemMatchesStore`. The implementation is correct and the scoped diff proves behavior was moved unchanged, so this does not block Task 2; adding assertions would make future regressions in the corrected boolean signature and matching precedence detectable.

### Assessment

**Task quality:** Approved

**Reasoning:** The implementation is an exact, cohesive extraction with stable external and test contracts, no unrelated changes, and no Important or Critical defects. The only gap is non-blocking unit-test coverage for already-correct branches and return values.
