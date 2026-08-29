import {
  createPostgresAutoListingAiPhaseContextLoader,
  projectAutoListingGenerationReferences,
} from "./auto-listing-ai-phase-context-postgres.mjs";
import { loadAutoListingCredentialKey } from "./auto-listing-ai-credential-config.mjs";
import { createAutoListingCredentialCipher } from "./auto-listing-ai-credential-crypto.mjs";
import { createAutoListingAiCredentialResolver } from "./auto-listing-ai-credential-resolver.mjs";
import { createAutoListingAiSettingsPostgres } from "./auto-listing-ai-settings-postgres.mjs";
import { createPostgresAiOutboxRepository } from "./auto-listing-ai-outbox-postgres.mjs";
import {
  createAutoListingAiWorkPublisher,
  createAutoListingAiWorkQueueAdapter,
  createLegacyAutoListingAiOutboxPublisher,
  createLegacyAutoListingAiQueueAdapter,
} from "./auto-listing-ai-queue.mjs";
import { orchestrateAutoListingAiPhase } from "./auto-listing-ai-orchestrator.mjs";
import { autoListingAiMessageDedupeKey } from "./auto-listing-ai-message.mjs";
import { createPostgresContentPlanRepository } from "./auto-listing-content-plan-repository.mjs";
import { createPostgresContentPlanEvidenceRepository } from "./auto-listing-content-plan-evidence-postgres.mjs";
import { createContentPlan } from "./auto-listing-content-planner.mjs";
import { createPostgresGenerationAttemptRepository } from "./auto-listing-generation-attempt-postgres.mjs";
import { createPostgresAssetCleanupRepository } from "./auto-listing-asset-cleanup-repository.mjs";
import { generateImageSlot } from "./auto-listing-image-generator.mjs";
import { finalizeMaterializedPlan } from "./auto-listing-materialized-plan.mjs";
import { createActiveMaterializedSourceAssetLoader } from "./auto-listing-materialized-source-loader.mjs";
import { createPostgresRichContentRepository } from "./auto-listing-rich-content-repository.mjs";
import { generateRichContent } from "./auto-listing-rich-content.mjs";
import { cacheAutoListingReviewPreview } from "./auto-listing-review-preview.mjs";
import { createAutoListingSourceImageDownloader } from "./auto-listing-source-downloader.mjs";
import { createPostgresSourceMaterializationRepository } from "./auto-listing-source-materialization-repository.mjs";
import { materializeSourceAsset } from "./auto-listing-source-materializer.mjs";
import {
  getObjectBuffer,
  putObjectFromBuffer,
  removeObject,
} from "./object-storage.mjs";
import { createSub2ApiAdapter } from "./sub2api-ai-adapter.mjs";
import { createSub2ApiGatewayPolicy } from "./sub2api-gateway-boundary.mjs";

const INPUT_KEYS = new Set(["env", "resolvePool", "ports"]);
const RELAY_PORT_KEYS = new Set([
  "createBoss", "createOutboxRepository", "createQueueAdapter", "createPublisher",
  "createWorkQueueAdapter", "createWorkPublisher",
]);
const RELAY_INFRASTRUCTURE_KEYS = new Set(["createBoss", "createOutboxRepository"]);
const DIAGNOSTIC_PORT_KEYS = new Set([
  "loadCredentialKey", "createCipher", "createCredentialRepository",
  "createCredentialResolver", "createGateway", "createEvidenceRepository",
]);
const GATEWAY_PORT_KEYS = new Set([
  "loadCredentialKey", "createCipher", "createCredentialRepository",
  "createCredentialResolver", "createGateway",
]);
const PORT_KEYS = new Set([
  "createBoss", "createGateway", "createWorkflow", "createContentPlanRepository",
  "createContentPlanEvidenceRepository",
  "createSourceMaterializationRepository", "createGenerationRepository",
  "createRichContentRepository", "createDownloader", "createStorage",
  "createSourceAssetLoader", "createContextLoader", "orchestratePhase", "phaseServices",
  "loadCredentialKey", "createCipher", "createCredentialRepository", "createCredentialResolver",
]);
const WORKFLOW_PORT_KEYS = new Set(["stageInitialPlanWork", "applyPhaseOutcome", "requeueChannelFailure"]);
const SERVICE_KEYS = new Set([
  "planContent", "materializeSourceAsset", "finalizeMaterializedPlan",
  "generateImageSlot", "generateRichContent",
]);
const REQUIRED_PROHIBITED_CLAIMS = Object.freeze([
  "CERTIFICATION", "MEDICAL_BENEFIT", "UNLISTED_ACCESSORIES", "WARRANTY",
]);
const PLAN_PROMPT_TEMPLATE_VERSION = "AUTO_LISTING_CONTENT_PLAN_V3";
const RICH_CONTENT_LEASE_OWNER = "auto-listing-rich-content-worker-v1";

