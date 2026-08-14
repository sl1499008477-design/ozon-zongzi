import { createPostgresAutoListingPlanDiagnosticRepository } from "./auto-listing-plan-diagnostic-postgres.mjs";
import { createPostgresAutoListingPlanDiagnosticContextRepository } from "./auto-listing-plan-diagnostic-context-postgres.mjs";
import { createAutoListingPlanDiagnosticService } from "./auto-listing-plan-diagnostic-service.mjs";
import { createDefaultAutoListingPlanDiagnosticProductionPorts } from "./auto-listing-ai-runtime-composition.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { autoListingAiEnabled, autoListingEnabled } from "./runtime-config.mjs";

function runtimeError(code, status = 503) {
  const error = new Error(code === "AUTO_LISTING_PLAN_DIAGNOSTIC_DISABLED"
    ? "图片规划诊断尚未启用" : "图片规划诊断暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = status >= 500;
  return error;
}

export function createAutoListingPlanDiagnosticRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  createRepository = createPostgresAutoListingPlanDiagnosticRepository,
  createContextRepository = createPostgresAutoListingPlanDiagnosticContextRepository,
  createReplayPorts = createDefaultAutoListingPlanDiagnosticProductionPorts,
  createService = createAutoListingPlanDiagnosticService,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env) || typeof resolvePool !== "function"
    || typeof createRepository !== "function" || typeof createContextRepository !== "function"
    || typeof createReplayPorts !== "function" || typeof createService !== "function") {
    throw new TypeError("Auto-listing plan diagnostic runtime dependencies are required");
  }
  let servicePromise = null;
  let replayDependenciesPromise = null;
  const getReplayDependencies = () => {
    if (!replayDependenciesPromise) {
      const initialization = Promise.resolve().then(async () => {
        const ports = await createReplayPorts({ env, resolvePool });
        const contextRepository = createContextRepository({ pool: ports.pool });
        return Object.freeze({
          contextRepository,
          gateway: ports.gateway,
          evidenceRepository: ports.evidenceRepository,
        });
      });
      replayDependenciesPromise = initialization;
      initialization.catch(() => {
        if (replayDependenciesPromise === initialization) replayDependenciesPromise = null;
      });
    }
    return replayDependenciesPromise;
  };
  function getService() {
    if (!autoListingEnabled(env) || !autoListingAiEnabled(env)) {
      return Promise.reject(runtimeError("AUTO_LISTING_PLAN_DIAGNOSTIC_DISABLED", 404));
    }
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        try {
          const pool = await resolvePool();
          if (typeof pool?.query !== "function") throw new Error("invalid pool");
          const repository = createRepository({ pool });
          return createService({ repository, getReplayDependencies });
        } catch {
          throw runtimeError("AUTO_LISTING_PLAN_DIAGNOSTIC_INITIALIZATION_FAILED", 503);
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
