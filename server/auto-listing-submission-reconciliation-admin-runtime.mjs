import { createPostgresAutoListingSubmissionReconciliationRepository } from "./auto-listing-submission-reconciliation-postgres.mjs";
import { createAutoListingSubmissionReconciliationAdminService } from "./auto-listing-submission-reconciliation-admin-service.mjs";
import { getPostgresPool } from "./db/connection.mjs";

function runtimeError(code = "AUTO_LISTING_RECONCILE_ADMIN_INITIALIZATION_FAILED", status = 503) {
  const error = new Error("自动上架对账恢复服务暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = status >= 500;
  return error;
}

export function createAutoListingSubmissionReconciliationAdminRuntime({
  enabled, getPool = getPostgresPool,
  createRepository = createPostgresAutoListingSubmissionReconciliationRepository,
  createService = createAutoListingSubmissionReconciliationAdminService,
} = {}) {
  if (typeof enabled !== "boolean" || typeof getPool !== "function"
    || typeof createRepository !== "function" || typeof createService !== "function") {
    throw new TypeError("Auto-listing reconciliation admin runtime dependencies are required");
  }
  let servicePromise = null;
  function getService() {
    if (!enabled) return Promise.reject(runtimeError("AUTO_LISTING_RECONCILE_ADMIN_DISABLED", 404));
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        try {
          const pool = await getPool();
          if (typeof pool?.query !== "function" || typeof pool?.connect !== "function") throw new Error("invalid pool");
          return createService({ repository: createRepository({ pool }) });
        } catch (error) {
          if (error?.code === "AUTO_LISTING_RECONCILE_ADMIN_DISABLED") throw error;
          throw runtimeError();
        }
      });
      servicePromise = initialization;
      initialization.catch(() => { if (servicePromise === initialization) servicePromise = null; });
    }
    return servicePromise;
  }
  return Object.freeze({ getService });
}