function compositionError(code, retryable = false) {
  const error = new Error("自动上架 AI 生产运行环境配置失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function plainObject(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function environmentObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, keys) {
  try {
    const actual = Reflect.ownKeys(value);
    return plainObject(value) && actual.length === keys.size
      && actual.every((key) => typeof key === "string" && keys.has(key));
  } catch {
    return false;
  }
}

function enabled(env, name) {
  const value = String(env?.[name] || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

function strictBoolean(env, name, fallback = false) {
  const value = typeof env?.[name] === "string" ? env[name].trim().toLowerCase() : "";
  if (!value) return fallback;
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
}

function required(env, name) {
  const value = typeof env?.[name] === "string" ? env[name].trim() : "";
  if (!value) throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  return value;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  return parsed;
}

function csvList(env, name, { allowEmpty = false } = {}) {
  const raw = typeof env?.[name] === "string" ? env[name] : "";
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  return values;
}

function databaseConfig(env) {
  const sslValue = String(env.POSTGRES_SSL || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true"].includes(sslValue)) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  const ssl = sslValue === "1" || sslValue === "true" ? { rejectUnauthorized: false } : false;
  const connectionString = typeof env.DATABASE_URL === "string" ? env.DATABASE_URL.trim() : "";
  if (connectionString) return Object.freeze({ connectionString, ssl });
  return Object.freeze({
    host: required(env, "POSTGRES_HOST"),
    port: positiveInteger(env.POSTGRES_PORT, 5432, 65_535),
    database: required(env, "POSTGRES_DB"),
    user: required(env, "POSTGRES_USER"),
    password: required(env, "POSTGRES_PASSWORD"),
    ssl,
  });
}

function closedConfiguration(env) {
  try {
    if (!environmentObject(env) || !enabled(env, "AUTO_LISTING_ENABLED") || !enabled(env, "AUTO_LISTING_AI_ENABLED")) {
      throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
    }
    for (const name of ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET"]) required(env, name);
    positiveInteger(env.MINIO_PORT, 9000, 65_535);
    const minioSsl = String(env.MINIO_USE_SSL || "false").trim().toLowerCase();
    if (!["0", "1", "false", "true"].includes(minioSsl)) {
      throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
    }
    const schema = String(env.PG_BOSS_SCHEMA || "sonli_queue").trim();
    const applicationName = String(env.PG_BOSS_APPLICATION_NAME || "sonli-auto-listing-ai-worker").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)
      || !/^[A-Za-z0-9_.-]{1,63}$/u.test(applicationName)) {
      throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
    }
    const allowLocalGateway = strictBoolean(env, "AUTO_LISTING_AI_ALLOW_LOCAL_GATEWAY", false);
    if (allowLocalGateway && String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
      throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
    }
    const credentialKeyVersion = required(env, "AUTO_LISTING_CREDENTIAL_KEY_VERSION");
    const legacySecretEnvNames = csvList(env, "AUTO_LISTING_AI_ALLOWED_SECRET_ENV_NAMES", { allowEmpty: true });
    const gatewayPolicy = createSub2ApiGatewayPolicy({
      allowedSecretEnvNames: [...legacySecretEnvNames, "SUB2API_ENCRYPTED_KEY"],
      allowedGatewayBaseUrls: csvList(env, "AUTO_LISTING_AI_ALLOWED_GATEWAY_BASE_URLS"),
      allowedGatewayOrigins: typeof env.AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS === "string"
        && env.AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS.trim()
        ? csvList(env, "AUTO_LISTING_AI_ALLOWED_GATEWAY_ORIGINS") : [],
      allowLocalGateway,
    });
    return Object.freeze({
      database: databaseConfig(env),
      gatewayPolicy,
      legacySecretEnvNames: Object.freeze([...legacySecretEnvNames]),
      allowLocalGateway,
      directUploadAllowed: strictBoolean(env, "AUTO_LISTING_DIRECT_UPLOAD_ALLOWED", false),
      credentialKeyVersion,
      queue: Object.freeze({
        schema,
        application_name: applicationName,
        max: positiveInteger(env.PG_BOSS_POOL_SIZE, 5, 20),
        useListenNotify: true,
      }),
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID") throw error;
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
}

function secretReader(env, allowedSecretEnvNames) {
  const allowed = new Set(allowedSecretEnvNames);
  return (name) => {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      || ["__proto__", "prototype", "constructor"].includes(name.toLowerCase())
      || !allowed.has(name)) return undefined;
    return typeof env[name] === "string" ? env[name] : undefined;
  };
}

const storagePort = Object.freeze({ getObjectBuffer, putObjectFromBuffer, removeObject });
const phaseServices = Object.freeze({
  planContent: createContentPlan,
  materializeSourceAsset,
  finalizeMaterializedPlan,
  generateImageSlot: (input) => generateImageSlot({
    ...input,
    cacheReviewPreview: cacheAutoListingReviewPreview,
  }),
  generateRichContent,
});

const DEFAULT_PORTS = Object.freeze({
  async createBoss({ database, queue }) {
    const { PgBoss } = await import("pg-boss");
    return new PgBoss({ ...database, ...queue });
  },
  loadCredentialKey: ({ env }) => loadAutoListingCredentialKey({ env }),
  createCipher: (options) => createAutoListingCredentialCipher(options),
  createCredentialRepository: ({ pool }) => createAutoListingAiSettingsPostgres({ pool }),
  createCredentialResolver: (options) => createAutoListingAiCredentialResolver(options),
  createGateway: ({ readSecret, resolveSecret, gatewayPolicy, allowLocalGateway }) => createSub2ApiAdapter({
    readSecret,
    resolveSecret,
    allowLocalGateway,
    allowedSecretEnvNames: gatewayPolicy.allowedSecretEnvNames,
    allowedGatewayBaseUrls: gatewayPolicy.allowedGatewayBaseUrls,
    allowedGatewayOrigins: gatewayPolicy.allowedGatewayOrigins,
  }),
  async createWorkflow({ pool, directUploadAllowed }) {
    const { createPostgresAutoListingAiWorkflow } = await import("./auto-listing-ai-workflow-postgres.mjs");
    return createPostgresAutoListingAiWorkflow({ pool, directUploadAllowed });
  },
  createContentPlanRepository: ({ pool }) => createPostgresContentPlanRepository({ pool }),
  createContentPlanEvidenceRepository: ({ pool }) => createPostgresContentPlanEvidenceRepository({ pool }),
  createSourceMaterializationRepository: ({ pool }) => createPostgresSourceMaterializationRepository({ pool }),
  createGenerationRepository: ({ pool }) => {
    const attempts = createPostgresGenerationAttemptRepository({ pool });
    const cleanup = createPostgresAssetCleanupRepository({ pool });
    return Object.freeze({
      ...attempts,
      recordAssetCleanupRequired: (input) => cleanup.recordAssetCleanupRequired(input),
    });
  },
  createRichContentRepository: ({ pool }) => createPostgresRichContentRepository({ pool }),
  createDownloader: () => createAutoListingSourceImageDownloader(),
  createStorage: () => storagePort,
  createSourceAssetLoader: (options) => createActiveMaterializedSourceAssetLoader(options),
  createContextLoader: (options) => createPostgresAutoListingAiPhaseContextLoader(options),
  orchestratePhase: (input, services) => orchestrateAutoListingAiPhase(input, services),
  phaseServices,
});

const DEFAULT_RELAY_INFRASTRUCTURE = Object.freeze({
  createBoss: DEFAULT_PORTS.createBoss,
  createOutboxRepository: ({ pool }) => createPostgresAiOutboxRepository({ pool }),
});

const DEFAULT_RELAY_PORTS = Object.freeze({
  ...DEFAULT_RELAY_INFRASTRUCTURE,
  createQueueAdapter: (options) => createLegacyAutoListingAiQueueAdapter(options),
  createPublisher: (options) => createLegacyAutoListingAiOutboxPublisher(options),
  createWorkQueueAdapter: (options) => createAutoListingAiWorkQueueAdapter(options),
  createWorkPublisher: (options) => createAutoListingAiWorkPublisher(options),
});

function defaultRelayPorts(infrastructure) {
  if (!exactObject(infrastructure, RELAY_INFRASTRUCTURE_KEYS)
    || [...RELAY_INFRASTRUCTURE_KEYS].some((key) => typeof infrastructure[key] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  if (infrastructure === DEFAULT_RELAY_INFRASTRUCTURE) return DEFAULT_RELAY_PORTS;
  return Object.freeze({
    ...DEFAULT_RELAY_PORTS,
    createBoss: infrastructure.createBoss,
    createOutboxRepository: infrastructure.createOutboxRepository,
  });
}

const DEFAULT_DIAGNOSTIC_PORTS = Object.freeze({
  loadCredentialKey: DEFAULT_PORTS.loadCredentialKey,
  createCipher: DEFAULT_PORTS.createCipher,
  createCredentialRepository: DEFAULT_PORTS.createCredentialRepository,
  createCredentialResolver: DEFAULT_PORTS.createCredentialResolver,
  createGateway: DEFAULT_PORTS.createGateway,
  createEvidenceRepository: ({ pool }) => createPostgresContentPlanEvidenceRepository({ pool }),
});

const DEFAULT_GATEWAY_PORTS = Object.freeze({
  loadCredentialKey: DEFAULT_PORTS.loadCredentialKey,
  createCipher: DEFAULT_PORTS.createCipher,
  createCredentialRepository: DEFAULT_PORTS.createCredentialRepository,
  createCredentialResolver: DEFAULT_PORTS.createCredentialResolver,
  createGateway: DEFAULT_PORTS.createGateway,
});

function validatePorts(ports) {
  if (!exactObject(ports, PORT_KEYS)
    || [...PORT_KEYS].filter((key) => key !== "phaseServices").some((key) => typeof ports[key] !== "function")
    || !exactObject(ports.phaseServices, SERVICE_KEYS)
    || [...SERVICE_KEYS].some((key) => typeof ports.phaseServices[key] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
}

function assertPortShape(value, methods) {
  if (!value || typeof value !== "object" || methods.some((method) => typeof value[method] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  return value;
}

function assertWorkflowPort(value) {
  if (!exactObject(value, WORKFLOW_PORT_KEYS)
    || [...WORKFLOW_PORT_KEYS].some((method) => typeof value[method] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  return value;
}

export async function createAutoListingAiProductionDependencies(input = {}) {
  if (!exactObject(input, INPUT_KEYS) || typeof input.resolvePool !== "function") {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  const { env, resolvePool, ports } = input;
  validatePorts(ports);
  const config = closedConfiguration(env);
  let pool;
  try { pool = await resolvePool(); } catch {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }

  try {
    const credentialKey = await ports.loadCredentialKey({ env });
    const credentialCipher = ports.createCipher({
      key: credentialKey,
      keyVersion: config.credentialKeyVersion,
    });
    const credentialRepository = ports.createCredentialRepository({ pool });
    const credentialResolver = assertPortShape(ports.createCredentialResolver({
      repository: credentialRepository,
      cipher: credentialCipher,
    }), ["resolveSecret"]);
    const aiWorkflow = assertWorkflowPort(await ports.createWorkflow({
      pool,
      directUploadAllowed: config.directUploadAllowed,
    }));
    const executionStore = createPostgresAiOutboxRepository({ pool });
    const gateway = assertPortShape(ports.createGateway({
      readSecret: secretReader(env, config.legacySecretEnvNames),
      resolveSecret: (scope) => credentialResolver.resolveSecret(scope),
      gatewayPolicy: config.gatewayPolicy,
      allowLocalGateway: config.allowLocalGateway,
    }), [
      "createTextResponse", "generateImage", "inspectImage",
    ]);
    const storage = assertPortShape(ports.createStorage({ env }), [
      "putObjectFromBuffer", "getObjectBuffer", "removeObject",
    ]);
    const contentPlanRepository = ports.createContentPlanRepository({ pool });
    const contentPlanEvidenceRepository = assertPortShape(
      ports.createContentPlanEvidenceRepository({ pool }),
      ["recordResponse", "recordValidation", "loadOutcome"],
    );
    const sourceMaterializationRepository = ports.createSourceMaterializationRepository({ pool });
    const generationRepository = ports.createGenerationRepository({ pool });
    const richContentRepository = ports.createRichContentRepository({ pool });
    const downloader = assertPortShape(ports.createDownloader(), ["downloadSourceImage"]);
    const sourceAssetLoader = assertPortShape(ports.createSourceAssetLoader({
      pool, repository: sourceMaterializationRepository, storage,
    }), ["loadSourceAsset"]);
    for (const repository of [contentPlanRepository, contentPlanEvidenceRepository, sourceMaterializationRepository,
      generationRepository, richContentRepository]) {
      if (!repository || typeof repository !== "object") {
        throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
      }
    }
    const loadContext = ports.createContextLoader({
      pool,
      gateway,
      contentPlanRepository,
      contentPlanEvidenceRepository,
      sourceMaterializationRepository,
      generationRepository,
      richContentRepository,
      downloader,
      storage,
      sourceAssetLoader,
      logger: null,
      planPromptTemplateVersion: PLAN_PROMPT_TEMPLATE_VERSION,
      prohibitedClaims: REQUIRED_PROHIBITED_CLAIMS,
      maxAttempts: 3,
      richContentMaxAttempts: 5,
      richContentLeaseOwner: RICH_CONTENT_LEASE_OWNER,
      referenceProjector: projectAutoListingGenerationReferences,
    });
    if (typeof loadContext !== "function") {
      throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
    }
    return Object.freeze({
      bossFactory: () => ports.createBoss({ database: config.database, queue: config.queue }),
      executionRepository: Object.freeze({
        async adopt({ message, execution, workerId, leaseToken, leaseMs }) {
          const row = await executionStore.adoptAutoListingAiWork({
            accountId: message.accountId,
            itemId: message.itemId,
            id: execution.outboxId,
            publicationId: `${autoListingAiMessageDedupeKey(message)}:${execution.dispatchGeneration}`,
            dispatchGeneration: execution.dispatchGeneration,
            relayOwner: execution.leaseOwner,
            relayToken: execution.leaseToken,
            workerId,
            workerLeaseToken: leaseToken,
            leaseMs,
          });
          return row?.workMessage?.execution ?? null;
        },
        async renew({ message, execution, leaseMs }) {
          const row = await executionStore.renewAutoListingAiWorkLease({
            accountId: message.accountId,
            itemId: message.itemId,
            id: execution.outboxId,
            publicationId: `${autoListingAiMessageDedupeKey(message)}:${execution.dispatchGeneration}`,
            dispatchGeneration: execution.dispatchGeneration,
            workerId: execution.leaseOwner,
            leaseToken: execution.leaseToken,
            leaseMs,
          });
          return row?.workMessage?.execution ?? null;
        },
        requeueChannelFailure: (input) => aiWorkflow.requeueChannelFailure(input),
      }),
      loadContext,
      orchestrate: (orchestratorInput) => ports.orchestratePhase(orchestratorInput, ports.phaseServices),
      workflow: Object.freeze({
        applyOutcome: (input) => aiWorkflow.applyPhaseOutcome(input),
      }),
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED") throw error;
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
}

export function createDefaultAutoListingAiProductionDependencies({ env, resolvePool } = {}) {
  return createAutoListingAiProductionDependencies({ env, resolvePool, ports: DEFAULT_PORTS });
}

export async function createAutoListingGatewayProductionPorts(input = {}) {
  if (!exactObject(input, INPUT_KEYS) || typeof input.resolvePool !== "function"
    || !exactObject(input.ports, GATEWAY_PORT_KEYS)
    || [...GATEWAY_PORT_KEYS].some((key) => typeof input.ports[key] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  const { env, resolvePool, ports } = input;
  const config = closedConfiguration(env);
  let pool;
  try { pool = await resolvePool(); } catch {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  try {
    const credentialKey = await ports.loadCredentialKey({ env });
    const credentialCipher = ports.createCipher({
      key: credentialKey,
      keyVersion: config.credentialKeyVersion,
    });
    const credentialRepository = ports.createCredentialRepository({ pool });
    const credentialResolver = assertPortShape(ports.createCredentialResolver({
      repository: credentialRepository,
      cipher: credentialCipher,
    }), ["resolveSecret"]);
    const gateway = assertPortShape(ports.createGateway({
      readSecret: secretReader(env, config.legacySecretEnvNames),
      resolveSecret: (scope) => credentialResolver.resolveSecret(scope),
      gatewayPolicy: config.gatewayPolicy,
      allowLocalGateway: config.allowLocalGateway,
    }), ["createTextResponse", "generateImage", "inspectImage"]);
    return Object.freeze({ pool, gateway });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED") throw error;
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
}

export function createDefaultAutoListingGatewayProductionPorts({ env, resolvePool } = {}) {
  return createAutoListingGatewayProductionPorts({ env, resolvePool, ports: DEFAULT_GATEWAY_PORTS });
}

export async function createAutoListingPlanDiagnosticProductionPorts(input = {}) {
  if (!exactObject(input, INPUT_KEYS) || typeof input.resolvePool !== "function"
    || !exactObject(input.ports, DIAGNOSTIC_PORT_KEYS)
    || [...DIAGNOSTIC_PORT_KEYS].some((key) => typeof input.ports[key] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  const { env, resolvePool, ports } = input;
  const config = closedConfiguration(env);
  let pool;
  try { pool = await resolvePool(); } catch {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  try {
    const credentialKey = await ports.loadCredentialKey({ env });
    const credentialCipher = ports.createCipher({
      key: credentialKey,
      keyVersion: config.credentialKeyVersion,
    });
    const credentialRepository = ports.createCredentialRepository({ pool });
    const credentialResolver = assertPortShape(ports.createCredentialResolver({
      repository: credentialRepository,
      cipher: credentialCipher,
    }), ["resolveSecret"]);
    const gateway = assertPortShape(ports.createGateway({
      readSecret: secretReader(env, config.legacySecretEnvNames),
      resolveSecret: (scope) => credentialResolver.resolveSecret(scope),
      gatewayPolicy: config.gatewayPolicy,
      allowLocalGateway: config.allowLocalGateway,
    }), ["createTextResponse", "generateImage", "inspectImage"]);
    const evidenceRepository = assertPortShape(ports.createEvidenceRepository({ pool }), [
      "recordResponse", "recordValidation", "loadOutcome",
    ]);
    return Object.freeze({ pool, gateway, evidenceRepository });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED") throw error;
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
}

export function createDefaultAutoListingPlanDiagnosticProductionPorts({ env, resolvePool } = {}) {
  return createAutoListingPlanDiagnosticProductionPorts({ env, resolvePool, ports: DEFAULT_DIAGNOSTIC_PORTS });
}

export async function createAutoListingAiProductionOutboxRelay(input = {}) {
  if (!exactObject(input, INPUT_KEYS) || typeof input.resolvePool !== "function"
    || !exactObject(input.ports, RELAY_PORT_KEYS)
    || [...RELAY_PORT_KEYS].some((key) => typeof input.ports[key] !== "function")) {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_CONFIGURATION_INVALID");
  }
  const { env, resolvePool, ports } = input;
  const config = closedConfiguration(env);
  let pool;
  try { pool = await resolvePool(); } catch {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }

  try {
    const repository = assertPortShape(ports.createOutboxRepository({ pool }), [
      "listRunnableAutoListingAiAccountIds", "claimLegacyAutoListingAiMessages",
      "claimAutoListingAiWork", "markAutoListingAiWorkPublished", "releaseUnpublishedAutoListingAiWork",
      "renewAutoListingAiMessageLease", "completeAutoListingAiMessage",
      "failAutoListingAiMessage", "reconcileDeadLegacyAutoListingAiMessages",
      "reconcileInterruptedAutoListingAiItems",
    ]);
    const createAccountIds = () => {
      let afterAccountId = null;
      return async () => {
        let values = await repository.listRunnableAutoListingAiAccountIds({ afterAccountId, limit: 100 });
        if (!Array.isArray(values)) throw new Error("invalid discovery");
        if (values.length === 0 && afterAccountId !== null) {
          afterAccountId = null;
          values = await repository.listRunnableAutoListingAiAccountIds({ afterAccountId, limit: 100 });
        }
        if (values.length > 0) afterAccountId = values[values.length - 1];
        return values;
      };
    };
    const timers = Object.freeze({ setTimeout, clearTimeout, setInterval, clearInterval });
    const legacyQueueAdapter = assertPortShape(ports.createQueueAdapter({
      enabled: true,
      bossFactory: () => ports.createBoss({ database: config.database, queue: config.queue }),
    }), ["start", "publish", "stop"]);
    const legacyPublisher = assertPortShape(ports.createPublisher({
      enabled: true,
      outboxRepository: repository,
      queueAdapter: legacyQueueAdapter,
      accountIds: createAccountIds(),
      timers,
      workerId: "auto-listing-ai-outbox-relay-v1",
      batchSize: 1,
      leaseMs: 30_000,
      publishTimeoutMs: 10_000,
      intervalMs: 5_000,
      accountConcurrency: 4,
    }), ["start", "stop"]);
    const workQueueAdapter = assertPortShape(ports.createWorkQueueAdapter({
      enabled: true,
      bossFactory: () => ports.createBoss({ database: config.database, queue: config.queue }),
    }), ["start", "publish", "stop"]);
    const workPublisher = assertPortShape(ports.createWorkPublisher({
      enabled: true,
      outboxRepository: repository,
      queueAdapter: workQueueAdapter,
      accountIds: createAccountIds(),
      timers,
      workerId: "auto-listing-ai-work-relay-v3",
      batchSize: 1,
      leaseMs: 30_000,
      publishTimeoutMs: 10_000,
      intervalMs: 5_000,
      accountConcurrency: 4,
    }), ["start", "stop"]);
    return Object.freeze({
      async start() {
        const values = await Promise.all([legacyPublisher.start(), workPublisher.start()]);
        return values.every((value) => value === true);
      },
      async stop() {
        const values = await Promise.allSettled([legacyPublisher.stop(), workPublisher.stop()]);
        const failed = values.find((value) => value.status === "rejected");
        if (failed) throw failed.reason;
      },
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED") throw error;
    throw compositionError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", true);
  }
}

export function createDefaultAutoListingAiProductionOutboxRelay(
  { env, resolvePool } = {}, infrastructure = DEFAULT_RELAY_INFRASTRUCTURE,
) {
  return createAutoListingAiProductionOutboxRelay({ env, resolvePool, ports: defaultRelayPorts(infrastructure) });
}
