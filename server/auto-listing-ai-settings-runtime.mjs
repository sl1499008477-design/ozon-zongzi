import { createAiGatewayProfileService } from "./ai-gateway-profile-service.mjs";
import { createAutoListingAiAdminPostgres } from "./auto-listing-ai-admin-postgres.mjs";
import { loadAutoListingCredentialKey } from "./auto-listing-ai-credential-config.mjs";
import { createAutoListingCredentialCipher } from "./auto-listing-ai-credential-crypto.mjs";
import {
  createAutoListingAiCatalogSyncCredentialResolver,
  createAutoListingAiCredentialResolver,
} from "./auto-listing-ai-credential-resolver.mjs";
import { createAutoListingAiModelSyncService } from "./auto-listing-ai-model-sync-service.mjs";
import {
  createAutoListingAiModelSyncSchedulePostgres,
  createAutoListingAiModelSyncWorker,
} from "./auto-listing-ai-model-sync-worker.mjs";
import { createAutoListingAiSettingsPostgres } from "./auto-listing-ai-settings-postgres.mjs";
import { createAutoListingAiSettingsService } from "./auto-listing-ai-settings-service.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { autoListingAiEnabled, autoListingEnabled } from "./runtime-config.mjs";
import { createSub2ApiAdapter } from "./sub2api-ai-adapter.mjs";
import { createSub2ApiGatewayPolicy } from "./sub2api-gateway-boundary.mjs";

const WORKER_ID = "auto-listing-ai-model-sync-worker-v1";

function runtimeError(code, status, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_AI_SETTINGS_DISABLED"
    ? "自动上架 AI 模型设置尚未启用" : "自动上架 AI 模型设置暂时不可用");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function parseBoolean(env, name) {
  const value = typeof env?.[name] === "string" ? env[name].trim().toLowerCase() : "";
  if (!value) return false;
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw runtimeError("AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID", 500);
}

function csv(env, name) {
  const raw = typeof env?.[name] === "string" ? env[name] : "";
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) {
    throw runtimeError("AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID", 500);
  }
  return values;
}

function configuration(env) {
  try {
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw runtimeError("AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID", 500);
    }
    const allowLocalGateway = parseBoolean(env, "AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY");
    if (allowLocalGateway && String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
      throw runtimeError("AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID", 500);
    }
    const keyVersion = typeof env.AUTO_LISTING_CREDENTIAL_KEY_VERSION === "string"
      ? env.AUTO_LISTING_CREDENTIAL_KEY_VERSION.trim() : "";
    const legacySecretEnvNames = csv(env, "AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES");
    const allowedGatewayBaseUrls = csv(env, "AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS");
    const allowedGatewayOrigins = csv(env, "AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS");
    if (!keyVersion || (allowedGatewayBaseUrls.length === 0 && allowedGatewayOrigins.length === 0)) {
      throw runtimeError("AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID", 500);
    }
    const policy = createSub2ApiGatewayPolicy({
      allowedSecretEnvNames: [...legacySecretEnvNames, "SUB2API_ENCRYPTED_KEY"],
      allowedGatewayBaseUrls, allowedGatewayOrigins, allowLocalGateway,
    });
    return Object.freeze({
      allowLocalGateway,
      keyVersion,
      legacySecretEnvNames: Object.freeze([...legacySecretEnvNames]),
      allowedSecretEnvNames: policy.allowedSecretEnvNames,
      allowedGatewayBaseUrls: policy.allowedGatewayBaseUrls,
      allowedGatewayOrigins: policy.allowedGatewayOrigins,
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID") throw error;
    throw runtimeError("AUTO_LISTING_AI_SETTINGS_CONFIGURATION_INVALID", 500);
  }
}

function secretReader(env, allowedNames) {
  const allowed = new Set(allowedNames);
  return (name) => {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,119}$/u.test(name)
      || ["__proto__", "prototype", "constructor"].includes(name.toLowerCase())
      || !allowed.has(name)) return undefined;
    return typeof env[name] === "string" ? env[name] : undefined;
  };
}

const defaultLogger = Object.freeze({
  log(record) { console.log(JSON.stringify(record)); },
});
const defaultTimers = Object.freeze({ setTimeout, clearTimeout });

