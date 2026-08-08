import { createPostgresAutoListingUploadRepository } from "./auto-listing-upload-postgres.mjs";
import { createAutoListingUploadService } from "./auto-listing-upload-service.mjs";
import { createPostgresAutoListingUploadTaskRepository } from "./auto-listing-upload-task-postgres.mjs";
import { createAutoListingUploadTaskWorker } from "./auto-listing-upload-task-worker.mjs";

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
} = {}) {
  if (typeof pool?.connect !== "function" || typeof pool?.query !== "function"
    || typeof publicationRuntime?.publishListingAsset !== "function"
    || typeof publicationRuntime?.assertDirectReady !== "function"
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
  const uploadRepository = createUploadRepository({ pool });
  const taskRepository = createTaskRepository({ pool });
  const uploadService = createUploadService({
    repository: uploadRepository,
    publishListingAsset: publicationRuntime.publishListingAsset,
    assertDirectSystemReady,
    assertDirectReady: publicationRuntime.assertDirectReady,
    publicationPolicy: publicationRuntime.publicationPolicy,
    richContentPublicationPolicy: publicationRuntime.richContentPublicationPolicy,
    createSubmission: standardSubmissionPort.createSubmission,
    findSubmission: standardSubmissionPort.findSubmission,
    uploadEnabled,
    listingPipelineEnabled,
    directUploadAllowed,
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
