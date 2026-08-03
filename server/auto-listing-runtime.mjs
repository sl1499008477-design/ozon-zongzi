import { createAutoListingRepository } from "./auto-listing-repository.mjs";
import { createAutoListingService } from "./auto-listing-service.mjs";
import { getPostgresPool } from "./db/connection.mjs";

export function createAutoListingRuntime({
  getPostgresPool: resolvePool = getPostgresPool,
  createRepository = createAutoListingRepository,
  createService = createAutoListingService,
} = {}) {
  if (typeof resolvePool !== "function" || typeof createRepository !== "function" || typeof createService !== "function") {
    throw new TypeError("Auto listing runtime dependencies are required");
  }

  let servicePromise = null;
  function getService() {
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        const pool = await resolvePool();
        return createService({ repository: createRepository({ pool }) });
      });
      servicePromise = initialization;
      initialization.catch(() => {
        if (servicePromise === initialization) servicePromise = null;
      });
    }
    return servicePromise;
  }

  return Object.freeze({ getService });
}
