# Stable Russian Rich-Content Review Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five independently reproduced Task 5 evidence, prompt-safety, repository, SQL, and error-boundary failures without wiring the feature or invoking live services.

**Architecture:** Export one pure Task 4 accepted-asset verifier and consume it at the rich-content input boundary. Export one pure closed-document validator, consume it inside one repository-local persistence-contract verifier shared by memory and PostgreSQL completion ports, and avoid exposing repository policy as a public application API. Mirror the closed persistence contract in migration-owned PostgreSQL helper functions and map every repository/gateway failure to stable safe errors.

**Tech Stack:** Node.js ESM, `node:test`, PostgreSQL JSONB/check constraints, additive SQL migration, existing Task 4 object-key and checker contracts.

## Global Constraints

- No production database, real gateway, object storage, Ozon call, secret, or mutable listing field.
- New asset evidence is 6–20 rows with exactly one MAIN and exact account/job/item/plan/group/slot ownership.
- `ATTEMPT_V2` is mandatory for new accepted assets; persisted legacy acceptance remains allowed only through the existing exact legacy-key verifier.
- All validation is fail closed for missing, extra, inherited, JSON-null, duplicate, cross-scope, or mismatched evidence.
- Prompt size remains capped at 256 KiB before reservation.
- PostgreSQL migration remains additive and must not rewrite historical terminal rows.

---

### Task 1: Shared Task 4 accepted-asset verifier

**Files:**
- Modify: `server/auto-listing-image-generator.mjs`
- Modify: `server/auto-listing-rich-content.mjs`
- Test: `server/tests/auto-listing-image-generator.test.mjs`
- Test: `server/tests/auto-listing-rich-content.test.mjs`

**Interfaces:**
- Produces: `verifyAcceptedGeneratedAssetEvidence({ record, scope, plan, slot, profile, imageModel, templateVersion }) -> boolean`.
- Consumes: exact Task 4 object-key verifier plus pure checker evidence replay.

- [x] Write RED proving a minimal plan and incomplete assets are rejected and each plan/slot/group/hash/profile/model/template/source/checker mutation fails.
- [x] Run the two focused tests and record the expected failures.
- [x] Export the pure Task 4 verifier and replace Task 5's shallow asset check with it.
- [x] Run the two focused tests to GREEN.

### Task 2: Prompt projection safety and stable gateway failures

**Files:**
- Modify: `server/auto-listing-rich-content.mjs`
- Test: `server/tests/auto-listing-rich-content.test.mjs`

**Interfaces:**
- Consumes: frozen fact `field`, `kind`, `value` and accepted asset `role`, `slotKey`.
- Produces: safe prompt or `AUTO_LISTING_RICH_CONTENT_INPUT_INVALID` before reservation; safe gateway error with fixed message/code/retryability.

- [x] Write RED tables for `http`, `https`, `data`, `file`, `ftp`, `www`, email, phone, and credential-like values in every projected field.
- [x] Write RED proving raw gateway messages/codes are not returned after the lease is terminalized.
- [x] Run RED and record exact failures.
- [x] Add one shared projection-safety predicate and stable gateway error mapper.
- [x] Run the focused test to GREEN.

### Task 3: Direct repository completion contract

**Files:**
- Modify: `server/auto-listing-rich-content.mjs`
- Modify: `server/auto-listing-rich-content-repository.mjs`
- Test: `server/tests/auto-listing-rich-content-repository.test.mjs`

**Interfaces:**
- Produces: exported `validateRichContentDocument(input)` for the closed V1 document and repository-local `validPersistenceContract(input) -> boolean` for exact request/model/checker evidence, canonical output hash, frozen facts, and complete Task 4 asset evidence.
- Consumes: the same pure rich-content document validator used by orchestration; both repository adapters share the repository-local persistence verifier.

- [x] Write RED for invented JSON, null facts/assets, fake keys/versions, extra request/model/checker keys, wrong output hash, and unknown checker IDs.
- [x] Run RED and record exact failures.
- [x] Call the pure persistence verifier from both memory and PostgreSQL completion paths before mutation/query.
- [x] Run repository plus orchestration tests to GREEN.

### Task 4: Migration-owned closed SQL validation

**Files:**
- Modify: `server/db/migrations/031_auto_listing_rich_content_attempt_evidence.sql`
- Modify: `server/tests/auto-listing-rich-content-migration.test.mjs`
- Modify: `server/tests/auto-listing-rich-content-postgres-fixture.mjs`

