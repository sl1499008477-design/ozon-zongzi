import { types as utilTypes } from "node:util";

import { createAutoListingRfbsWarehouseVerifier } from "./auto-listing-rfbs-warehouse-verifier.mjs";
import { createPostgresAutoListingUploadRepository } from "./auto-listing-upload-postgres.mjs";
import { createAutoListingUploadService } from "./auto-listing-upload-service.mjs";
import { createPostgresAutoListingUploadTaskRepository } from "./auto-listing-upload-task-postgres.mjs";
import { createAutoListingUploadTaskWorker } from "./auto-listing-upload-task-worker.mjs";
import { callOzonSellerApi as defaultCallOzonSellerApi } from "./ozon-client.mjs";

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
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
  } catch { return null; }
}

export function createAutoListingUploadRuntime({
  pool,
  publicationRuntime,
  standardSubmissionPort,
  assertDirectSystemReady,
  uploadEnabled = false,
  listingPipelineEnabled = false,
  directUploadAllowed = false,
  worker = {},
  logger = console,
  timers = globalThis,
  createUploadRepository = createPostgresAutoListingUploadRepository,
  createTaskRepository = createPostgresAutoListingUploadTaskRepository,
  createUploadService = createAutoListingUploadService,
  createTaskWorker = createAutoListingUploadTaskWorker,
  createRfbsWarehouseVerifier = createAutoListingRfbsWarehouseVerifier,
  readStoreCredential = null,
  callOzonSellerApi = defaultCallOzonSellerApi,
} = {}) {
  if (typeof pool?.connect !== "function" || typeof pool?.query !== "function"
    || typeof publicationRuntime?.publishListingAsset !== "function"
    || typeof publicationRuntime?.assertDirectReady !== "function"
    || typeof publicationRuntime?.checkPublicationHealth !== "function"
    || !publicationRuntime.publicationPolicy
    || !publicationRuntime.richContentPublicationPolicy
    || typeof standardSubmissionPort?.createSubmission !== "function"
    || typeof standardSubmissionPort?.findSubmission !== "function"
    || typeof assertDirectSystemReady !== "function"
    || ![uploadEnabled, listingPipelineEnabled, directUploadAllowed].every((value) => typeof value === "boolean")
    || !worker || typeof worker !== "object" || Array.isArray(worker)
    || typeof createUploadRepository !== "function" || typeof createTaskRepository !== "function"
    || typeof createUploadService !== "function" || typeof createTaskWorker !== "function") {
    throw new TypeError("Auto-listing upload runtime dependencies are required");
  }
  if (typeof createRfbsWarehouseVerifier !== "function"
    || !(readStoreCredential === null || typeof readStoreCredential === "function")
    || typeof callOzonSellerApi !== "function") {
    throw new TypeError("Auto-listing upload RFBS runtime dependencies are required");
  }
  const resolveStoreCredential = readStoreCredential || (async (storeId, accountId) => {
    const { readStoreCredentialV3 } = await import("./listing-pipeline.mjs");
    return readStoreCredentialV3(storeId, accountId);
  });
  let rfbsWarehouseVerifier;
  try {
    rfbsWarehouseVerifier = createRfbsWarehouseVerifier({
      async loadTarget({ accountId, targetStoreId, targetWarehouseId }) {
        const result = await pool.query(
          `SELECT w.id,s.owner_account_id AS account_id,w.store_id,w.warehouse_id,w.warehouse_type,
                  w.status,w.is_active,w.is_archived
             FROM warehouses AS w
             JOIN stores AS s ON s.id=w.store_id
            WHERE s.owner_account_id=$1 AND w.store_id=$2 AND w.id=$3
            LIMIT 1`,
          [accountId, targetStoreId, targetWarehouseId],
        );
        const row = result.rows[0];
        return row ? { id: row.id, accountId: row.account_id, storeId: row.store_id,
          warehouse_id: row.warehouse_id, warehouse_type: row.warehouse_type, status: row.status,
          is_active: row.is_active, is_archived: row.is_archived } : null;
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
  const uploadRepository = createUploadRepository({ pool });
  const taskRepository = createTaskRepository({ pool });
  const uploadService = createUploadService({
    repository: uploadRepository,
    publishListingAsset: publicationRuntime.publishListingAsset,
    checkPublicationHealth: publicationRuntime.checkPublicationHealth,
    assertDirectSystemReady,
    assertDirectReady: publicationRuntime.assertDirectReady,
    publicationPolicy: publicationRuntime.publicationPolicy,
    richContentPublicationPolicy: publicationRuntime.richContentPublicationPolicy,
    createSubmission: standardSubmissionPort.createSubmission,
    findSubmission: standardSubmissionPort.findSubmission,
    uploadEnabled,
    listingPipelineEnabled,
    directUploadAllowed,
    rfbsWarehouseVerifier: closedRfbsWarehouseVerifier,
  });
  const taskWorker = createTaskWorker({
    enabled: worker.enabled === true,
    ...(worker.enabled === true ? {
      repository: taskRepository,
      uploadService,
      workerId: worker.workerId ?? "auto-listing-upload-worker",
      accountScanLimit: worker.accountScanLimit ?? 100,
      pollIntervalMs: worker.pollIntervalMs ?? 1_000,
      leaseMs: worker.leaseMs ?? 60_000,
      baseDelayMs: worker.baseDelayMs ?? 5_000,
      maxDelayMs: worker.maxDelayMs ?? 900_000,
      maxAttempts: worker.maxAttempts ?? 20,
      logger,
      timers,
    } : {}),
  });
  return Object.freeze({
    uploadService,
    start: () => taskWorker.start(),
    runOnce: () => taskWorker.runOnce(),
    stop: () => taskWorker.stop(),
  });
}
