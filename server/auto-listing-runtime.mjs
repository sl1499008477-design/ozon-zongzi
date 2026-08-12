import { types as utilTypes } from "node:util";
import { createAutoListingRepository } from "./auto-listing-repository.mjs";
import { createAutoListingService } from "./auto-listing-service.mjs";
import { createAutoListingAiWorker } from "./auto-listing-ai-worker.mjs";
import { createAutoListingRfbsWarehouseVerifier } from "./auto-listing-rfbs-warehouse-verifier.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { callOzonSellerApi as defaultCallOzonSellerApi } from "./ozon-client.mjs";
import { autoListingAiEnabled, autoListingEnabled, autoListingUploadEnabled } from "./runtime-config.mjs";

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function validAiWorkflow(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const expected = ["stageInitialPlanWork", "applyPhaseOutcome"];
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key))
      && expected.every((key) => descriptors[key]?.enumerable === true
        && Object.hasOwn(descriptors[key], "value") && typeof descriptors[key].value === "function");
  } catch {
    return false;
  }
}

function validLifecycle(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const expected = ["start", "stop"];
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key))
      && expected.every((key) => descriptors[key]?.enumerable === true
        && Object.hasOwn(descriptors[key], "value") && typeof descriptors[key].value === "function");
  } catch {
    return false;
  }
}

function closeRfbsWarehouseVerifier(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!(keys.length === 1 && keys[0] === "verifyRfbsWarehouse"
      && descriptors.verifyRfbsWarehouse?.enumerable === true
      && Object.hasOwn(descriptors.verifyRfbsWarehouse, "value")
      && typeof descriptors.verifyRfbsWarehouse.value === "function"
      && !utilTypes.isProxy(descriptors.verifyRfbsWarehouse.value))) return null;
    return Object.freeze({ verifyRfbsWarehouse: descriptors.verifyRfbsWarehouse.value });
  } catch {
    return null;
  }
}

function composeAiWorkerLifecycle(worker, relay) {
  if (!validLifecycle(worker) || !validLifecycle(relay)) {
    throw runtimeError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", "自动上架 AI 运行时初始化失败");
  }
  let startPromise = null;
  return Object.freeze({
    async start() {
      if (!startPromise) {
        const initialization = (async () => {
          let workerStarted = false;
          let relayStarted = false;
          try {
            const workerResult = await worker.start();
            workerStarted = workerResult === true;
            if (!workerStarted) throw new Error("worker did not start");
            const relayResult = await relay.start();
            relayStarted = relayResult === true;
            if (!relayStarted) throw new Error("relay did not start");
            return true;
          } catch {
            if (relayStarted || workerStarted) {
              try { await relay.stop(); } catch {}
              try { await worker.stop(); } catch {}
            }
            startPromise = null;
            throw runtimeError("AUTO_LISTING_AI_RUNTIME_START_FAILED", "自动上架 AI 运行时启动失败");
          }
        })();
        startPromise = initialization;
      }
      return startPromise;
    },
    async stop() {
      if (startPromise) {
        try { await startPromise; } catch {}
      }
      let failed = false;
      try { await relay.stop(); } catch { failed = true; }
      try { await worker.stop(); } catch { failed = true; }
      startPromise = null;
      if (failed) throw runtimeError("AUTO_LISTING_AI_RUNTIME_STOP_FAILED", "自动上架 AI 运行时停止失败");
    },
  });
}

