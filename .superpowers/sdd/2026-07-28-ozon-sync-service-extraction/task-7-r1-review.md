### Spec Compliance

- ✅ The prior same-identity POSTINGS merge issue is fixed. `syncPostings` now records a per-run patch containing only the actual Ozon row plus generated scope/sync fields, rather than a working-copy posting that embeds stale business fields (`server/ozon-sync-service.mjs:466-474`, `server/ozon-sync-service.mjs:490-512`, `server/ozon-sync-service.mjs:524-547`).
- ✅ Commit applies that patch over the freshly loaded same-identity row (`{ ...latestPosting, ...posting }`), preserving latest concurrent fields that Ozon did not send while updating fields Ozon did send (`server/ozon-sync-service.mjs:623-649`).
- ✅ The focused regression uses the same `old_posting` identity for FBS, the concurrent update, and FBO. It proves Ozon `status`, FBO `fboMetric`/`shipment_type`, and concurrent `operatorNote` coexist after commit (`server/tests/ozon-sync-service.test.mjs:801-860`).
- ✅ The context is a `Map` created inside each `runLocalSync` invocation and is passed only to the in-flight POSTINGS sync/commit path; it is not placed in state, reports, cache rows, or module scope, so it is neither persisted nor reused by another run (`server/ozon-sync-service.mjs:729-748`).
- ⚠️ Per instructions, I did not rerun the reported targeted test.

### Strengths

- The patch representation cleanly distinguishes externally sourced Ozon fields from unrelated locally concurrent fields.
- Store ID is incorporated into the context identity key, and FBS/FBO patches for the same posting merge incrementally without importing stale working-copy fields (`server/ozon-sync-service.mjs:466-474`, `server/ozon-sync-service.mjs:498`, `server/ozon-sync-service.mjs:533`).

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- None.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Approved.

**Reasoning:** The scoped repair directly addresses the previously unsafe same-identity overwrite, updates Ozon-owned fields, retains concurrent non-Ozon fields, and confines tracking context to one run.
