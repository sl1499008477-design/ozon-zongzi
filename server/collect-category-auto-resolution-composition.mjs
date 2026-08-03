import { createJsonAccountScopedCollectionHandler } from "./account-scoped-collection-routes.mjs";
import { createCollectCategoryResolutionRuntime } from "./collect-category-resolution-runtime.mjs";
import { createCollectorOzonEnrichmentRuntime } from "./collector-ozon-enrichment-runtime.mjs";

export function createCollectCategoryAutoResolutionComposition({
  loadState,
  saveState,
  persistenceMode,
  stateTransaction,
  categoryService,
  currentCredentialStoreForAccount,
  collectorAuthRuntime,
  authenticateAccount,
  readJson,
  sendJson,
  sendError,
  normalizeItem,
  countAccountItems,
  now,
  randomUUID,
  sleep,
  logger = console,
  timers,
} = {}) {
  if (
    typeof loadState !== "function"
    || typeof saveState !== "function"
    || typeof persistenceMode !== "function"
    || typeof stateTransaction?.run !== "function"
    || typeof categoryService?.getCategorySnapshot !== "function"
    || typeof categoryService?.validateTarget !== "function"
    || typeof currentCredentialStoreForAccount !== "function"
    || typeof collectorAuthRuntime?.authenticateRequest !== "function"
    || typeof collectorAuthRuntime?.authenticateSessionRequest !== "function"
    || typeof authenticateAccount !== "function"
    || typeof readJson !== "function"
    || typeof sendJson !== "function"
    || typeof sendError !== "function"
    || typeof normalizeItem !== "function"
    || typeof countAccountItems !== "function"
  ) {
    throw new TypeError("collect category auto-resolution composition dependencies are required");
  }

  const collectCategoryResolutionRuntime = createCollectCategoryResolutionRuntime({
    loadState,
    saveState,
    persistenceMode,
    stateTransaction,
    categoryService,
    currentCredentialStoreForAccount,
    ...(now ? { now } : {}),
    ...(randomUUID ? { randomUUID } : {}),
    ...(timers ? { timers } : {}),
    logger,
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
    categoryResolutionPort: collectCategoryResolutionRuntime,
    ...(now ? { now } : {}),
    ...(randomUUID ? { randomUUID } : {}),
    ...(sleep ? { sleep } : {}),
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
    categoryResolutionPort: collectCategoryResolutionRuntime,
    logger,
    ...(now ? { now } : {}),
  });

  return Object.freeze({
    collectCategoryResolutionRuntime,
    collectorOzonEnrichmentRuntime,
    handleJsonAccountScopedCollectionRoute,
  });
}
