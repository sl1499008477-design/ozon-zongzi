import assert from "node:assert/strict";
import { parse } from "acorn";
import { readFile } from "node:fs/promises";
import { assertCategoryResolutionPortBoundary } from "../module-import-boundary.mjs";

const [
  serverEntry,
  appEntry,
  accountContext,
  collectionPipeline,
  legacyDataCollectionStore,
  formalPersistence,
  enrichmentService,
  enrichmentRoutes,
  enrichmentRuntime,
  categoryResolutionRuntime,
  accountScopedCollectionRoutes,
  autoListingRoutes,
  autoListingRuntime,
  sharedCategoryRepository,
] = await Promise.all([
  readFile(new URL("../index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../app/src/App.jsx", import.meta.url), "utf8"),
  readFile(new URL("../account-context.mjs", import.meta.url), "utf8"),
  readFile(new URL("../collection-pipeline.mjs", import.meta.url), "utf8"),
  readFile(new URL("../legacy-data-collection-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../formal-persistence.mjs", import.meta.url), "utf8"),
  readFile(new URL("../collector-ozon-enrichment-service.mjs", import.meta.url), "utf8"),
  readFile(new URL("../collector-ozon-enrichment-routes.mjs", import.meta.url), "utf8"),
  readFile(new URL("../collector-ozon-enrichment-runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../collect-category-resolution-runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../account-scoped-collection-routes.mjs", import.meta.url), "utf8"),
  readFile(new URL("../auto-listing-routes.mjs", import.meta.url), "utf8"),
  readFile(new URL("../auto-listing-runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../account-shared-ozon-category-repository.mjs", import.meta.url), "utf8"),
]);

assert.doesNotMatch(
  sharedCategoryRepository,
  /store_id|storeId|credential|ozon-client|fetch\s*\(/i,
  "account-shared category persistence cannot carry store identity, credentials, or network access",
);
for (const modulePath of [
  "server/collect-category-resolution-runtime.mjs",
  "server/collect-category-auto-resolution-composition.mjs",
  "server/collect-category-resolution-service.mjs",
  "server/collector-ozon-enrichment-service.mjs",
  "server/account-shared-ozon-category-service.mjs",
]) {
  assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(
    'import repository from "./account-shared-ozon-category-repository.mjs";',
    { label: modulePath, modulePath },
  ));
}
assert.throws(
  () => assertCategoryResolutionPortBoundary(
    'import repository from "./account-shared-ozon-category-repository.mjs";',
    { label: "server/index.mjs", modulePath: "server/index.mjs" },
  ),
  (error) => error?.code === "CATEGORY_RESOLUTION_MODULE_BOUNDARY",
);

assert.ok(
  serverEntry.split("\n").length <= 5215,
  "server/index.mjs exceeded its migration guard; add new behavior in a focused module",
);
assert.ok(
  appEntry.split("\n").length <= 9850,
  "app/src/App.jsx exceeded its migration guard; add new pages outside App.jsx",
);

for (const functionName of [
  "createCollectorOzonEnrichmentService",
  "createCollectorOzonEnrichmentHttpHandler",
  "createCollectorOzonEnrichmentRuntime",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`function\\s+${functionName}\\s*\\(`),
    `${functionName} must remain in the focused Ozon enrichment modules`,
  );
}
assert.doesNotMatch(
  enrichmentService,
  /(?:persistenceMode|getPostgresPool|loadState|saveState)/,
  "Ozon enrichment service must depend only on its repository port",
);
assert.doesNotMatch(
  enrichmentRoutes,
  /(?:getPostgresPool|createJsonCollectorOzonEnrichmentRepository|loadState|saveState)/,
  "Ozon enrichment routes must not own persistence",
);
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}

function assertAutoListingRouteBoundary(source) {
  const imports = [];
  let hasQueryCall = false;
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  walk(program, (node) => {
    if (node.type === "ImportDeclaration") imports.push(node.source.value);
    if (node.type === "ImportExpression") {
      if (node.source?.type !== "Literal" || typeof node.source.value !== "string") {
        throw new Error("auto-listing routes must not use computed dynamic imports");
      }
      imports.push(node.source.value);
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
      const property = node.callee.property;
      const propertyName = node.callee.computed
        ? (property?.type === "Literal" && typeof property.value === "string" ? property.value : "")
        : (property?.type === "Identifier" ? property.name : "");
      if (propertyName === "query") hasQueryCall = true;
    }
  });
  assert.deepEqual(
    imports,
    ["./runtime-config.mjs", "./auto-listing-currency.mjs"],
    "auto-listing routes may import only feature configuration and pure currency policy",
  );
  assert.equal(hasQueryCall, false, "auto-listing routes must not execute SQL query calls");
}

