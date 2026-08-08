import { createAiGatewayProfileService } from "./ai-gateway-profile-service.mjs";
import { createAutoListingAiAdminPostgres } from "./auto-listing-ai-admin-postgres.mjs";
import { createAutoListingAiAdminService } from "./auto-listing-ai-admin-service.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { autoListingEnabled } from "./runtime-config.mjs";
import { createSub2ApiAdapter } from "./sub2api-ai-adapter.mjs";
import { createSub2ApiGatewayPolicy } from "./sub2api-gateway-boundary.mjs";

function runtimeError(code, status, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_AI_ADMIN_DISABLED"
    ? "自动上架功能尚未启用" : "自动上架 AI 管理服务暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function parseBoolean(env, name, fallback = false) {
  const raw = typeof env?.[name] === "string" ? env[name].trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (["1", "true"].includes(raw)) return true;
  if (["0", "false"].includes(raw)) return false;
  throw runtimeError("AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID", 500);
}

function csv(env, name) {
  const raw = typeof env?.[name] === "string" ? env[name] : "";
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) {
    throw runtimeError("AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID", 500);
  }
  return values;
}

function configuration(env) {
  try {
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw runtimeError("AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID", 500);
    }
    const allowLocalGateway = parseBoolean(env, "AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY", false);
    if (allowLocalGateway && String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
      throw runtimeError("AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID", 500);
    }
    const allowedSecretEnvNames = csv(env, "AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES");
    const allowedGatewayBaseUrls = csv(env, "AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS");
    const allowedGatewayOrigins = csv(env, "AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS");
    if (allowedSecretEnvNames.length === 0
      || (allowedGatewayBaseUrls.length === 0 && allowedGatewayOrigins.length === 0)) {
      throw runtimeError("AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID", 500);
    }
    const policy = createSub2ApiGatewayPolicy({
      allowedSecretEnvNames,
      allowedGatewayBaseUrls,
      allowedGatewayOrigins,
      allowLocalGateway,
    });
    return Object.freeze({
      allowLocalGateway,
      allowedSecretEnvNames: policy.allowedSecretEnvNames,
      allowedGatewayBaseUrls: policy.allowedGatewayBaseUrls,
      allowedGatewayOrigins: policy.allowedGatewayOrigins,
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID") throw error;
    throw runtimeError("AUTO_LISTING_AI_ADMIN_CONFIGURATION_INVALID", 500);
  }
}

function secretReader(env, names) {
  const allowed = new Set(names);
  return (name) => {
    if (typeof name !== "string" || !allowed.has(name)
      || !/^[A-Za-z_][A-Za-z0-9_]{0,119}$/u.test(name)
      || ["__proto__", "prototype", "constructor"].includes(name.toLowerCase())) return undefined;
    return typeof env[name] === "string" ? env[name] : undefined;
  };
}

export function createAutoListingAiAdminRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  createRepository = createAutoListingAiAdminPostgres,
  createGateway = createSub2ApiAdapter,
  createCapabilityService = createAiGatewayProfileService,
  createAdminService = createAutoListingAiAdminService,
  resolveGatewayHostname,
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)
    || typeof resolvePool !== "function" || typeof createRepository !== "function"
    || typeof createGateway !== "function" || typeof createCapabilityService !== "function"
    || typeof createAdminService !== "function"
    || !(resolveGatewayHostname === undefined || typeof resolveGatewayHostname === "function")) {
    throw new TypeError("Auto-listing AI admin runtime dependencies are required");
  }

  let servicePromise = null;
  function getService() {
    if (!autoListingEnabled(env)) {
      return Promise.reject(runtimeError("AUTO_LISTING_AI_ADMIN_DISABLED", 404));
    }
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        const config = configuration(env);
        let pool;
        try { pool = await resolvePool(); } catch {
          throw runtimeError("AUTO_LISTING_AI_ADMIN_INITIALIZATION_FAILED", 503, true);
        }
        if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
          throw runtimeError("AUTO_LISTING_AI_ADMIN_INITIALIZATION_FAILED", 503, true);
        }
        try {
          const repository = createRepository({ pool });
          const gateway = createGateway({
            readSecret: secretReader(env, config.allowedSecretEnvNames),
            allowLocalGateway: config.allowLocalGateway,
            ...(resolveGatewayHostname ? { resolveHostname: resolveGatewayHostname } : {}),
            allowedSecretEnvNames: config.allowedSecretEnvNames,
            allowedGatewayBaseUrls: config.allowedGatewayBaseUrls,
            allowedGatewayOrigins: config.allowedGatewayOrigins,
          });
          const capabilityService = createCapabilityService({ repository, gateway });
          return createAdminService({
            repository,
            capabilityService,
            allowLocalGateway: config.allowLocalGateway,
            resolveGatewayHostname,
            allowedSecretEnvNames: config.allowedSecretEnvNames,
            allowedGatewayBaseUrls: config.allowedGatewayBaseUrls,
            allowedGatewayOrigins: config.allowedGatewayOrigins,
          });
        } catch (error) {
          if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_AI_ADMIN_")) throw error;
          throw runtimeError("AUTO_LISTING_AI_ADMIN_INITIALIZATION_FAILED", 503, true);
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
