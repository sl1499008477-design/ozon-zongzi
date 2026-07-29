import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  serverEntry,
  appEntry,
  accountContext,
  collectionPipeline,
  legacyDataCollectionStore,
] = await Promise.all([
  readFile(new URL("../index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../app/src/App.jsx", import.meta.url), "utf8"),
  readFile(new URL("../account-context.mjs", import.meta.url), "utf8"),
  readFile(new URL("../collection-pipeline.mjs", import.meta.url), "utf8"),
  readFile(new URL("../legacy-data-collection-store.mjs", import.meta.url), "utf8"),
]);

assert.ok(
  serverEntry.split("\n").length <= 5200,
  "server/index.mjs exceeded its migration guard; add new behavior in a focused module",
);
assert.ok(
  appEntry.split("\n").length <= 9850,
  "app/src/App.jsx exceeded its migration guard; add new pages outside App.jsx",
);

for (const functionName of [
  "createAccountRecord",
  "requireAuth",
  "requireAdmin",
  "activeStore",
  "storeIdForAccountRequest",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`function\\s+${functionName}\\s*\\(`),
    `${functionName} belongs in account-context.mjs`,
  );
}

for (const functionName of [
  "ozonCall",
  "ozonGet",
  "syncStoreProfile",
  "refreshStoreProfiles",
  "syncProducts",
  "syncPostings",
  "syncWarehouses",
  "syncPromotions",
  "runLocalSync",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`),
    `${functionName} must remain outside server/index.mjs`,
  );
}

for (const functionName of [
  "cacheKeyForStore",
  "getOzonDescriptionCategoryTree",
  "findDescriptionCategoryIdByTypeId",
  "getOzonDescriptionCategoryAttributes",
  "getOzonDescriptionCategoryAttributeValues",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`),
    `${functionName} belongs in ozon-category-service.mjs`,
  );
}

assert.doesNotMatch(
  serverEntry,
  /inferred:\\s*true/,
  "category routes must never return locally inferred category data",
);

for (const retiredHelper of [
  "activeDataCollectionStore",
  "backfillCollectionStoresFromLegacy",
  "createDataCollectionStoreId",
  "currentDataCollectionStoreIdForAccount",
  "dataCollectionStoresForAccount",
  "deleteCollectionStoreForAccount",
  "hydrateCollectionStoresIntoState",
  "listCollectionStoresForAccount",
  "setCurrentCollectionStoreForAccount",
  "setCurrentDataCollectionStoreForAccount",
  "upsertCollectionStoreForAccount",
  "verifyCollectionStoreForAccount",
]) {
  assert.equal(
    serverEntry.includes(retiredHelper),
    false,
    `${retiredHelper} must not remain in the active server entry`,
  );
  assert.equal(
    accountContext.includes(`export function ${retiredHelper}`),
    false,
    `${retiredHelper} must not remain an account-context API`,
  );
  assert.equal(
    collectionPipeline.includes(`export function ${retiredHelper}`),
    false,
    `${retiredHelper} must not remain a collection-pipeline API`,
  );
  assert.equal(
    collectionPipeline.includes(`export async function ${retiredHelper}`),
    false,
    `${retiredHelper} must not remain an async collection-pipeline API`,
  );
}

assert.match(
  legacyDataCollectionStore,
  /readLegacyDataCollectionStoresForAudit/,
  "historical data-store evidence must live in the read-only legacy module",
);
assert.doesNotMatch(
  legacyDataCollectionStore,
  /\b(?:INSERT|UPDATE|DELETE)\b/i,
  "the legacy data-store module must remain read-only",
);

for (const pageName of [
  "AccountSettingsPage",
  "PricingSettingsPage",
  "StoresSettingsPage",
  "ProfitTrendPage",
  "DataScreenPage",
]) {
  assert.doesNotMatch(
    appEntry,
    new RegExp(`function\\s+${pageName}\\s*\\(`),
    `${pageName} must remain an independent page module`,
  );
}

console.log("module boundary guards passed");
