import { createJsonAccountScopedCollectionHandler } from "./account-scoped-collection-routes.mjs";
import { createAccountSharedOzonCategoryRuntime } from "./account-shared-ozon-category-runtime.mjs";
import { createCollectorOzonEnrichmentRuntime } from "./collector-ozon-enrichment-runtime.mjs";

function optionalFunction(options, name) {
  if (!Object.hasOwn(options, name)) return {};
  if (typeof options[name] !== "function") throw new TypeError(`${name} override must be a function`);
  return { [name]: options[name] };
}
export function createAccountSharedOzonCategoryComposition(options = {}) {
  const {
    loadState,
    saveState,
    persistenceMode,
    stateTransaction,
    collectorAuthRuntime,
    authenticateAccount,
    readJson,
    sendJson,
    sendError,
    normalizeItem,
    countAccountItems,
    sourceLookup = null,
    logger = console,
  } = options;
  if (typeof loadState !== "function" || typeof saveState !== "function"
    || typeof persistenceMode !== "function" || typeof stateTransaction?.run !== "function"
    || typeof collectorAuthRuntime?.authenticateRequest !== "function"
    || typeof collectorAuthRuntime?.authenticateSessionRequest !== "function"
    || typeof authenticateAccount !== "function" || typeof readJson !== "function"
    || typeof sendJson !== "function" || typeof sendError !== "function"
    || typeof normalizeItem !== "function" || typeof countAccountItems !== "function") {
    throw new TypeError("Account-shared category composition dependencies required");
  }
  const runtime = createAccountSharedOzonCategoryRuntime({
    loadState,
    saveState,
    persistenceMode,
    stateTransaction,
    sourceLookup,
    ...optionalFunction(options, "now"),
    ...optionalFunction(options, "randomUUID"),
  });
  const collectorOzonEnrichmentRuntime = createCollectorOzonEnrichmentRuntime({
    loadState,
    saveState,
    persistenceMode,
    stateTransaction,
    authenticate: collectorAuthRuntime.authenticateSessionRequest,
    authenticateAccount,
    readJson,
    sendJson,
    categoryEvidencePort: runtime,
    ...optionalFunction(options, "now"),
    ...optionalFunction(options, "randomUUID"),
    ...optionalFunction(options, "sleep"),
    logger,
  });
  const handleJsonAccountScopedCollectionRoute = createJsonAccountScopedCollectionHandler({
    authenticate: collectorAuthRuntime.authenticateRequest,
    readJson,
    normalizeItem,
    loadState,
    saveState,
    stateTransaction,
    enqueueForCollect: collectorOzonEnrichmentRuntime.enqueueForCollect,
    completeLinkedJobsFromCollectEvidence:
      collectorOzonEnrichmentRuntime.completeLinkedJobsFromCollectEvidence,
    sendJson,
    sendError,
    countAccountItems,
    categoryEvidencePort: runtime,
    logger,
    ...optionalFunction(options, "now"),
  });
  const handleCategoryConfirmationRoute = runtime.createHttpHandler({
    authenticate: authenticateAccount,
    readJson,
    sendJson,
  });
  return Object.freeze({
    accountSharedOzonCategoryRuntime: runtime,
    collectorOzonEnrichmentRuntime,
    handleJsonAccountScopedCollectionRoute,
    handleCategoryConfirmationRoute,
  });
}
