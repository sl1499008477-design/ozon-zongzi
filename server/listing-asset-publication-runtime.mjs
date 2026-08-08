import { createListingAssetPublicationCleanupWorker } from "./listing-asset-publication-cleanup.mjs";
import { createPostgresListingAssetPublicationCleanupRepository } from "./listing-asset-publication-cleanup-postgres.mjs";
import { createPostgresListingAssetPublicationHealthRepository } from "./listing-asset-publication-health-postgres.mjs";
import { createPostgresListingAssetPublicationRepository } from "./listing-asset-publication-postgres.mjs";
import { createListingAssetPublicationService } from "./listing-asset-publication.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const PROBE_KEYS = new Set(["probeKind", "httpStatus", "contentTypeMatched", "bytesMatched"]);
const BATCH_KEYS = new Set(["workerId", "limit"]);

function runtimeError(code, status = 503, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function accountInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, "accountId")
    || typeof value.accountId !== "string" || !SAFE_ID.test(value.accountId)) {
    throw runtimeError("LISTING_ASSET_PUBLICATION_RUNTIME_INVALID", 422);
  }
  return value.accountId;
}

function policyKey(value, prefix) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key.startsWith(`${prefix}/`) || key.includes("..") || key.includes("//")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u.test(key)) {
    throw runtimeError("LISTING_ASSET_PUBLICATION_POLICY_BOUNDARY", 422);
  }
  return key;
}

function probeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== PROBE_KEYS.size
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !PROBE_KEYS.has(key))
    || value.probeKind !== "PUBLIC_READBACK" || !Number.isSafeInteger(value.httpStatus)
    || value.httpStatus < 100 || value.httpStatus > 599
    || typeof value.contentTypeMatched !== "boolean" || typeof value.bytesMatched !== "boolean") {
    throw runtimeError("LISTING_ASSET_PUBLICATION_HEALTH_INVALID", 422);
  }
  return Object.freeze({ ...value });
}

function exactHealthInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "accountId")
    || !Object.hasOwn(value, "checkedByAccountId")
    || !SAFE_ID.test(value.accountId || "") || value.checkedByAccountId !== value.accountId) {
    throw runtimeError("LISTING_ASSET_PUBLICATION_HEALTH_INVALID", 422);
  }
  return value;
}

function batchInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== BATCH_KEYS.size
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !BATCH_KEYS.has(key))
    || !SAFE_ID.test(value.workerId || "") || !Number.isSafeInteger(value.limit)
    || value.limit < 1 || value.limit > 100) {
    throw runtimeError("LISTING_ASSET_PUBLICATION_RUNTIME_INVALID", 422);
  }
  return value;
}

