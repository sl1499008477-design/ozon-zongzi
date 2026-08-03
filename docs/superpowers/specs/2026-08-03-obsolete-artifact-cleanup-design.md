# Obsolete Artifact Cleanup Design

## Goal

Remove obsolete extension releases, unreachable runtime code, and regenerable local artifacts without changing current Ozon collection, authentication, listing, desktop collector, or historical traceability behavior.

## Approved cleanup boundary

The cleanup proceeds in three reversible code batches:

1. Remove extension `0.13.46.1` distributables after proving all live download and packaging contracts target `0.13.46.2`.
2. Remove production files and Web components that are not reachable from the current manifest, service-worker imports, application render tree, or supported scripts.
3. Review each apparently unreferenced service-worker action against content scripts, Web bridges, extension pages, tests, and server contracts. Remove an action only when a contract test proves it is retired; otherwise retain it and record why.

Regenerable dependency caches are deleted only after verification, because the test and build commands require them. Active worktrees, Git stashes, `.env`, `server-data`, desktop runtime assets, `.superpowers`, `source-evidence`, current `0.13.46.2` artifacts, and compatibility migrations are outside the deletion boundary.

## Contracts and safety

- `/extension/latest`, the Web extension page, the manifest, packaged ZIP, and source tree must continue reporting and serving `0.13.46.2`.
- Extension packaging must contain every file loaded by the manifest and service worker, and must not contain retired runtime modules.
- Removing Web components must not change the rendered route tree or supported routes.
- Dynamic extension messages are treated as public contracts. Absence of a simple text reference is not sufficient proof of retirement.
- No database, authentication, store-boundary, collection, listing, or external Ozon behavior is changed.

## Verification

Each code batch is protected by a focused contract test that fails before deletion and passes after deletion. The final gate runs the complete repository verification command, application build, extension packaging/parity checks, and a clean diff check. Ignored dependency caches are removed only after all code verification passes.

## Recovery

Every code batch is committed separately on `codex/remove-obsolete-artifacts`. A failed batch can be reverted independently. Local dependency directories and the pnpm store are recoverable by reinstalling dependencies; active worktrees and stashes are preserved.
