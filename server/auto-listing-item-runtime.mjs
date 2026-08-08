import { createPostgresAutoListingAiRetryRepository } from "./auto-listing-ai-retry-postgres.mjs";
import { createAutoListingAiRetryService } from "./auto-listing-ai-retry-service.mjs";
import { createAutoListingItemService } from "./auto-listing-item-service.mjs";
import { createPostgresAutoListingReviewRepository } from "./auto-listing-review-postgres.mjs";
import { createAutoListingReviewService } from "./auto-listing-review-service.mjs";
import { createPostgresAutoListingUserItemActionRepository } from "./auto-listing-user-item-action-postgres.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { autoListingEnabled } from "./runtime-config.mjs";

function runtimeError(code, status, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_ITEM_DISABLED"
    ? "自动上架功能尚未启用" : "自动上架商品操作服务暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

export function createAutoListingItemRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  createActionRepository = createPostgresAutoListingUserItemActionRepository,
  createRetryRepository = createPostgresAutoListingAiRetryRepository,
  createRetryService = createAutoListingAiRetryService,
  createReviewRepository = createPostgresAutoListingReviewRepository,
  createReviewService = createAutoListingReviewService,
  createItemService = createAutoListingItemService,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)
    || [resolvePool, createActionRepository, createRetryRepository, createRetryService,
      createReviewRepository, createReviewService, createItemService]
      .some((factory) => typeof factory !== "function")) {
    throw new TypeError("Auto-listing item runtime dependencies are required");
  }
  let servicePromise = null;
  function getService() {
    if (!autoListingEnabled(env)) {
      return Promise.reject(runtimeError("AUTO_LISTING_ITEM_DISABLED", 404));
    }
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        let pool;
        try { pool = await resolvePool(); } catch {
          throw runtimeError("AUTO_LISTING_ITEM_INITIALIZATION_FAILED", 503, true);
        }
        if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
          throw runtimeError("AUTO_LISTING_ITEM_INITIALIZATION_FAILED", 503, true);
        }
        try {
          const actionRepository = createActionRepository({ pool });
          const retryRepository = createRetryRepository({ pool });
          const retryService = createRetryService({ repository: retryRepository });
          const reviewRepository = createReviewRepository({ pool });
          const reviewService = createReviewService({ repository: reviewRepository });
          return createItemService({ actionRepository, retryService, reviewService });
        } catch (error) {
          if (error?.code === "AUTO_LISTING_ITEM_INITIALIZATION_FAILED") throw error;
          throw runtimeError("AUTO_LISTING_ITEM_INITIALIZATION_FAILED", 503, true);
        }
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