export function createAutoListingRuntime({
  getPostgresPool: resolvePool = getPostgresPool,
  createRepository = createAutoListingRepository,
  createService = createAutoListingService,
  env = process.env,
  createAiWorker = createAutoListingAiWorker,
  createAiWorkerDependencies = null,
  createAiOutboxRelay = null,
  createAiWorkflow = null,
  createListingBasePreparer = null,
  createRfbsWarehouseVerifier = createAutoListingRfbsWarehouseVerifier,
  readStoreCredential = null,
  callOzonSellerApi = defaultCallOzonSellerApi,
  persistenceMode = () => "postgres",
} = {}) {
  if (typeof resolvePool !== "function" || typeof createRepository !== "function" || typeof createService !== "function"
    || !env || typeof env !== "object" || typeof createAiWorker !== "function"
    || !(createAiWorkerDependencies === null || typeof createAiWorkerDependencies === "function")
    || !(createAiOutboxRelay === null || typeof createAiOutboxRelay === "function")
    || !(createAiWorkflow === null || typeof createAiWorkflow === "function")
    || !(createListingBasePreparer === null || typeof createListingBasePreparer === "function")
    || typeof createRfbsWarehouseVerifier !== "function"
    || !(readStoreCredential === null || typeof readStoreCredential === "function")
    || typeof callOzonSellerApi !== "function" || typeof persistenceMode !== "function") {
    throw new TypeError("Auto listing runtime dependencies are required");
  }

  let servicePromise = null;
  let aiWorkerPromise = null;
  const serviceDisabled = !autoListingEnabled(env);
  const aiEnabled = autoListingEnabled(env) && autoListingAiEnabled(env);
  const resolveAiWorkerDependencies = createAiWorkerDependencies || (async ({ env: runtimeEnv, resolvePool: runtimePool }) => {
    const { createDefaultAutoListingAiProductionDependencies } = await import("./auto-listing-ai-runtime-composition.mjs");
    return createDefaultAutoListingAiProductionDependencies({ env: runtimeEnv, resolvePool: runtimePool });
  });
  const resolveAiOutboxRelay = createAiOutboxRelay || (createAiWorkerDependencies === null
    ? async ({ env: runtimeEnv, resolvePool: runtimePool }) => {
      const { createDefaultAutoListingAiProductionOutboxRelay } = await import("./auto-listing-ai-runtime-composition.mjs");
      return createDefaultAutoListingAiProductionOutboxRelay({ env: runtimeEnv, resolvePool: runtimePool });
    }
    : async () => Object.freeze({ async start() { return true; }, async stop() {} }));
  const resolveAiWorkflow = createAiWorkflow || (async ({ pool, directUploadAllowed }) => {
    const { createPostgresAutoListingAiWorkflow } = await import("./auto-listing-ai-workflow-postgres.mjs");
    return createPostgresAutoListingAiWorkflow({ pool, directUploadAllowed });
  });
  const resolveListingBasePreparer = createListingBasePreparer || (async ({ pool, env: runtimeEnv }) => {
    const [{ createAutoListingCategoryAccessPostgres }, { createAutoListingListingBasePreparer }, { createOzonCategoryService }] = await Promise.all([
      import("./auto-listing-category-access-postgres.mjs"),
      import("./auto-listing-listing-base-preparer.mjs"),
      import("./ozon-category-service.mjs"),
    ]);
    return createAutoListingListingBasePreparer({
      loadStoreAccess: createAutoListingCategoryAccessPostgres({ pool }),
      categoryService: createOzonCategoryService(),
      versions: {
        normalizerVersion: runtimeEnv.AUTO_LISTING_NORMALIZER_VERSION || "v3",
        categoryRuleVersion: runtimeEnv.OZON_CATEGORY_RULE_VERSION || "2026-07-v1",
        dictionaryVersion: runtimeEnv.OZON_DICTIONARY_VERSION || "live-api",
      },
    });
  });
  const resolveStoreCredential = readStoreCredential || (async (storeId, accountId) => {
    const { readStoreCredentialV3 } = await import("./listing-pipeline.mjs");
    return readStoreCredentialV3(storeId, accountId);
  });
  const disabledAiWorker = Object.freeze({ async start() { return false; }, async stop() {} });
  function getService() {
    if (serviceDisabled) {
      return Promise.reject(runtimeError("AUTO_LISTING_DISABLED", "自动上架功能暂未启用"));
    }
    if (!servicePromise) {
      const initialization = Promise.resolve().then(async () => {
        if (persistenceMode() !== "postgres") {
          throw runtimeError(
            "AUTO_LISTING_CATEGORY_LEASE_UNAVAILABLE",
            "自动上架要求 PostgreSQL 共享类目租约",
          );
        }
        const pool = await resolvePool();
        const prepareListingBase = await resolveListingBasePreparer({ pool, env });
        if (typeof prepareListingBase !== "function") {
          throw runtimeError("AUTO_LISTING_BASE_RUNTIME_INITIALIZATION_FAILED", "自动上架商品底稿运行时初始化失败");
        }
        const directUploadAllowed = ["1", "true"].includes(String(env.AUTO_LISTING_DIRECT_UPLOAD_ALLOWED || "").trim().toLowerCase());
        let repository;
        if (aiEnabled) {
          const workflow = await resolveAiWorkflow({ pool, directUploadAllowed });
          if (!validAiWorkflow(workflow)) {
            throw runtimeError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", "自动上架 AI 运行时初始化失败");
          }
          repository = createRepository({ pool, stageInitialPlanWork: workflow.stageInitialPlanWork });
        } else repository = createRepository({ pool });
        let rfbsWarehouseVerifier;
        try {
          rfbsWarehouseVerifier = createRfbsWarehouseVerifier({
            async loadTarget(input) {
              const loaded = await repository.loadTargetWarehouse(input);
              return loaded?.warehouse ?? null;
            },
            async readCredential({ accountId, targetStoreId }) {
              return resolveStoreCredential(targetStoreId, accountId);
            },
            callOzonSellerApi,
          });
        } catch {
          throw runtimeError("AUTO_LISTING_RFBS_RUNTIME_INITIALIZATION_FAILED", "RFBS 仓库验证运行时初始化失败");
        }
        const closedRfbsWarehouseVerifier = closeRfbsWarehouseVerifier(rfbsWarehouseVerifier);
        if (!closedRfbsWarehouseVerifier) {
          throw runtimeError("AUTO_LISTING_RFBS_RUNTIME_INITIALIZATION_FAILED", "RFBS 仓库验证运行时初始化失败");
        }
        const listingPipelineEnabled = String(env.LISTING_PIPELINE_V3 ?? "1").trim() !== "0";
        return createService({
          repository,
          prepareListingBase,
          rfbsWarehouseVerifier: closedRfbsWarehouseVerifier,
          uploadPolicyGates: {
            directUploadAllowed,
            uploadEnabled: autoListingUploadEnabled(env),
            listingPipelineEnabled,
          },
        });
      });
      servicePromise = initialization;
      initialization.catch(() => {
        if (servicePromise === initialization) servicePromise = null;
      });
    }
    return servicePromise;
  }

  function getAiWorker() {
    if (!aiEnabled) return Promise.resolve(disabledAiWorker);
    if (!aiWorkerPromise) {
      const initialization = Promise.resolve().then(async () => {
        let dependencies;
        let relay;
        let poolPromise = null;
        const runtimePool = () => {
          if (!poolPromise) poolPromise = Promise.resolve().then(() => resolvePool());
          return poolPromise;
        };
        try {
          [dependencies, relay] = await Promise.all([
            resolveAiWorkerDependencies({ env, resolvePool: runtimePool }),
            resolveAiOutboxRelay({ env, resolvePool: runtimePool }),
          ]);
        } catch {
          throw runtimeError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", "自动上架 AI 运行时初始化失败");
        }
        try {
          return composeAiWorkerLifecycle(createAiWorker({ ...dependencies, enabled: true }), relay);
        } catch {
          throw runtimeError("AUTO_LISTING_AI_RUNTIME_INITIALIZATION_FAILED", "自动上架 AI 运行时初始化失败");
        }
      });
      aiWorkerPromise = initialization;
      initialization.catch(() => {
        if (aiWorkerPromise === initialization) aiWorkerPromise = null;
      });
    }
    return aiWorkerPromise;
  }

  async function startAiWorker() {
    const initialization = getAiWorker();
    const worker = await initialization;
    try { return await worker.start(); } catch (error) {
      if (aiWorkerPromise === initialization) aiWorkerPromise = null;
      throw error;
    }
  }

  async function stopAiWorker() {
    if (!aiEnabled || !aiWorkerPromise) return;
    const initialization = aiWorkerPromise;
    let worker;
    try { worker = await initialization; } catch { return; }
    try { await worker.stop(); } finally {
      if (aiWorkerPromise === initialization) aiWorkerPromise = null;
    }
  }

  return Object.freeze({ getService, getAiWorker, startAiWorker, stopAiWorker });
}
