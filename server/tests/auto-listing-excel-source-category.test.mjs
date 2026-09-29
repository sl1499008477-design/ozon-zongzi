import assert from "node:assert/strict";

process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";

const { testExports } = await import("../index.mjs");

const account = { id: "excel-source-account" };

{
  let dependencyCalls = 0;
  const item = {
    id: "collect-without-type-name",
    sourceCategory: {},
  };

  const resolved = await testExports.resolveAutoListingExcelSourceCategory(item, account, {
    loadStateFn: async () => {
      dependencyCalls += 1;
      throw new Error("loadState must not run without a source type name");
    },
    categoryService: {
      resolveExactTypeByName: async () => {
        dependencyCalls += 1;
        throw new Error("category tree lookup must not run without a source type name");
      },
    },
  });

  assert.equal(dependencyCalls, 0);
  assert.equal(resolved.id, item.id);
  assert.equal(resolved.accountId, account.id);
  assert.equal(resolved.createdBy, account.id);
  assert.deepEqual(resolved.sourceCategory, {});
}

{
  let lookupArgs = null;
  const item = {
    id: "collect-with-type-name",
    sourceCategory: { typeName: "Печатная книга" },
  };
  const store = { id: "excel-source-store" };
  const resolved = await testExports.resolveAutoListingExcelSourceCategory(item, account, {
    store,
    loadStateFn: async () => {
      throw new Error("explicit PostgreSQL store must bypass JSON state");
    },
    categoryService: {
      resolveExactTypeByName: async (args) => {
        lookupArgs = args;
        return {
          descriptionCategoryId: 123,
          typeId: 456,
          typeName: "Печатная книга",
        };
      },
    },
  });

  assert.equal(lookupArgs.accountId, account.id);
  assert.equal(lookupArgs.store.id, store.id);
  assert.equal(lookupArgs.typeName, "Печатная книга");
  assert.equal(resolved.sourceCategory.descriptionCategoryId, 123);
  assert.equal(resolved.sourceCategory.typeIdCandidate, 456);
}

console.log("auto-listing Excel source category fallback passed");