**Interfaces:**
- Produces: immutable schema-versioned SQL helper functions for closed fact, asset, rich-content, request/model/checker evidence and CHECK constraints that explicitly return false for SQL/JSON null.

- [x] Write static RED for helper ownership, exact element keys/types/hashes, uniqueness, one MAIN, request-key/input binding, closed block references, and checker IDs.
- [x] Extend the double-gated fixture with valid six-asset evidence and malicious inserts that must return SQLSTATE `23514`.
- [x] Run static RED and record exact failures/PG skip.
- [x] Add the helper functions and constraints without historical rewrites.
- [x] Run migration tests to GREEN/explicit PG skip.

### Task 5: Stable PostgreSQL error mapping and final gates

**Files:**
- Modify: `server/auto-listing-rich-content-repository.mjs`
- Test: `server/tests/auto-listing-rich-content-repository.test.mjs`
- Modify: Task 5 report and ledger.

**Interfaces:**
- Produces: `AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED`, retryable `true`, fixed safe message for connect/query/rollback/release failures.

- [x] Write RED for rejected `pool.connect`, reserve query, transition query, and raw-message non-disclosure.
- [x] Run RED and record exact failures.
- [x] Put acquisition and all queries behind the stable mapper while preserving internal attempt-invalid errors.
- [x] Run focused, auto-listing, AI, migration, historical, whole/raw, build, syntax, and diff gates.
- [x] Update report/ledger, commit the verified scope, and request a new independent read-only review; do not self-declare approval.

---

## Independent-review repair round 2 addendum

The second independent review returned 0 Critical, 6 Important, and 1 Minor finding. This addendum records the follow-up TDD execution; it does not expand Task 5 scope or enable the feature.

### Task 6: Recompute Task 4 and Task 5 evidence identities

- [x] Add RED for a forged Task 4 attempt/input identity with a matching claimed V2 or legacy object key.
- [x] Recompute Task 4 attempt, input, and prompt hashes from closed evidence on accepted replay.
- [x] Add RED for forged Task 5 fact-registry, asset, prompt, and input hashes, including mutually consistent claimed request identities.
- [x] Rebuild the deterministic prompt and recompute all four Task 5 hashes before memory/PostgreSQL reserve and completion.

### Task 7: Close replay, prompt, format, and error compatibility

- [x] Add RED for same-input `REJECTED` replay, credential-shaped units, bare domains, international phones, colonless Bearer tokens, JPEG/WebP evidence, and release failures.
- [x] Return the terminal policy result before any new attempt or gateway work.
- [x] Extend the shared prompt projection predicate and align repository source evidence with Task 4 PNG/JPEG/WebP.
- [x] Map connection, query, and release failures to the stable retryable repository error.

### Task 8: Mirror the complete SQL-determinable Task 4/Task 5 contract

- [x] Add RED for MIME compatibility, checker-fact subsets, absent reported image models, closed checker arrays, UTF-8 limits, nulls, and rich-text fact references.
- [x] Preserve exact Task 4 nonnumeric checker-claim value semantics separately from Task 5 Russian word-form matching.
- [x] Keep migration 031 additive and avoid guessing application-owned canonical hash serialization in SQL.
- [x] Reach static migration GREEN 14/14 and retain explicit PostgreSQL environment skips.

### Task 9: Final gates and independent review

- [x] Run final focused, auto-listing, AI, migration, historical, whole/raw, build, syntax, and diff gates from the same final worktree.
- [x] Update the Task 5 report and progress ledger with exact RED/GREEN evidence and unverified PostgreSQL scope.
- [ ] Commit only after the coordinating agent approves the final diff.
- [ ] Obtain a new independent read-only review; do not self-declare Task 5 approved.

---

## Independent-review repair round 3 addendum

The third independent review returned NOT PASS with 0 Critical, 4 Important, and 1 Minor finding. This addendum keeps the feature disabled and records the bounded follow-up.

### Task 10: Align the durable SQL replay contract

- [x] Add RED for Task 4's exact `false + ""` absent-image-model sentinel and JSON-null rejection.
- [x] Add RED for reversed checker fact/asset arrays, English-only text, and fixed prohibited-policy text.
- [x] Derive exact first-reference arrays by JSON ordinality and compare them without set semantics.
- [x] Add immutable Russian-token and fixed-policy helpers, called from the rich-content validator after fact binding.

### Task 11: Bound JavaScript prompt and evidence processing

