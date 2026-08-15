# Auto Listing No-Brand Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let automatic-listing preparation dynamically freeze Ozon's current official `Нет бренда` dictionary option when a required brand is genuinely absent.

**Architecture:** Keep the behavior inside `auto-listing-listing-base-preparer`, where frozen source data, current target-category metadata, and live dictionary reads already meet. Detect missing brand per variant, add one exact dictionary candidate, validate one canonical live result, inject it only into missing variants, then pass through the existing strict normalizer and category rebuilder. Expose one new stable safe error code through the existing backend and frontend message contracts.

**Tech Stack:** Node.js ESM, `node:test`, existing Ozon category service, Vite frontend contract tests.

## Global Constraints

- Do not hardcode Ozon dictionary value ID `126745801`; take the ID from the current category dictionary response.
- Do not overwrite a non-empty top-level brand, an existing brand attribute, or an existing brand dictionary ID.
- Apply the fallback only to required, ordinary (`complexId=0`), dictionary-backed attribute `85` in the current target category.
- Do not write collection evidence or add a database migration.
- Do not create a job, call AI, import an Ozon product, or change stock when fallback resolution fails.
- Do not expose raw Ozon responses, credentials, candidates, or internal errors.

---

### Task 1: Dynamically Freeze the Official No-Brand Value

**Files:**
- Modify: `server/auto-listing-listing-base-preparer.mjs`
- Test: `server/tests/auto-listing-listing-base-preparer.test.mjs`

**Interfaces:**
- Consumes: current `rawItems`, projected `sourceEvidenceAttributes`, normalized current category metadata, and `categoryService.getCategoryAttributeValues(...)`.
- Produces: source attributes in which only genuinely missing brand slots receive `{ complex_id: 0, id: 85, values: [{ value, dictionary_value_id }] }`, or throws `AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED`.

- [ ] **Step 1: Add a failing end-to-end preparer test for a genuinely missing brand**

```js
test("dynamically freezes the current Ozon no-brand option for variants with no brand", async () => {
  const itemSource = source();
  const reads = [];
  const deps = dependencies({
    categoryService: {
      async getCategoryAttributes() {
        return { items: [
          { id: 85, dictionary_id: 28732849, is_required: true },
          { id: 11254 },
        ] };
      },
      async getCategoryAttributeValues(input) {
        reads.push({ attributeId: input.attributeId, matchCandidates: input.matchCandidates });
        return { items: [{ id: 987654321, value: "Нет бренда" }] };
      },
    },
  });
  delete deps.normalizeItems;

  const result = await createAutoListingListingBasePreparer(deps)({
    accountId: "account-a",
    source: itemSource,
    targetStore: { id: "store-a", ownerAccountId: "account-a" },
    targetCategory: frozenTargetCategory(),
    pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
  });

  assert.deepEqual(reads, [{ attributeId: 85, matchCandidates: [{ value: "Нет бренда" }] }]);
  assert.deepEqual(result.variants.map(({ item }) =>
    item.attributes.find(({ id }) => id === 85)?.values), [
    [{ value: "Нет бренда", dictionary_value_id: 987654321 }],
    [{ value: "Нет бренда", dictionary_value_id: 987654321 }],
  ]);
});
```

- [ ] **Step 2: Run the named test and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern="dynamically freezes the current Ozon no-brand option" server/tests/auto-listing-listing-base-preparer.test.mjs
```

Expected: FAIL because strict required-attribute validation still throws `AUTO_LISTING_CATEGORY_ATTRIBUTES_INCOMPLETE`.

- [ ] **Step 3: Add missing-brand detection and exact dynamic fallback**

Add focused helpers in `server/auto-listing-listing-base-preparer.mjs` with these contracts:

```js
const BRAND_ATTRIBUTE_ID = 85;
const OZON_NO_BRAND_VALUE = "Нет бренда";

function normalizedNoBrand(value) {
  return text(value).replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
}