export function createListingAssetPublicationRuntime({
  pool = null,
  storage,
  config,
  publicationRepository = null,
  cleanupRepository = null,
  healthRepository = null,
  probePublicPolicy = null,
  logger = null,
  metrics = null,
  clock = () => new Date(),
  healthTtlMs = 5 * 60_000,
  createPublicationService = createListingAssetPublicationService,
  createCleanupWorker = createListingAssetPublicationCleanupWorker,
} = {}) {
  if (!config || typeof config.baseUrl !== "string" || typeof config.prefix !== "string"
    || typeof config.publicationVersion !== "string" || typeof storage?.putObjectFromBuffer !== "function"
    || typeof storage?.getObjectBuffer !== "function" || typeof storage?.removeObject !== "function"
    || typeof clock !== "function" || !Number.isSafeInteger(healthTtlMs) || healthTtlMs < 60_000
    || healthTtlMs > 60 * 60_000 || typeof createPublicationService !== "function"
    || typeof createCleanupWorker !== "function") {
    throw new TypeError("Listing asset publication runtime dependencies are required");
  }
  const publicationPolicy = Object.freeze({
    origin: new URL(config.baseUrl).origin,
    baseUrl: config.baseUrl,
    prefix: config.prefix,
    publicationVersion: config.publicationVersion,
  });
  const publications = publicationRepository || createPostgresListingAssetPublicationRepository({ pool });
  const cleanups = cleanupRepository || createPostgresListingAssetPublicationCleanupRepository({ pool });
  const health = healthRepository || createPostgresListingAssetPublicationHealthRepository({ pool });
  if (typeof publications?.findPublication !== "function" || typeof publications?.loadAcceptedAsset !== "function"
    || typeof publications?.recordPublication !== "function" || typeof cleanups?.recordCleanupRequired !== "function"
    || typeof cleanups?.listRunnableCleanupTasks !== "function"
    || typeof cleanups?.claimCleanup !== "function" || typeof cleanups?.completeCleanup !== "function"
    || typeof cleanups?.failCleanup !== "function" || typeof health?.findReadyEvidence !== "function"
    || typeof health?.recordEvidence !== "function") {
    throw new TypeError("Listing asset publication runtime repositories are required");
  }

  const publicStorage = Object.freeze({
    putPublicObject(input = {}) {
      policyKey(input.key, config.prefix);
      return storage.putObjectFromBuffer(input);
    },
    readPublicObject({ key, maxBytes } = {}) {
      return storage.getObjectBuffer(policyKey(key, config.prefix), { maxBytes });
    },
    removePublicObject({ key } = {}) {
      return storage.removeObject(policyKey(key, config.prefix));
    },
  });
  const publicationService = createPublicationService({
    repository: publications,
    readPrivateObject: ({ key, maxBytes }) => storage.getObjectBuffer(key, { maxBytes }),
    putPublicObject: publicStorage.putPublicObject,
    readPublicObject: publicStorage.readPublicObject,
    recordOrphanCleanup: (input) => cleanups.recordCleanupRequired(input),
    config,
    logger,
    metrics,
  });
  const cleanupWorker = createCleanupWorker({
    repository: cleanups,
    removePublicObject: publicStorage.removePublicObject,
    resolvePolicy: (version) => version === config.publicationVersion ? config : null,
    logger,
  });

  return Object.freeze({
    publicationPolicy,
    richContentPublicationPolicy: Object.freeze({ origin: publicationPolicy.origin }),
    publishListingAsset: publicationService.publishListingAsset.bind(publicationService),
    processCleanup: cleanupWorker.processCleanup.bind(cleanupWorker),

    async runCleanupBatch(value = {}) {
      const input = batchInput(value);
      let tasks;
      try { tasks = await cleanups.listRunnableCleanupTasks({ limit: input.limit }); }
      catch { throw runtimeError("LISTING_ASSET_PUBLICATION_CLEANUP_FAILED", 503, true); }
      if (!Array.isArray(tasks) || tasks.length > input.limit) {
        throw runtimeError("LISTING_ASSET_PUBLICATION_CLEANUP_FAILED", 503, true);
      }
      let cleaned = 0; let referenced = 0; let failed = 0;
      for (const task of tasks) {
        if (!task || !SAFE_ID.test(task.accountId || "") || !SAFE_ID.test(task.cleanupId || "")) {
          failed += 1;
          continue;
        }
        try {
          const result = await cleanupWorker.processCleanup({
            accountId: task.accountId, cleanupId: task.cleanupId, workerId: input.workerId,
          });
          if (result?.status === "CLEANED") cleaned += 1;
          else if (result?.status === "REFERENCED") referenced += 1;
          else failed += 1;
        } catch { failed += 1; }
      }
      return Object.freeze({ scanned: tasks.length, cleaned, referenced, failed });
    },

    async assertDirectReady(value = {}) {
      const accountId = accountInput(value);
      let evidence;
      try {
        evidence = await health.findReadyEvidence({
          accountId,
          publicationVersion: config.publicationVersion,
          publicBaseUrl: config.baseUrl,
          publicPrefix: config.prefix,
          now: clock(),
        });
      } catch {
        throw runtimeError("LISTING_ASSET_PUBLICATION_NOT_READY", 503, true);
      }
      const now = clock().getTime();
      if (!evidence || evidence.accountId !== accountId || evidence.outcome !== "PASSED"
        || evidence.publicationVersion !== config.publicationVersion
        || evidence.publicBaseUrl !== config.baseUrl || evidence.publicPrefix !== config.prefix
        || !SAFE_ID.test(evidence.id || "") || Date.parse(evidence.expiresAt || "") <= now) {
        throw runtimeError("LISTING_ASSET_PUBLICATION_NOT_READY", 503, true);
      }
      return Object.freeze({
        ready: true,
        evidenceId: evidence.id,
        publicationVersion: evidence.publicationVersion,
        expiresAt: new Date(evidence.expiresAt).toISOString(),
      });
    },

    async checkPublicationHealth(value = {}) {
      const input = exactHealthInput(value);
      if (typeof probePublicPolicy !== "function") {
        throw runtimeError("LISTING_ASSET_PUBLICATION_HEALTH_PROBE_DISABLED", 503, false);
      }
      const checkedAt = clock();
      let result;
      try { result = await probePublicPolicy(publicationPolicy); } catch { result = { ok: false, evidence: {
        probeKind: "PUBLIC_READBACK", httpStatus: 503, contentTypeMatched: false, bytesMatched: false,
      } }; }
      if (!result || typeof result !== "object" || Array.isArray(result)
        || Reflect.ownKeys(result).length !== 2 || typeof result.ok !== "boolean") {
        throw runtimeError("LISTING_ASSET_PUBLICATION_HEALTH_INVALID", 422);
      }
      const evidence = probeEvidence(result.evidence);
      const outcome = result.ok === true && evidence.httpStatus >= 200 && evidence.httpStatus < 300
        && evidence.contentTypeMatched && evidence.bytesMatched ? "PASSED" : "FAILED";
      const expiresAt = new Date(checkedAt.getTime() + healthTtlMs);
      let stored;
      try {
        stored = await health.recordEvidence({
          accountId: input.accountId,
          publicationVersion: config.publicationVersion,
          publicBaseUrl: config.baseUrl,
          publicPrefix: config.prefix,
          outcome,
          evidence,
          checkedByAccountId: input.checkedByAccountId,
          checkedAt,
          expiresAt,
        });
      } catch {
        throw runtimeError("LISTING_ASSET_PUBLICATION_HEALTH_PERSIST_FAILED", 503, true);
      }
      if (!stored || stored.accountId !== input.accountId || stored.publicationVersion !== config.publicationVersion
        || stored.publicBaseUrl !== config.baseUrl || stored.publicPrefix !== config.prefix || stored.outcome !== outcome) {
        throw runtimeError("LISTING_ASSET_PUBLICATION_HEALTH_PERSIST_FAILED", 503, true);
      }
      return Object.freeze({
        accountId: input.accountId, evidenceId: stored.id, outcome,
        checkedAt: new Date(stored.checkedAt || checkedAt).toISOString(),
        expiresAt: new Date(stored.expiresAt || expiresAt).toISOString(),
      });
    },
  });
}
