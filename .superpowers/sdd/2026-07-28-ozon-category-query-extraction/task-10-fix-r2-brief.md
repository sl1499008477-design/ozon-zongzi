# Task 10 final-review fix round 2

Target: `/Users/songliang/Documents/sonli ozon3.0`

Read the round-1 brief and report first:

- `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-10-fix-r1-brief.md`
- `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-10-fix-r1-report.md`

The scoped re-review marked all three original Important findings ADDRESSED,
then found one new Important:

`app/src/App.jsx` currently maps a successful response that has neither an
`items` array nor a `data` array to `[]`. The dictionary controller then marks
that result complete and ready. This confuses a malformed 2xx response with an
authentic successful empty array.

## Required fix

- Put the response-to-rows adapter in a directly executable focused module.
  It may live in `app/src/use-category-dictionary-readiness.js`.
- An explicit `items: []` or `data: []` is a valid authentic empty result.
- If neither `items` nor `data` is an array, throw so the existing controller
  records the fixed visible error, clears options and remains not ready.
- `App.jsx` must call that tested adapter; do not leave a second permissive
  response parser in the page.
- Add a load-bearing test that fails on the current malformed-2xx behavior and
  proves both valid empty response shapes remain accepted.
- Preserve every round-1 scope/generation/retry/readiness behavior.
- Keep `App.jsx` under its unchanged line guard.

Allowed production/test files:

- `app/src/use-category-dictionary-readiness.js`
- `app/tests/category-dictionary-readiness.test.mjs`
- `app/src/App.jsx`

Create exact before snapshots under
`snapshots/task-10-fix-r2-before/`, append the RED/GREEN evidence, file changes,
tests, line counts, external-effect statement and rollback to
`task-10-fix-r1-report.md`, and return only status/files/one-line tests/concern.

Required validation:

- dictionary readiness test;
- app category readiness test;
- category tree hook test;
- prototype style contract;
- collect-edit listing contract;
- module boundaries;
- offline production build;
- scoped `git diff --check`.

Do not call real Ozon, start services, change data/database/config/dependencies/
deployment, or perform any Git write.
