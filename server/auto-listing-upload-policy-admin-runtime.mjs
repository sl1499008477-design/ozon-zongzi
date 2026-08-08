import { createPostgresAutoListingUploadPolicyAdminRepository } from "./auto-listing-upload-policy-admin-postgres.mjs";
import { createAutoListingUploadPolicyAdminService } from "./auto-listing-upload-policy-admin-service.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { autoListingEnabled, autoListingUploadEnabled } from "./runtime-config.mjs";

function runtimeError(code, status = 503, retryable = false) {
  const error = new Error("自动上架上传策略服务暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function enabled(value) {
  return ["1", "true"].includes(String(value ?? "").trim().toLowerCase());
}

export function createAutoListingUploadPolicyAdminRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  getPublicationRuntime,
  assertDirectSystemReady,
  createRepository = createPostgresAutoListingUploadPolicyAdminRepository,
  createService = createAutoListingUploadPolicyAdminService,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env) || typeof resolvePool !== "function"
    || typeof getPublicationRuntime !== "function" || typeof assertDirectSystemReady !== "function"
    || typeof createRepository !== "function"
    || typeof createService !== "function") {
    throw new TypeError("Auto-listing upload policy admin runtime dependencies are required");
  }
  let servicePromise = null;
  function getService() {
    if (!autoListingEnabled(env) || !autoListingUploadEnabled(env)) {
      return Promise.reject(runtimeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_DISABLED", 404));
    }
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        let pool; let publication;
        try {
          [pool, publication] = await Promise.all([resolvePool(), getPublicationRuntime()]);
        } catch {
          throw runtimeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED", 503, true);
        }
        if (typeof pool?.query !== "function" || typeof pool?.connect !== "function"
          || !publication?.publicationPolicy || typeof publication?.assertDirectReady !== "function"
          || typeof publication?.checkPublicationHealth !== "function") {
          throw runtimeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED", 503, true);
        }
        try {
          const repository = createRepository({ pool });
          const assertDirectReady = async ({ accountId } = {}) => {
            if (!enabled(env.AUTO_LISTING_DIRECT_UPLOAD_ALLOWED)
              || String(env.LISTING_PIPELINE_V3 ?? "1").trim() === "0") {
              throw runtimeError("AUTO_LISTING_DIRECT_POLICY_NOT_READY", 503, false);
            }
            try {
              const system = await assertDirectSystemReady({ accountId });
              if (system?.ready !== true) throw new Error("system not ready");
              return await publication.assertDirectReady({ accountId });
            } catch {
              throw runtimeError("AUTO_LISTING_DIRECT_POLICY_NOT_READY", 503, true);
            }
          };
          return createService({
            repository, publicationPolicy: publication.publicationPolicy, assertDirectReady,
            checkPublicationHealth: (input) => publication.checkPublicationHealth(input),
          });
        } catch (error) {
          if (error?.code === "AUTO_LISTING_DIRECT_POLICY_NOT_READY") throw error;
          throw runtimeError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INITIALIZATION_FAILED", 503, true);
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
