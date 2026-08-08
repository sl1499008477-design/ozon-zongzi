import { createAutoListingAiAdminHttpHandler } from "./auto-listing-ai-admin-routes.mjs";
import { createAutoListingAiAdminRuntime } from "./auto-listing-ai-admin-runtime.mjs";
import { createAutoListingDirectSystemReadiness } from "./auto-listing-direct-system-readiness.mjs";
import { createAutoListingItemHttpHandler } from "./auto-listing-item-routes.mjs";
import { createAutoListingItemRuntime } from "./auto-listing-item-runtime.mjs";
import { createAutoListingOperationsRuntime } from "./auto-listing-operations-runtime.mjs";
import { createAutoListingReviewAssetHttpHandler } from "./auto-listing-review-asset-routes.mjs";
import { createAutoListingSubmissionReconciliationAdminHttpHandler } from "./auto-listing-submission-reconciliation-admin-routes.mjs";
import { createAutoListingSubmissionReconciliationAdminRuntime } from "./auto-listing-submission-reconciliation-admin-runtime.mjs";
import { createAutoListingSubmissionReconciliationRuntime } from "./auto-listing-submission-reconciliation-runtime.mjs";
import { createAutoListingUploadRuntime } from "./auto-listing-upload-runtime.mjs";
import { createAutoListingUserWorkflowHttpHandler } from "./auto-listing-user-workflow-routes.mjs";
import { createAutoListingUserWorkflowRuntime } from "./auto-listing-user-workflow-runtime.mjs";
import { createAutoListingUploadPolicyAdminHttpHandler } from "./auto-listing-upload-policy-admin-routes.mjs";
import { createAutoListingUploadPolicyAdminRuntime } from "./auto-listing-upload-policy-admin-runtime.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { createListingAssetPublicationProbe } from "./listing-asset-publication-probe.mjs";
import { createListingAssetPublicationRuntime } from "./listing-asset-publication-runtime.mjs";
import { getObjectBuffer, putObjectFromBuffer, removeObject } from "./object-storage.mjs";
import { createSubmissionV3, findListingPreparationReplayV3 } from "./listing-pipeline.mjs";
import {
  autoListingEnabled,
  autoListingExcelImportLimits,
  autoListingExcelRequestBodyLimit,
  autoListingUploadEnabled,
  listingAssetPublicationConfig,
} from "./runtime-config.mjs";

const publicationStorage = Object.freeze({ getObjectBuffer, putObjectFromBuffer, removeObject });