assert.doesNotThrow(() => assertAutoListingRouteBoundary(autoListingRoutes));
for (const source of [
  'import { callOzonSellerApi } from "./ozon-client.mjs";',
  'import { createOpenAI } from "./ai-client.mjs";',
  'await import("./ai-client.mjs");',
  'await import("./ozon-client.mjs");',
  'await import("./" + moduleName);',
]) {
  assert.throws(() => assertAutoListingRouteBoundary(source), /auto-listing routes|may import only/);
}
for (const source of [
  'const rows = await executor.query("UPDATE auto_listing_jobs SET status=1");',
  'const rows = await executor["query"]("SELECT * FROM auto_listing_jobs");',
  "const rows = await executor['query']('DELETE FROM auto_listing_jobs');",
]) {
  const fixture = `import { autoListingEnabled } from "./runtime-config.mjs";
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";\n${source}`;
  assert.throws(() => assertAutoListingRouteBoundary(fixture), /must not execute SQL query calls/);
}
assert.match(
  autoListingRuntime,
  /createAutoListingRepository/,
  "auto-listing runtime must own repository composition",
);
assert.match(
  autoListingRuntime,
  /createAutoListingService/,
  "auto-listing runtime must own service composition",
);
assert.match(
  enrichmentRuntime,
  /createJsonCollectorOzonEnrichmentRepository/,
  "Ozon enrichment runtime must own JSON repository selection",
);
assert.match(
  enrichmentRuntime,
  /createPostgresCollectorOzonEnrichmentRepository/,
  "Ozon enrichment runtime must own PostgreSQL repository selection",
);
assert.match(
  categoryResolutionRuntime,
  /createJsonCollectCategoryResolutionRepository/,
  "category resolution runtime must own JSON repository selection",
);
assert.match(
  categoryResolutionRuntime,
  /createPostgresCollectCategoryResolutionRepository/,
  "category resolution runtime must own PostgreSQL repository selection",
);
assert.doesNotMatch(
  accountScopedCollectionRoutes,
  /CollectCategoryResolutionRepository|getPostgresPool|FROM\s+collect_category_resolutions/i,
  "account-scoped collection routes must use only the category resolution port",
);
assert.doesNotMatch(
  enrichmentService,
  /CollectCategoryResolutionRepository|getPostgresPool|FROM\s+collect_category_resolutions/i,
  "Ozon enrichment service must use only the category resolution port",
);
for (const [source, label] of [
  [accountScopedCollectionRoutes, "account-scoped collection routes"],
  [enrichmentService, "Ozon enrichment service"],
]) {
  assert.doesNotThrow(() => assertCategoryResolutionPortBoundary(source, { label }));
}
for (const [name, source, expectedSpecifier] of [
  ["named Repository", 'import { createRepository } from "./collect-category-resolution-repository.mjs";', "./collect-category-resolution-repository.mjs"],
  ["default Repository", 'import repository from "./collect-category-resolution-repository.mjs";', "./collect-category-resolution-repository.mjs"],
  ["side-effect Repository", 'import "./collect-category-resolution-repository.mjs";', "./collect-category-resolution-repository.mjs"],
  ["dynamic Repository", 'await import("./collect-category-resolution-repository.mjs");', "./collect-category-resolution-repository.mjs"],
  ["named database", 'import { getPool } from "./db/connection.mjs";', "./db/connection.mjs"],
  ["default database", 'import database from "../db/migrate.mjs";', "../db/migrate.mjs"],
  ["side-effect database", 'import "./db/bootstrap.mjs";', "./db/bootstrap.mjs"],
  ["dynamic database", 'await import("../db/connection.mjs");', "../db/connection.mjs"],
  ["nested dynamic database", 'await import("../db/internal/pool.mjs");', "../db/internal/pool.mjs"],
]) {
  assert.throws(
    () => assertCategoryResolutionPortBoundary(source, { label: `${name} fixture` }),
    (error) => error?.code === "CATEGORY_RESOLUTION_MODULE_BOUNDARY"
      && error?.specifier === expectedSpecifier,
    `${name} import must be rejected`,
  );
}
const collectorAuthRouteIndex = serverEntry.indexOf("collectorAuthRuntime.handleHttpRoute(req, res, url)");
const enrichmentRouteIndex = serverEntry.indexOf("collectorOzonEnrichmentRuntime.handleHttpRoute(req, res, url)");
const autoListingRouteIndex = serverEntry.indexOf("handleAutoListingRoute(req, res, url)");
const fastCollectionRouteIndex = serverEntry.indexOf(
  "handleFastCollectionRoute(req, res, url, {",
  enrichmentRouteIndex,
);
const broadJsonTransactionIndex = serverEntry.indexOf("return jsonStateTransaction.run(async () =>", enrichmentRouteIndex);
const fastCollectionHandlerIndex = serverEntry.indexOf("async function handleFastCollectionRoute(");
const fastStoreSnapshotIndex = serverEntry.indexOf(
  "const credentialStoreSnapshot = sourceCollectMatch",
  fastCollectionHandlerIndex,
);
const fastCollectionBodyIndex = serverEntry.indexOf(
  "const body = await readBody(req);",
  fastStoreSnapshotIndex,
);
assert.ok(
  collectorAuthRouteIndex >= 0
    && enrichmentRouteIndex > collectorAuthRouteIndex
    && fastCollectionRouteIndex > enrichmentRouteIndex
    && broadJsonTransactionIndex > enrichmentRouteIndex,
  "Ozon enrichment routes must run after Collector auth and before waiting could hold broad state",
);
assert.ok(
  autoListingRouteIndex > enrichmentRouteIndex && autoListingRouteIndex < broadJsonTransactionIndex,
  "auto-listing route must dispatch before the broad JSON state transaction",
);
assert.ok(
  fastStoreSnapshotIndex > fastCollectionHandlerIndex
    && fastCollectionBodyIndex > fastStoreSnapshotIndex,
  "fast PostgreSQL collection ingress must freeze its server-owned store before reading the body",
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
assert.match(
  legacyDataCollectionStore,
  /purgeLegacyDataCollectionStoresForAccount/,
  "privacy erasure must use the explicit audited legacy purge policy",
);
for (const legacyTable of [
  "account_data_collection_stores",
  "data_collection_stores",
  "collection_store_verifications",
]) {
  assert.equal(
    formalPersistence.includes(legacyTable),
    false,
    `formal-persistence must not directly access ${legacyTable}`,
  );
}

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
