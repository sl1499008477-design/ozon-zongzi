import { createJsonAccountScopedCollectionHandler } from "./account-scoped-collection-routes.mjs";
import { createCollectCategoryResolutionRuntime } from "./collect-category-resolution-runtime.mjs";
import { createCollectorOzonEnrichmentRuntime } from "./collector-ozon-enrichment-runtime.mjs";

function optionalFunctionPort(options, name) {
  if (!Object.hasOwn(options, name)) return {};
  if (typeof options[name] !== "function") {
    throw new TypeError(`${name} override must be a function`);
  }
  return { [name]: options[name] };
}

function optionalTimersPort(options) {
  if (!Object.hasOwn(options, "timers")) return {};
  const timers = options.timers;
  if (
    !timers
    || typeof timers.setTimeout !== "function"
    || typeof timers.clearTimeout !== "function"
    || typeof timers.setInterval !== "function"
    || typeof timers.clearInterval !== "function"
  ) {
    throw new TypeError("timers override must provide timeout and interval functions");
  }
  return { timers };
}

export function createOperatingStoreNotifier(
  categoryResolutionRuntime,
  categoryService,
  logger = console,
) {
  return async function notifyOperatingStoreAvailable({
    accountId,
    storeId,
    invalidateCategoryCache = false,
  }) {
    try {
      if (invalidateCategoryCache) categoryService?.invalidateStore?.({ accountId, storeId });
      await categoryResolutionRuntime.onOperatingStoreAvailable({ accountId, storeId });
    } catch (error) {
      const code = String(error?.code || "CATEGORY_RESOLUTION_STORE_WAKE_FAILED")
        .trim().toUpperCase();
      try {
        logger?.error?.("collect category store wake failed", {
          accountId: String(accountId || ""),
          storeId: String(storeId || ""),
          code: /^[A-Z][A-Z0-9_]{0,119}$/.test(code)
            ? code
            : "CATEGORY_RESOLUTION_STORE_WAKE_FAILED",
        });
      } catch {
        // Store persistence is committed; periodic reconciliation remains the recovery path.
      }
    }
  };
}

export function createCollectCategoryAutoResolutionComposition(options = {}) {
  const {
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
    logger = console,
  } = options;
  const nowOverride = optionalFunctionPort(options, "now");
  const randomUUIDOverride = optionalFunctionPort(options, "randomUUID");
  const sleepOverride = optionalFunctionPort(options, "sleep");
  const timersOverride = optionalTimersPort(options);
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
    ...nowOverride,
    ...randomUUIDOverride,
    ...timersOverride,
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
    ...nowOverride,
    ...randomUUIDOverride,
    ...sleepOverride,
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
    ...nowOverride,
  });

  return Object.freeze({
    categoryService,
    collectCategoryResolutionRuntime,
    collectorOzonEnrichmentRuntime,
    handleJsonAccountScopedCollectionRoute,
  });
}
