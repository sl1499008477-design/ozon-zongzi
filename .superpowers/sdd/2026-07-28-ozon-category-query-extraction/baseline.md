# Task 1 pre-change baseline

Recorded: 2026-07-28 (Asia/Shanghai)

## Git recovery boundary

- Branch: `main`
- HEAD: `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`
- Dirty entries before Task 1: 180; saved verbatim in `dirty-files-before.txt`.
- `git diff --check`: exit 0 (no output).
- Dirty entries after Task 1: 180.
- No Git mutation, staging, commit, stash, rebase, or push was performed.

## Category implementation inventory

`server/index.mjs` contains the current inline cache/query boundary at lines 144, 1417-1488 and its two normalizer callback sites at 1883-1887 and 1920-1924. The three inline HTTP-path handlers are at 4274-4383, including `categoryAttributesMatch` (4315) and `categoryAttributeValuesMatch` (4355). `findDescriptionCategoryIdByTypeId` is at 1429.

Direct normalizer consumers are in `server/ozon-import-normalizer.mjs` at 493-510, 622-635, and 781-782. Extension consumers are the service worker at 4494-4504 and 5427-5428, and the 1688 wizard at 924, 935, 942, and 1113. The baseline `server/index.mjs` line count is 5380.

## Safety snapshots

All snapshots are under `snapshots/before/`; each was byte-compared with its source after recording.

| Source | SHA-256 |
| --- | --- |
| `server/index.mjs` | `9d62b2dbadcce1c12bb56b542351af63ce5f879de38cae928dc5b06ef265c971` |
| `server/tests/module-boundaries.test.mjs` | `43eaff7c9c09f92c231e6bc525288fbda64399cad618c51ce55be352f29c38de` |
| `server/tests/cache-route-isolation.test.mjs` | `d3c590bfbc149d3ac2535b80b535e60fe791c8eee811b119082e0fe891d78b8d` |
| `app/src/App.jsx` | `12a825919ec77fc939384ee106151ea44e5b4e57f9fe43048e0b7269ba654ce8` |
| `extension/content/1688-ai-wizard.js` | `0a07f59fbf210d3f52f3111b1d4a2fbbded7b8c1946e2152bc9c0bbdb3427d62` |
| `extension/manifest.json` | `720c244804860bc5c0da1f27144b7372c2048f6d5e2d174a39c776958796eb7b` |
| `scripts/check-extension-source-parity.mjs` | `09ca5c6f2e194b43d5d0a9b204a96bac2226c3d4747c9fe6f1c38710752e75dd` |
| `scripts/check-extension-diff-contract.mjs` | `1adc60030e268698ac65772991495e7057bac70853f5c0eb8630557c903910e3` |
| `docs/architecture/module-boundaries.md` | `d7eb9780cb6c5990c062de4a2e2a95a6a118df6a508f9b089ef5c58093f73d7f` |

## Narrow test baseline

The initial shell `node` lookup failed (exit 127), so the seven exact test paths were rerun with this workspace's available fixed Node runtime: `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. Every command passed:

1. `.../node server/tests/ozon-client.test.mjs` — `ozon client tests passed`.
2. `.../node server/tests/cache-route-isolation.test.mjs` — `cache route account isolation test passed`.
3. `.../node server/tests/import-preview-route.test.mjs` — `import preview route smoke passed`.
4. `.../node server/tests/collect-listing-submit-failure.test.mjs` — `collect listing fail-closed smoke passed`.
5. `.../node server/tests/external-write-safety.test.mjs` — `external write safety test passed`.
6. `.../node server/tests/module-boundaries.test.mjs` — `module boundary guards passed`.
7. `.../node app/tests/prototype-style-contract.test.mjs` — 15 passed, 0 failed, 0 skipped.

No Ozon call was made by these tests.

## Full gate

Initial `sonli-postgres` state: stopped (`false`). The first plain-shell invocation could not locate `node`; it was rerun with this workspace's available fixed Node runtime. Per the brief, only that local container was started, then `.../node scripts/verify.mjs` passed: app build passed, active suite was 97 passed / 0 failed, and all 19 verification checks passed. `docker stop sonli-postgres` succeeded and final state is stopped (`false`).

## Review fix round 1 — additional recovery snapshots

The recovery boundary was extended to cover all existing files listed for later modification: `extension/manifest.json`, `scripts/check-extension-source-parity.mjs`, and `scripts/check-extension-diff-contract.mjs`. Their SHA-256 values are recorded above; `cmp -s` succeeded for all three. `git diff --check` remained exit 0.

## Task-1 scope review

The six planned product/document/test targets were all byte-identical to their Task-1 snapshots after this work. The only Task-1 changes are the required `.superpowers/sdd` safety records and the Task-1 checkbox state in the untracked plan file. `git diff --check` remains clean.