- [x] Add RED for `.cn`, `.uk`, `.de`, `.cloud`, Unicode IDN, and punycode domains across all projected fields.
- [x] Replace the finite suffix enumeration with general Unicode DNS-label detection plus the closed internal fact/path grammar.
- [x] Add RED proving 257 facts, 21 assets, open rows, and over-byte rows fail before structured cloning.
- [x] Validate closed fact/asset cardinality, shape, and UTF-8 ceilings before clone/sort/prompt/hash.
- [x] Use UTF-8 byte ceilings throughout memory and PostgreSQL repository contracts, including Chinese and emoji boundaries.

### Task 12: Final gates and fourth independent review

- [x] Run focused, auto-listing, AI, migration, historical, whole/raw, build, syntax, and diff gates from the final worktree.
- [x] Update the Task 5 report and progress ledger with round-3 RED/GREEN and unavailable PostgreSQL behavior scope.
- [ ] Commit only after the coordinating agent approves the final diff.
- [ ] Obtain a fourth independent read-only PASS; do not self-declare Task 5 approved.

---

## Independent-review repair round 4 addendum

The fourth independent review returned NOT PASS with 0 Critical and 2 Important findings. The feature remains disabled while these two fixed-contract gaps are closed.

### Task 13: Complete seller-contact and certification policy

- [x] Confirm the frozen design requires deterministic rejection of contact and certification claims.
- [x] Add RED for `Контакты продавца`, `Телефон продавца`, `Обратитесь к продавцу`, and `Сертификация`.
- [x] Extend the high-cohesion JavaScript policy with Unicode word-form stems and prove brands/technical tokens remain legal.
- [x] Mirror the exact fixed policy semantics in the immutable SQL helper and PostgreSQL fixture.

### Task 14: Enforce Task 4 checker array cardinality before SQL expansion

- [x] Add static RED for all six JavaScript checker-array limits and non-array guards.
- [x] Require reasons ≤32, source assets 1–7, claims ≤256, detected texts ≤64, quality flags ≤4, and prohibited flags ≤8.
- [x] Guard `jsonb_array_length` so non-arrays and JSON null fail closed before element expansion.

### Task 15: Final gates and fifth independent review

- [x] Run focused, auto-listing, AI, migration, historical, whole/raw, build, syntax, and diff gates from the final worktree.
- [x] Update the Task 5 report and progress ledger with round-4 RED/GREEN and unavailable PostgreSQL behavior scope.
- [ ] Commit only after the coordinating agent approves the final diff.
- [x] Obtain a fifth independent read-only PASS; do not self-declare Task 5 approved.

---

## Independent-review repair round 5 addendum

The fifth independent review identified three Important boundary defects. The feature remains disabled while the false-positive policy and outer-checker sequencing are repaired.

### Task 16: Add the Unicode left boundary to new contact stems

- [x] Add RED proving `бесконтактный` is legal while all four seller-contact phrases remain prohibited.
- [x] Require start-of-text or a Unicode non-letter/non-number before only the newly added contact stems.
- [x] Mirror the exact semantics with native PostgreSQL character classes and retain all earlier policy branches.

### Task 17: Preflight checker cardinality before image work

- [x] Add RED using invalid image bytes plus 8 references or 257 facts.
- [x] Perform O(1) plain-shape, cardinality, profile/scope/model/template/gateway checks before normalize/decode/hash.
- [x] Return stable retryable `CHECKER_UNAVAILABLE` and retain the pure evaluator's independent validation.

### Task 18: Final gates and new independent confirmation

- [x] Run focused, auto-listing, AI, migration, historical, whole/raw, build, syntax, and diff gates from the final worktree.
- [x] Update the Task 5 report and progress ledger with round-5 RED/GREEN and unavailable PostgreSQL behavior scope.
- [ ] Commit only after the coordinating agent approves the final diff.
- [x] Obtain a new independent read-only PASS; do not self-declare Task 5 approved.

### Task 19: Systematize Unicode boundaries for every word policy

- [x] Add RED for legitimate `Теплообменник`, `безотзывный`, and `немедицинский` compounds.
- [x] Apply one Unicode-left-boundary constructor to contact, review, regulated/after-sales, and bundle/gift branches.
- [x] Keep URL, email, and phone patterns unchanged and prove all existing prohibited phrases still reject.
- [x] Mirror all four branches in PostgreSQL with native character classes.
- [x] Rerun the complete final matrix and update evidence; obtain a fresh independent confirmation before approval.
