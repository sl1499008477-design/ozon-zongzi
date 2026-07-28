# Impact analysis

- Work item: Ozon 同步服务拆分
- Target path: `/Users/songliang/Documents/sonli ozon3.0`
- Branch/worktree: dirty `main`, in-place by prior explicit user approval
- Commit: `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`
- Existing dirty files: extensive pre-existing tracked and untracked changes; preserve all unrelated work
- Existing failing checks: none known; last full verify before this package was 68 files / 94 tests passing
- Last known-good/recovery point: per-task snapshots under this SDD workspace
- Allowed module/file boundary: plan-listed Ozon client, sync service, cache-scope module, tests, module guard, design/plan docs, plus direct static boundary consumer `scripts/check-store-data-isolation.mjs`
- Goal: centralize Ozon HTTP and extract profile/product/posting/warehouse/promotion sync from `server/index.mjs`
- Explicit non-goals: frontend, category query, collection, listing orchestration, database, dependencies, config, deployment
- Risk level: R2 shared compatible module/API extraction
- Prior approval: confirmed design, plan, in-place dirty-worktree execution, and subagent-driven option 1
- Pages/routes: no page changes; preserve `/local/stores/refresh-profile` and `/local/sync/:type`
- APIs/contracts: internal additive GET client and sync-service factory; external route contract unchanged
- Tables/data: no migrations and no real data mutation beyond test fixtures
- Permissions/account boundaries: backend account/store ownership remains mandatory and gains negative service tests
- Shared components/services: `server/ozon-client.mjs`, `server/index.mjs`, listing worker consumer
- Config/environment/dependencies: unchanged
- External side effects: none; no real Ozon requests or writes
- Protected completed functions: category queries, collection pipeline, listing pipeline, sync lease, existing route payloads
- Validation layers: focused module tests, direct-consumer tests, module boundary guard, full `scripts/verify.mjs`
- Rollback/recovery: restore only task snapshots; never use `git reset --hard`
- Confirmation required: no further confirmation unless scope, contract, risk, or side effects expand

## Scope update — Task 2

- Added file: `scripts/check-store-data-isolation.mjs`
- Reason: the existing static verifier hard-codes cache helper definitions inside `server/index.mjs`; extracting the approved module otherwise makes the full gate fail for the wrong reason.
- Risk change: none; still R2 compatible shared-boundary extraction with no runtime, data, config, dependency, or external side effect.
- Validation: run the static verifier after pointing it at `server/store-cache-scope.mjs`.
