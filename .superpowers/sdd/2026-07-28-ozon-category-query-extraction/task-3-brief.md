### Task 3: Add Atomic Dictionary Pagination And Expiry Failure Tests

**Files:**
- Modify: `server/ozon-category-service.mjs`
- Modify: `server/tests/ozon-category-service.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: Task 2 `createOzonCategoryService` and scoped cache.
- Produces: complete `getCategoryAttributeValues(input)` with page normalization, deduplication, bounded limit, cursor protection and atomic cache write.

- [ ] **Step 1: Write failing multi-page and response-shape tests**

Add a mock sequence:

```js
[
  {
    result: {
      values: [{ id: 1, value: "One" }, { dictionary_value_id: 2, name: "Two" }],
      has_next: true,
    },
  },
  {
    result: [{ id: 3, value: "Three" }],
    has_next: false,
  },
]
```

Assert:

```js
assert.deepEqual(result.items.map((item) => item.id), [1, 2, 3]);
assert.equal(secondCall.body.last_value_id, 2);
assert.equal(result.meta.source, "OZON_API");
```

Also assert:

- duplicate `{id,value}` entries appear once;
- `limit` is clamped to `1..5000`;
- each Ozon page limit is at most 1000;
- `result` array and `result.values` array are both accepted.

- [ ] **Step 2: Write failing atomicity and repeated-cursor tests**

Cases:

1. Page 1 succeeds, page 2 throws: the next call must call Ozon again from page 1.
2. `has_next: true` repeats the same non-zero `last_value_id`: reject with
   `OZON_CATEGORY_DATA_INVALID`.
3. TTL expires, refresh fails: old items are not returned.
4. Invalid response shape: no cache entry is created.

Use:

```js
await assert.rejects(
  () => service.getCategoryAttributeValues(input),
  (error) => {
    assert.equal(error.code, "OZON_CATEGORY_DATA_INVALID");
    assert.equal(error.cause, null);
    return true;
  },
);
```

- [ ] **Step 3: Run the service test and verify RED**

Run:

```bash
node server/tests/ozon-category-service.test.mjs
```

Expected: FAIL on the new pagination or atomicity assertions.

- [ ] **Step 4: Implement local-page accumulation and terminal checks**

Use local variables only until all pages succeed:

```js
const values = [];
const seenValues = new Set();
const seenCursors = new Set();
let lastValueId = 0;

while (values.length < safeLimit) {
  const pageLimit = Math.min(1000, safeLimit - values.length);
  const data = await callOzonSellerApi(
    store,
    "/v1/description-category/attribute/values",
    {
      description_category_id: normalizedDescriptionCategoryId,
      type_id: normalizedTypeId,
      attribute_id: normalizedAttributeId,
      language: normalizedLanguage,
      limit: pageLimit,
      ...(lastValueId ? { last_value_id: lastValueId } : {}),
    },
    60000,
  );
  const page = Array.isArray(data?.result)
    ? data.result
    : Array.isArray(data?.result?.values)
      ? data.result.values
      : null;
  if (!page) throw categoryError("VALUES", 502, "OZON_CATEGORY_DATA_INVALID");
  if (page.length === 0) break;

  // Normalize and deduplicate into the local `values` array.

  const nextCursor = positiveIdOf(page.at(-1));
  const hasNext = Boolean(data?.has_next || data?.result?.has_next);
  if (!hasNext) break;
  if (!nextCursor || seenCursors.has(nextCursor)) {
    throw categoryError("VALUES", 502, "OZON_CATEGORY_DATA_INVALID");
  }
  seenCursors.add(nextCursor);
  lastValueId = nextCursor;
}

return writeCache(key, values);
```

Never call `writeCache` inside the loop.

- [ ] **Step 5: Run service and client regression**

Run:

```bash
node --check server/ozon-category-service.mjs
node server/tests/ozon-category-service.test.mjs
node server/tests/ozon-client.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Review checkpoint**

Inspect the scoped diff for:

- no unbounded loop;
- repeated cursor fails immediately;
- no half-page cache write;
- no stale-on-error branch;
- no raw upstream error copied to public output.

---