/** Owns ordinary-user/admin HTTP composition and worker lifecycle for auto-listing. */
export function createAutoListingWebRuntime({
  authenticate,
  getAutoListingService,
  collectSku,
  readJson,
  sendJson,
  env = process.env,
  resolvePool = getPostgresPool,
  createPublicationRuntime = createListingAssetPublicationRuntime,
  createUploadRuntime = createAutoListingUploadRuntime,
  createReconciliationRuntime = createAutoListingSubmissionReconciliationRuntime,
  createOperationsRuntime = createAutoListingOperationsRuntime,
  storage = publicationStorage,
  probePublicPolicy = createListingAssetPublicationProbe({ storage }),
  assertDirectSystemReady = createAutoListingDirectSystemReadiness({ env, resolvePool }),
} = {}) {
  if (typeof authenticate !== "function" || typeof getAutoListingService !== "function"
    || typeof collectSku !== "function" || typeof readJson !== "function" || typeof sendJson !== "function"
    || typeof resolvePool !== "function" || typeof createPublicationRuntime !== "function"
    || typeof createUploadRuntime !== "function" || typeof createReconciliationRuntime !== "function"
    || typeof createOperationsRuntime !== "function"
    || typeof assertDirectSystemReady !== "function" || typeof probePublicPolicy !== "function") {
    throw new TypeError("AUTO_LISTING_WEB_RUNTIME_DEPENDENCY_REQUIRED");
  }

  const adminRuntime = createAutoListingAiAdminRuntime();
  const userWorkflowRuntime = createAutoListingUserWorkflowRuntime({
    env,
    getAutoListingService,
    collectSku,
  });
  const itemRuntime = createAutoListingItemRuntime({ env });
  const excelLimits = autoListingExcelImportLimits(env);
  let publicationRuntimePromise = null;
  const getPublicationRuntime = () => {
    if (!publicationRuntimePromise) {
      const initialization = Promise.resolve().then(async () => {
        const pool = await resolvePool();
        const config = listingAssetPublicationConfig(env);
        if (!config) throw new Error("auto-listing upload publication is disabled");
        return createPublicationRuntime({ pool, storage, config, probePublicPolicy });
      });
      publicationRuntimePromise = initialization;
      initialization.catch(() => {
        if (publicationRuntimePromise === initialization) publicationRuntimePromise = null;
      });
    }
    return publicationRuntimePromise;
  };
  const listingPipelineEnabled = String(env.LISTING_PIPELINE_V3 ?? "1").trim() !== "0";
  const uploadEnabled = autoListingEnabled(env) && autoListingUploadEnabled(env) && listingPipelineEnabled;
  const directUploadAllowed = ["1", "true"]
    .includes(String(env.AUTO_LISTING_DIRECT_UPLOAD_ALLOWED ?? "").trim().toLowerCase());
  let uploadRuntimePromise = null;
  const getUploadRuntime = () => {
    if (!uploadRuntimePromise) {
      const initialization = Promise.resolve().then(async () => createUploadRuntime({
        pool: await resolvePool(),
        publicationRuntime: await getPublicationRuntime(),
        assertDirectSystemReady,
        standardSubmissionPort: Object.freeze({
          createSubmission: createSubmissionV3,
          findSubmission: findListingPreparationReplayV3,
        }),
        uploadEnabled,
        listingPipelineEnabled,
        directUploadAllowed,
        worker: { enabled: uploadEnabled },
      }));
      uploadRuntimePromise = initialization;
      initialization.catch(() => {
        if (uploadRuntimePromise === initialization) uploadRuntimePromise = null;
      });
    }
    return uploadRuntimePromise;
  };
  let reconciliationRuntimePromise = null;
  const getReconciliationRuntime = () => {
    if (!reconciliationRuntimePromise) {
      const initialization = Promise.resolve().then(async () => createReconciliationRuntime({
        enabled: uploadEnabled,
        ...(uploadEnabled ? { pool: await resolvePool() } : {}),
      }));
      reconciliationRuntimePromise = initialization;
      initialization.catch(() => {
        if (reconciliationRuntimePromise === initialization) reconciliationRuntimePromise = null;
      });
    }
    return reconciliationRuntimePromise;
  };
  const operationsRuntime = createOperationsRuntime({
    enabled: uploadEnabled,
    getPublicationRuntime,
    getUploadRuntime,
    getReconciliationRuntime,
  });
  const uploadPolicyAdminRuntime = createAutoListingUploadPolicyAdminRuntime({
    env,
    getPostgresPool: resolvePool,
    getPublicationRuntime,
    assertDirectSystemReady,
  });
  const reconciliationAdminRuntime = createAutoListingSubmissionReconciliationAdminRuntime({
    enabled: uploadEnabled,
    getPool: resolvePool,
  });

  const handleAiAdminRoute = createAutoListingAiAdminHttpHandler({
    authenticate,
    getService: adminRuntime.getService,
    readJson: (req) => readJson(req, { maxBytes: 256 * 1024, requireBody: true }),
    sendJson,
  });
  const handleUserWorkflowRoute = createAutoListingUserWorkflowHttpHandler({
    authenticate,
    getService: userWorkflowRuntime.getService,
    getExcelLimits: () => excelLimits,
    readJson: (req) => readJson(req, {
      maxBytes: autoListingExcelRequestBodyLimit(excelLimits),
      requireBody: true,
    }),
    sendJson,
  });
  const handleReviewAssetRoute = createAutoListingReviewAssetHttpHandler({
    authenticate,
    getService: itemRuntime.getService,
    sendJson,
  });
  const handleItemRoute = createAutoListingItemHttpHandler({
    authenticate,
    getService: itemRuntime.getService,
    readJson: (req) => readJson(req, { maxBytes: 64 * 1024, requireBody: true }),
    sendJson,
  });
  const handleUploadPolicyAdminRoute = createAutoListingUploadPolicyAdminHttpHandler({
    authenticate,
    getService: uploadPolicyAdminRuntime.getService,
    readJson: (req) => readJson(req, { maxBytes: 64 * 1024, requireBody: true }),
    sendJson,
  });
  const handleReconciliationAdminRoute = createAutoListingSubmissionReconciliationAdminHttpHandler({
    authenticate,
    getService: reconciliationAdminRuntime.getService,
    readJson: (req) => readJson(req, { maxBytes: 64 * 1024, requireBody: true }),
    sendJson,
  });
  async function handleAdminRoute(req, res, url) {
    if (await handleUploadPolicyAdminRoute(req, res, url)) return true;
    return handleReconciliationAdminRoute(req, res, url);
  }

  async function startWorkers() {
    let userStarted = false;
    try {
      await userWorkflowRuntime.startWorkers();
      userStarted = true;
      await operationsRuntime.start();
      return true;
    } catch (error) {
      await operationsRuntime.stop().catch(() => {});
      if (userStarted) await userWorkflowRuntime.stopWorkers().catch(() => {});
      throw error;
    }
  }

  async function stopWorkers() {
    await operationsRuntime.stop();
    await userWorkflowRuntime.stopWorkers();
  }

  return Object.freeze({
    handleAiAdminRoute,
    handleUserWorkflowRoute,
    handleReviewAssetRoute,
    handleItemRoute,
    handleUploadPolicyAdminRoute,
    handleReconciliationAdminRoute,
    handleAdminRoute,
    startWorkers,
    stopWorkers,
  });
}
