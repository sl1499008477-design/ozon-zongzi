## Task 5: Generate a Stable Russian Rich-Content Contract

**Files:**
- Create: server/auto-listing-rich-content.mjs
- Create: server/auto-listing-rich-content-repository.mjs
- Create: server/db/migrations/031_auto_listing_rich_content_attempt_evidence.sql
- Create: server/tests/auto-listing-rich-content.test.mjs
- Create: server/tests/auto-listing-rich-content-repository.test.mjs
- Create: server/tests/auto-listing-rich-content-migration.test.mjs
- Create: server/tests/auto-listing-rich-content-migration-postgres.test.mjs

**Interfaces:** RICH_CONTENT_JSON_SCHEMA, buildRichContentPrompt, validateRichContent, generateRichContent, createMemoryRichContentRepository, and a PostgreSQL adapter with the same fenced attempt port.

The internal contract is independent of Ozon transport. It contains 3–20 closed blocks; the first and only HERO_IMAGE references an immutable accepted ai_generation_assets.id whose role is MAIN. Other permitted blocks are HEADING, TEXT, and IMAGE_TEXT; every text-bearing block has nonempty unique sourceFactIds, every asset ID is unique, and every numeric or nonnumeric claim is bound to the same frozen fact field/value/unit. Text is Russian with only fact-proven brand/model or the closed technical-token set as non-Russian exceptions. Exact UTF-8 byte and array ceilings, plain-object/prototype protection, and extra-key rejection apply at every level.

Generation receives only the complete immutable plan record, its frozen fact registry, complete accepted generated-asset records, and the selected account-scoped profile/model/template. The prompt projection contains no source URL, secret, mutable listing field, original rich content, or raw source evidence. Contact details, external links, review requests, certification, medical, warranty, and unlisted-accessory claims are deterministic policy failures. The validator itself is the persisted checker evidence; there is no second AI checker. The future Ozon adapter remains Plan 4 scope.

inputHash binds the full account/job/item/plan boundary, plan/source/fact/asset hashes, profile/model/template, language, and prompt hash. The repository reserves a full-scope attempt and echoes input/prompt hashes before any gateway call. Active and accepted uniqueness is (account_id, job_id, item_id, plan_id, input_hash); attempt identity additionally includes attempt_no. Every transition uses an exact account/scope/input/attempt/lease CAS and terminal states clear leases. Same accepted input reuses with zero gateway calls only after the complete evidence, deterministic checker result, and accepted object references are revalidated. Policy rejection is terminal non-retryable; gateway/lease failure is recoverable.

Migration 031 is additive, never updates historical terminal rich-content rows, and adds explicit non-null/hash/JSON/lease constraints for new generating and accepted writes so PostgreSQL SQL NULL cannot satisfy them.

- [ ] **Step 1: Write failing tests**

Assert the complete closed-block, Russian/fact, accepted-asset, policy, bounded-input, deterministic-hash, lease, retry, repository-failure, corrupt-reuse, migration, and idempotent-reuse contracts above.

Use an internal contract independent of Ozon transport:

~~~js
{
  version: "AUTO_LISTING_RICH_CONTENT_V1",
  language: "ru",
  blocks: [
    { type: "HERO_IMAGE", assetId: "asset-main" },
    { type: "HEADING", text: "..." },
    { type: "TEXT", text: "...", sourceFactIds: ["fact.material"] },
    { type: "IMAGE_TEXT", assetId: "asset-selling-01", text: "...", sourceFactIds: ["fact.capacity"] },
  ],
}
~~~

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-rich-content.test.mjs
~~~

- [ ] **Step 3: Implement generation and validation**

Pass only the frozen fact registry, accepted immutable generated assets, and plan/profile/model/template evidence. Validate the closed schema and every sourceFactId/value/unit. Store plan/prompt/input/output/source/fact-registry/asset hashes, request/model/profile/template evidence, deterministic checker outcome, attempt/lease audit, and stable error evidence. Same accepted input returns only a fully revalidated result.

- [ ] **Step 4: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-rich-content.test.mjs
git add server/auto-listing-rich-content.mjs server/tests/auto-listing-rich-content.test.mjs
git commit -m "feat: generate traceable Russian rich content"
~~~

---