function attributeCarriesBrand(attribute) {
  const id = positiveId(attribute?.id ?? attribute?.attribute_id ?? attribute?.attributeId ?? attribute?.key);
  const complexId = positiveId(
    attribute?.complex_id ?? attribute?.complexId ?? attribute?.attribute_complex_id,
  ) || 0;
  if (id !== BRAND_ATTRIBUTE_ID || complexId !== 0) return false;
  if (Array.isArray(attribute?.values) && attribute.values.length) return true;
  if (Array.isArray(attribute?.collection) && attribute.collection.length) return true;
  return text(attribute?.value) !== "" || positiveId(
    attribute?.dictionary_value_id ?? attribute?.dictionaryValueId,
  ) > 0;
}

function itemCarriesBrand(item, sourceAttributes) {
  if (text(item?.brand)) return true;
  const candidates = [
    ...(Array.isArray(item?.attributes) ? item.attributes : []),
    ...(Array.isArray(item?._bundleItem?.attributes) ? item._bundleItem.attributes : []),
    ...(Array.isArray(sourceAttributes) ? sourceAttributes : []),
    ...(Array.isArray(item?.complex_attributes)
      ? item.complex_attributes.flatMap((group) => Array.isArray(group?.attributes) ? group.attributes : [])
      : []),
  ];
  return candidates.some(attributeCarriesBrand);
}

function missingNoBrandVariantIndexes({ rawItems, sourceEvidenceAttributes, metadata }) {
  const brand = metadata.attributes.find((attribute) =>
    attribute.id === BRAND_ATTRIBUTE_ID
      && attribute.complexId === 0
      && attribute.required === true
      && positiveId(attribute.dictionaryId));
  if (!brand) return [];
  return rawItems.flatMap((item, index) =>
    itemCarriesBrand(item, sourceEvidenceAttributes[index]) ? [] : [index]);
}

function canonicalNoBrandOption(values) {
  try {
    const matches = Array.isArray(values) ? values.flatMap((option) => {
      const id = positiveId(option?.id);
      const value = text(option?.value);
      return id && normalizedNoBrand(value) === normalizedNoBrand(OZON_NO_BRAND_VALUE)
        ? [{ id, value }]
        : [];
    }) : [];
    if (matches.length === 1) return matches[0];
  } catch {}
  throw failure("AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED");
}

