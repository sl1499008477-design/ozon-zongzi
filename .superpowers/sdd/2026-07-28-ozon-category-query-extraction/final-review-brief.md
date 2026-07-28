# Final independent review brief

This is a read-only whole-work-item review. Do not edit files, run real Ozon
requests, start services, mutate data or perform any Git write.

## Required sources

Read these completely:

1. `/Users/songliang/.codex/AGENTS.md`
2. `/Users/songliang/Documents/sonli ozon3.0/docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`
3. `/Users/songliang/Documents/sonli ozon3.0/docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`
4. `/Users/songliang/Documents/sonli ozon3.0/.superpowers/sdd/2026-07-28-ozon-category-query-extraction/final-report.md`
5. `/Users/songliang/Documents/sonli ozon3.0/.superpowers/sdd/2026-07-28-ozon-category-query-extraction/progress.md`

The repository is intentionally on a dirty `main` with unrelated work that
predates this plan. There is no useful commit range. The plan-specific diff
evidence is split across:

- `task-2-review-package.diff`
- `task-3-fix-r1-package.diff`
- `task-4-review-package.diff`
- `task-4-fix-r2-package.diff`
- `task-5-review-package.diff`
- `task-5-fix-r1-package.diff`
- `task-6-review-package.diff`
- `task-7-review-package.diff`
- `task-7-fix-r1-package.diff`
- `task-7-fix-r2-package.diff`
- `task-7-fix-r3-package.diff`
- `task-8-review-package.diff`
- `task-8-fix-r1-package.diff`
- `task-8-fix-r2-package.diff`
- `task-9-review-package.diff`

All are in:

`/Users/songliang/Documents/sonli ozon3.0/.superpowers/sdd/2026-07-28-ozon-category-query-extraction/`

Use the corresponding `task-N-report.md`, the `snapshots/` directories and
the actual current files to resolve anything the diff packages cannot prove.
Do not trust the handoff claims without inspecting the implementation.

## Review scope

Assess:

- real-Ozon-only tree, attributes and dictionary values;
- six-hour maximum cache, isolation, cloning, atomicity and safe failures;
- stable compatible HTTP success contract and backend auth/store ownership;
- no local-product category inference;
- preview/final listing stopping before snapshot, task or external write;
- app dual-language readiness, retry/error and stale store/item containment;
- extension restored-draft and asynchronous action-scope containment;
- module boundaries, tests, secret exposure, scope drift and recovery;
- every applicable rule in `/Users/songliang/.codex/AGENTS.md`;
- the Task 10 collect-edit contract adjustment and final-report accuracy.

The final fresh engineering gate already recorded 110 passed / 0 failed and
all 19 verification checks passed. You may run safe read-only or local test
commands if needed, but do not use real credentials or start external
services.

## Required verdict

List findings first with severity, exact file/line evidence, impact and the
smallest correction. Treat missing acceptance criteria, business correctness,
authorization/isolation, unsafe failure behavior, broken contract or missing
load-bearing tests as Critical or Important.

End with exactly:

```text
Ready: Yes|No
Critical: <count>
Important: <count>
```