export function createAutoListingAiSettingsRuntime({
  env = process.env,
  getPostgresPool: resolvePool = getPostgresPool,
  loadCredentialKey = loadAutoListingCredentialKey,
  createCipher = createAutoListingCredentialCipher,
  createSettingsRepository = createAutoListingAiSettingsPostgres,
  createProfileRepository = createAutoListingAiAdminPostgres,
  createCredentialResolver = createAutoListingAiCredentialResolver,
  createCatalogCredentialResolver = createAutoListingAiCatalogSyncCredentialResolver,
  createGateway = createSub2ApiAdapter,
  createProfileService = createAiGatewayProfileService,
  createSettingsService = createAutoListingAiSettingsService,
  createSyncService = createAutoListingAiModelSyncService,
  createScheduler = createAutoListingAiModelSyncSchedulePostgres,
  createWorker = createAutoListingAiModelSyncWorker,
  logger = defaultLogger,
  timers = defaultTimers,
  resolveGatewayHostname,
} = {}) {
  const dependencies = [resolvePool, loadCredentialKey, createCipher, createSettingsRepository,
    createProfileRepository, createCredentialResolver, createCatalogCredentialResolver, createGateway,
    createProfileService, createSettingsService, createSyncService, createScheduler, createWorker];
  if (!env || typeof env !== "object" || Array.isArray(env)
    || dependencies.some((dependency) => typeof dependency !== "function")
    || typeof logger?.log !== "function" || typeof timers?.setTimeout !== "function"
    || typeof timers?.clearTimeout !== "function"
    || !(resolveGatewayHostname === undefined || typeof resolveGatewayHostname === "function")) {
    throw new TypeError("Auto-listing AI settings runtime dependencies are required");
  }

  const isEnabled = () => autoListingEnabled(env) && autoListingAiEnabled(env);
  let compositionPromise = null;
  let startedWorker = null;

  function getComposition() {
    if (!isEnabled()) {
      return Promise.reject(runtimeError("AUTO_LISTING_AI_SETTINGS_DISABLED", 404));
    }
    if (!compositionPromise) {
      const initialization = Promise.resolve().then(async () => {
        const config = configuration(env);
        let pool;
        try { pool = await resolvePool(); } catch {
          throw runtimeError("AUTO_LISTING_AI_SETTINGS_INITIALIZATION_FAILED", 503, true);
        }
        if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
          throw runtimeError("AUTO_LISTING_AI_SETTINGS_INITIALIZATION_FAILED", 503, true);
        }
        try {
          const key = await loadCredentialKey({ env });
          const cipher = createCipher({ key, keyVersion: config.keyVersion });
          const repository = createSettingsRepository({ pool });
          const profileRepository = createProfileRepository({ pool });
          const credentialResolver = createCredentialResolver({ repository, cipher });
          const catalogCredentialResolver = createCatalogCredentialResolver({ repository, cipher });
          const gateway = createGateway({
            readSecret: secretReader(env, config.legacySecretEnvNames),
            resolveSecret: (scope) => credentialResolver.resolveSecret(scope),
            resolveCatalogSyncCredential: (lease) => catalogCredentialResolver.resolveCredential(lease),
            allowLocalGateway: config.allowLocalGateway,
            ...(resolveGatewayHostname ? { resolveHostname: resolveGatewayHostname } : {}),
            allowedSecretEnvNames: config.allowedSecretEnvNames,
            allowedGatewayBaseUrls: config.allowedGatewayBaseUrls,
            allowedGatewayOrigins: config.allowedGatewayOrigins,
          });
          const capabilityService = createProfileService({ repository: profileRepository, gateway });
          const service = createSettingsService({
            repository, profileRepository, cipher, capabilityService,
          });
          const syncService = createSyncService({ repository, gateway, workerId: WORKER_ID });
          const scheduler = createScheduler({ pool });
          const worker = createWorker({
            accountPageSize: 100,
            enabled: true,
            logger,
            pollIntervalMs: 5_000,
            repository,
            scheduler,
            syncService,
            timers,
            workerId: WORKER_ID,
          });
          if (!service || typeof service !== "object"
            || !worker || typeof worker.start !== "function" || typeof worker.stop !== "function") {
            throw new TypeError("invalid runtime port");
          }
          return Object.freeze({ service, worker });
        } catch (error) {
          if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_AI_SETTINGS_")) throw error;
          throw runtimeError("AUTO_LISTING_AI_SETTINGS_INITIALIZATION_FAILED", 503, true);
        }
      });
      compositionPromise = initialization;
      initialization.catch(() => {
        if (compositionPromise === initialization) compositionPromise = null;
      });
    }
    return compositionPromise;
  }

  async function getService() {
    return (await getComposition()).service;
  }

  async function startWorker() {
    if (!isEnabled()) return false;
    const composition = await getComposition();
    try {
      const started = await composition.worker.start();
      startedWorker = composition.worker;
      return started;
    } catch {
      throw runtimeError("AUTO_LISTING_AI_SETTINGS_WORKER_START_FAILED", 503, true);
    }
  }

  async function stopWorker() {
    const worker = startedWorker;
    startedWorker = null;
    if (worker) await worker.stop();
  }

  return Object.freeze({ getService, startWorker, stopWorker });
}