function injectNoBrandSourceEvidence(sourceEvidenceAttributes, indexes, option) {
  const missing = new Set(indexes);
  return sourceEvidenceAttributes.map((attributes, index) => missing.has(index)
    ? [...attributes, {
        complex_id: 0,
        id: BRAND_ATTRIBUTE_ID,
        values: [{ value: option.value, dictionary_value_id: option.id }],
      }]
    : attributes);
}
```

Before dictionary reads, compute missing indexes from preliminary metadata. For attribute `85`, append `{ value: "Нет бренда" }` to `matchCandidates` only when at least one variant needs fallback. After the brand dictionary result is stored, require one canonical live option and inject it before `hydrateSourceDictionaryAttributes(...)`. Do not change the existing strict normalizer or rebuilder.

- [ ] **Step 4: Run the named test and verify GREEN**

Run the Step 2 command again.

Expected: PASS with live test ID `987654321`, proving no production dictionary ID constant is used.

- [ ] **Step 5: Add fail-closed and preservation tests**

Add parameterized tests covering:

```js
for (const [name, items] of [
  ["empty", []],
  ["different value", [{ id: 1, value: "Brand X" }]],
  ["ambiguous", [{ id: 11, value: "Нет бренда" }, { id: 12, value: "Нет бренда" }]],
  ["invalid id", [{ id: 0, value: "Нет бренда" }]],
]) {
  test(`missing brand fails closed for ${name} current dictionary evidence`, async () => {
    const deps = dependencies({
      categoryService: {
        async getCategoryAttributes() {
          return { items: [
            { id: 85, dictionary_id: 28732849, is_required: true },
            { id: 11254 },
          ] };
        },
        async getCategoryAttributeValues() { return { items }; },
      },
    });
    delete deps.normalizeItems;
    await assert.rejects(createAutoListingListingBasePreparer(deps)({
      accountId: "account-a",
      source: source(),
      targetStore: { id: "store-a", ownerAccountId: "account-a" },
      targetCategory: frozenTargetCategory(),
      pricingEvidence: { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" },
    }), {
      code: "AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED",
      status: 422,
      retryable: false,
      cause: null,
    });
  });
}
```

Also assert:

- a valid existing `85` attribute is unchanged and no no-brand candidate is appended;
- a non-empty `item.brand` prevents no-brand injection;
- optional, non-dictionary, or complex brand metadata does not activate fallback;
- one missing variant and one branded variant injects only the missing variant;
- dependency failures expose only `AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED`, status 422, `retryable=false`, and `cause=null`.

- [ ] **Step 6: Run focused core regressions**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/auto-listing-listing-base-preparer.test.mjs server/tests/ozon-import-normalizer.test.mjs server/tests/ozon-category-item-rebuilder.test.mjs
```

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit the core behavior**

```bash
git add server/auto-listing-listing-base-preparer.mjs server/tests/auto-listing-listing-base-preparer.test.mjs
git commit -m "fix: resolve missing automatic-listing brand"
```

### Task 2: Publish the Safe Missing-Brand Error Contract

**Files:**
- Modify: `server/auto-listing-routes.mjs`
- Modify: `server/tests/auto-listing-routes.test.mjs`
- Modify: `app/src/auto-listing-config.js`
- Modify: `app/tests/auto-listing-config.test.mjs`

**Interfaces:**
- Consumes: thrown `AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED`.
- Produces: HTTP 422 with the fixed safe Chinese message, and the same message from `autoListingTaskErrorMessage(error)`.

- [ ] **Step 1: Add failing route and frontend message tests**

Extend the route matrix with:

```js
[
  "AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED",
  422,
  "商品缺少品牌，且 Ozon 当前类目未提供唯一的“无品牌”选项，请补全品牌后重试",
]
```

Add to `app/tests/auto-listing-config.test.mjs`:

```js
test("presents a specific safe error when a missing brand cannot use Ozon no-brand", () => {
  assert.equal(autoListingTaskErrorMessage({
    code: "AUTO_LISTING_REQUIRED_BRAND_UNRESOLVED",
    message: "raw must not leak",
  }), "商品缺少品牌，且 Ozon 当前类目未提供唯一的“无品牌”选项，请补全品牌后重试");
});
```

- [ ] **Step 2: Run both named suites and verify RED**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/auto-listing-routes.test.mjs app/tests/auto-listing-config.test.mjs
```

Expected: route test returns the generic 500 contract and frontend test returns `raw must not leak`.

- [ ] **Step 3: Add the stable backend and frontend mappings**

In `server/auto-listing-routes.mjs`, add the code to `PUBLIC_ERRORS` with status 422 and to `messageFor(code)` with the fixed message. In `app/src/auto-listing-config.js`, add the identical fixed message to `AUTO_LISTING_RFBS_ERROR_MESSAGES`.

- [ ] **Step 4: Re-run both suites and verify GREEN**

Run the Step 2 command again.

Expected: both suites pass with zero failures and raw messages are not exposed.

- [ ] **Step 5: Run the full affected regression set and build**

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/auto-listing-listing-base-preparer.test.mjs server/tests/ozon-import-normalizer.test.mjs server/tests/ozon-category-item-rebuilder.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-routes.test.mjs app/tests/auto-listing-config.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
git diff --check
```

Expected: zero test failures, Vite build exit 0, and no whitespace errors.

- [ ] **Step 6: Perform read-only live acceptance**

Use the existing production composition against `collect_bce1e3bb59023e8d0ca6755e` and store `local_a936f178c376` to call only the listing-base preparer. Assert:

```js
assert.equal(result.variants.length, 11);
assert.ok(result.variants.every(({ item }) =>
  item.attributes.some(({ id, values }) => id === 85
    && values.length === 1
    && values[0].value === "Нет бренда"
    && Number.isSafeInteger(values[0].dictionary_value_id)
    && values[0].dictionary_value_id > 0)));
```

Do not call the create-job route and do not click “创建生成任务”.

- [ ] **Step 7: Commit the public contract and final verification**

```bash
git add server/auto-listing-routes.mjs server/tests/auto-listing-routes.test.mjs app/src/auto-listing-config.js app/tests/auto-listing-config.test.mjs docs/superpowers/plans/2026-08-15-auto-listing-no-brand-fallback.md
git commit -m "fix: explain unresolved automatic-listing brand"
```
