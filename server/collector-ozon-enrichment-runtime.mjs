import {
  appendAuditEvent,
  createAuditEvent,
  insertPostgresAuditEvent,
} from "./audit-event.mjs";
import {
  createJsonCollectorOzonEnrichmentRepository,
  createPostgresCollectorOzonEnrichmentRepository,
} from "./collector-ozon-enrichment-repository.mjs";
import { createCollectorOzonEnrichmentHttpHandler } from "./collector-ozon-enrichment-routes.mjs";
import { createCollectorOzonEnrichmentService } from "./collector-ozon-enrichment-service.mjs";
import { buildOzonEnrichmentSummary } from "./collect-enrichment-policy.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { createJsonStateTransactionBoundary } from "./json-state-transaction.mjs";
import {
  completeCollectItemEnrichmentV4,
  deferCollectItemEnrichmentV4,
  failCollectItemEnrichmentV4,
  readCollectItemEnrichmentV4,
  retryCollectItemEnrichmentV4,
  saveCollectItemEnrichmentV4,
} from "./listing-pipeline.mjs";

const AUDIT_SAVE_MAX_ATTEMPTS = 4;

export function createCollectorOzonEnrichmentRuntime({
  loadState,
  saveState,
  persistenceMode,
  stateTransaction,
  authenticate,
  authenticateAccount,
  readJson,
  sendJson,
  initializePostgresRepository,
  persistPostgresAuditEvent,
  now,
  randomUUID,
  sleep,
  logger = console,
} = {}) {
  if (
    typeof loadState !== "function"
    || typeof saveState !== "function"
    || typeof persistenceMode !== "function"
    || typeof stateTransaction?.run !== "function"
    || typeof authenticate !== "function"
    || typeof readJson !== "function"
    || typeof sendJson !== "function"
  ) {
    throw new TypeError("Ozon enrichment runtime dependencies are required");
  }

  let postgresRepositoryPromise = null;
  let postgresPoolPromise = null;
  const auditTransaction = createJsonStateTransactionBoundary({ enabled: () => true });

  const initializeRepository = initializePostgresRepository || (async () => {
    await loadState();
    return createPostgresCollectorOzonEnrichmentRepository({ pool: await getPostgresPool() });
  });

  function postgresRepository() {
    if (!postgresRepositoryPromise) {
      const initialization = Promise.resolve().then(initializeRepository);
      postgresRepositoryPromise = initialization;
      initialization.catch(() => {
        if (postgresRepositoryPromise === initialization) postgresRepositoryPromise = null;
      });
    }
    return postgresRepositoryPromise;
  }

  function postgresPool() {
    if (!postgresPoolPromise) {
      postgresPoolPromise = getPostgresPool().catch((error) => {
        postgresPoolPromise = null;
        throw error;
      });
    }
    return postgresPoolPromise;
  }

  const writePostgresAuditEvent = persistPostgresAuditEvent || (async (event) => (
    insertPostgresAuditEvent(await postgresPool(), event)
  ));

  async function callRepository(method, input) {
    if (persistenceMode() === "postgres") {
      return (await postgresRepository())[method](input);
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const repository = createJsonCollectorOzonEnrichmentRepository({ state, persist: saveState });
      return repository[method](input);
    });
  }

  async function enqueueForCollect({ state, ...input } = {}) {
    if (!state || typeof state !== "object") {
      throw new TypeError("Ozon enrichment JSON state required");
    }
    const repository = createJsonCollectorOzonEnrichmentRepository({ state });
    return repository.enqueueForCollect(input);
  }

  async function completeLinkedJobsFromCollectEvidence({ state, ...input } = {}) {
    if (!state || typeof state !== "object") {
      throw new TypeError("Ozon enrichment JSON state required");
    }
    const repository = createJsonCollectorOzonEnrichmentRepository({ state });
    return repository.completeLinkedJobsFromCollectEvidence(input);
  }

  const repository = Object.freeze({
    readCache: (input) => callRepository("readCache", input),
    tryAcquireCacheLease: (input) => callRepository("tryAcquireCacheLease", input),
    releaseCacheLease: (input) => callRepository("releaseCacheLease", input),
    createOrGetJob: (input) => callRepository("createOrGetJob", input),
    advanceSellerContext: (input) => callRepository("advanceSellerContext", input),
    claimNextJob: (input) => callRepository("claimNextJob", input),
    hasClaimableJob: (input) => callRepository("hasClaimableJob", input),
    deferClaim: (input) => callRepository("deferClaim", input),
    completeJobAndCache: (input) => callRepository("completeJobAndCache", input),
    failJobAndCache: (input) => callRepository("failJobAndCache", input),
    readJob: (input) => callRepository("readJob", input),
  });

  function jsonCollectItems(state) {
    return Array.isArray(state?.caches?.collectBox) ? state.caches.collectBox : [];
  }

  function jsonCollectItem(state, { accountId, collectItemId }) {
    return jsonCollectItems(state).find((item) =>
      String(item?.id || "") === String(collectItemId || "")
      && String(item?.accountId || "") === String(accountId || "")
      && item?.deletedAt == null
      && String(item?.status || "") !== "DELETED");
  }

  function jsonCollectItemEvidenceSummary(item = {}) {
    const draft = item.listingDraft && typeof item.listingDraft === "object"
      && !Array.isArray(item.listingDraft)
      ? item.listingDraft
      : {};
    return buildOzonEnrichmentSummary({
      ...item,
      ...draft,
      sourceCategory: draft.sourceCategory || item.sourceCategory,
      categoryResolution: draft.categoryResolution || item.categoryResolution,
      logistics: {
        ...(item.logistics && typeof item.logistics === "object" ? item.logistics : {}),
        ...(draft.logistics && typeof draft.logistics === "object" ? draft.logistics : {}),
      },
    });
  }

  async function readCollectItem(input) {
    if (persistenceMode() === "postgres") return readCollectItemEnrichmentV4(input);
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = jsonCollectItem(state, input);
      return item ? structuredClone(item) : null;
    });
  }

  async function saveCollectItem(input) {
    if (persistenceMode() === "postgres") return saveCollectItemEnrichmentV4(input);
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = jsonCollectItem(state, input);
      if (!item) return null;
      if (input.listingDraft !== undefined) {
        const currentVersion = Number(item.draftVersion || 0);
        if (Number(input.expectedVersion) !== currentVersion) {
          throw Object.assign(
            new Error(`草稿已被其他页面更新，当前版本为 v${currentVersion}，请刷新后重试`),
            { code: "DRAFT_VERSION_CONFLICT", status: 409 },
          );
        }
        item.listingDraft = structuredClone(input.listingDraft);
        item.draftVersion = currentVersion + 1;
      }
      item.status = String(input.status || item.status || "");
      if (input.enrichment && typeof input.enrichment === "object") {
        item.enrichment = structuredClone(input.enrichment);
      }
      item.updatedAt = new Date().toISOString();
      await saveState(state);
      return structuredClone(item);
    });
  }

  async function completeCollectItem({ completion, ...input } = {}) {
    const terminalCompletion = () => {
      const completedAt = typeof now === "function" ? new Date(now()) : new Date();
      if (Number.isNaN(completedAt.getTime())) throw new TypeError("Ozon enrichment completion time required");
      return { ...completion, now: completedAt };
    };
    if (persistenceMode() === "postgres") {
      return completeCollectItemEnrichmentV4({
        ...input,
        completeJobAndCache: async (client) => {
          const terminalRepository = createPostgresCollectorOzonEnrichmentRepository({
            pool: client,
            transactionOwner: "caller",
          });
          await terminalRepository.completeJobAndCache(terminalCompletion());
        },
      });
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = jsonCollectItem(state, input);
      if (!item) return null;
      const currentVersion = Number(item.draftVersion || 0);
      if (Number(input.expectedVersion) !== currentVersion) {
        throw Object.assign(
          new Error(`草稿已被其他页面更新，当前版本为 v${currentVersion}，请刷新后重试`),
          { code: "DRAFT_VERSION_CONFLICT", status: 409 },
        );
      }
      item.listingDraft = structuredClone(input.listingDraft);
      item.draftVersion = currentVersion + 1;
      item.status = String(input.status || item.status || "");
      item.enrichment = structuredClone(input.enrichment);
      const persistedCompletion = terminalCompletion();
      item.updatedAt = persistedCompletion.now.toISOString();
      const terminalRepository = createJsonCollectorOzonEnrichmentRepository({ state });
      await terminalRepository.completeJobAndCache(persistedCompletion);
      await saveState(state);
      return structuredClone(item);
    });
  }

  async function deferCollectItem({ deferClaim, ...input } = {}) {
    if (persistenceMode() === "postgres") {
      return deferCollectItemEnrichmentV4({
        ...input,
        deferJob: async (client) => {
          const repository = createPostgresCollectorOzonEnrichmentRepository({
            pool: client,
            transactionOwner: "caller",
          });
          return repository.deferClaim(deferClaim);
        },
        completeLinkedJobs: async (client, deferredJob) => {
          const repository = createPostgresCollectorOzonEnrichmentRepository({
            pool: client,
            transactionOwner: "caller",
          });
          await repository.completeLinkedJobsFromCollectEvidence({
            accountId: input.accountId,
            collectItemId: input.collectItemId,
            sku: deferredJob.sku,
            now: deferClaim.now,
          });
          return repository.readJob({
            accountId: input.accountId,
            jobId: deferredJob.id,
          });
        },
      });
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = jsonCollectItem(state, input);
      if (!item) return null;
      const repository = createJsonCollectorOzonEnrichmentRepository({ state });
      const deferredJob = await repository.deferClaim(deferClaim);
      const evidenceSummary = jsonCollectItemEvidenceSummary(item);
      if (item.enrichment?.status === "COMPLETE" || evidenceSummary.status === "COMPLETE") {
        await repository.completeLinkedJobsFromCollectEvidence({
          accountId: input.accountId,
          collectItemId: input.collectItemId,
          sku: deferredJob.sku,
          now: deferClaim.now,
        });
        const terminalJob = await repository.readJob({
          accountId: input.accountId,
          jobId: deferredJob.id,
        });
        await saveState(state);
        return { item: structuredClone(item), job: terminalJob };
      }
      const deferredAt = deferClaim.now instanceof Date
        ? deferClaim.now
        : new Date(deferClaim.now);
      if (Number.isNaN(deferredAt.getTime())) {
        throw new TypeError("Ozon enrichment defer time required");
      }
      item.status = String(input.status || "RETRYING");
      item.enrichment = {
        status: item.status,
        missingFields: evidenceSummary.missingFields,
        attemptCount: Number(deferredJob.attemptCount || 0),
        nextAttemptAt: String(deferredJob.nextAttemptAt || ""),
        lastErrorCode: String(input.error?.code || ""),
      };
      item.updatedAt = deferredAt.toISOString();
      await saveState(state);
      return { item: structuredClone(item), job: structuredClone(deferredJob) };
    });
  }

  async function failCollectItem({ failure, ...input } = {}) {
    const terminalFailure = () => {
      const failedAt = typeof now === "function" ? new Date(now()) : new Date();
      if (Number.isNaN(failedAt.getTime())) throw new TypeError("Ozon enrichment failure time required");
      return { ...failure, now: failedAt };
    };
    if (persistenceMode() === "postgres") {
      return failCollectItemEnrichmentV4({
        ...input,
        failJobAndCache: async (client) => {
          const terminalRepository = createPostgresCollectorOzonEnrichmentRepository({
            pool: client,
            transactionOwner: "caller",
          });
          return terminalRepository.failJobAndCache(terminalFailure());
        },
      });
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = jsonCollectItem(state, input);
      if (!item) return null;
      const terminalRepository = createJsonCollectorOzonEnrichmentRepository({ state });
      const persistedFailure = terminalFailure();
      const persistedJob = await terminalRepository.failJobAndCache(persistedFailure);
      item.status = String(input.status || item.status || "");
      item.enrichment = {
        ...(input.enrichment && typeof input.enrichment === "object"
          ? structuredClone(input.enrichment)
          : {}),
        attemptCount: Number(persistedJob.attemptCount || 0),
      };
      item.updatedAt = persistedFailure.now.toISOString();
      await saveState(state);
      return { item: structuredClone(item), job: structuredClone(persistedJob) };
    });
  }

  async function retryCollectItem(input) {
    if (persistenceMode() === "postgres") return retryCollectItemEnrichmentV4(input);
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = jsonCollectItem(state, input);
      if (!item) return null;
      const jobs = Array.isArray(state.collectorOzonEnrichmentJobs)
        ? state.collectorOzonEnrichmentJobs
        : [];
      const scopedJobs = jobs
        .filter((candidate) =>
          String(candidate?.accountId || "") === String(input.accountId || "")
          && String(candidate?.collectItemId || "") === String(input.collectItemId || ""))
        .sort((left, right) =>
          String(right.updatedAt || right.createdAt || "")
            .localeCompare(String(left.updatedAt || left.createdAt || ""))
          || String(right.id || "").localeCompare(String(left.id || "")));
      const evidenceSummary = jsonCollectItemEvidenceSummary(item);
      if (item.enrichment?.status === "COMPLETE" || evidenceSummary.status === "COMPLETE") {
        const terminalJob = scopedJobs.find((candidate) => candidate?.status === "SUCCESS")
          || scopedJobs[0];
        return terminalJob
          ? { item: structuredClone(item), job: structuredClone(terminalJob) }
          : null;
      }
      const job = scopedJobs.find((candidate) => {
        if (!["PENDING", "PROCESSING", "FAILED"].includes(candidate?.status)) return false;
        const code = String(candidate?.error?.code || candidate?.lastError?.code || "");
        return code !== "OZON_ENRICHMENT_DUPLICATE_SUPERSEDED";
      });
      if (!job) return null;
      const retriedAt = input.now instanceof Date ? new Date(input.now) : new Date(input.now);
      if (Number.isNaN(retriedAt.getTime())) throw new TypeError("Ozon enrichment retry time required");
      if (
        job.status === "PROCESSING"
        && Number.isFinite(new Date(job.claimExpiresAt).getTime())
        && new Date(job.claimExpiresAt).getTime() > retriedAt.getTime()
      ) {
        return { item: structuredClone(item), job: structuredClone(job) };
      }
      job.status = "PENDING";
      job.nextAttemptAt = retriedAt.toISOString();
      job.lastError = null;
      job.error = null;
      job.claimedSessionId = null;
      job.claimExpiresAt = null;
      job.completedAt = null;
      job.updatedAt = retriedAt.toISOString();
      const currentEnrichment = item.enrichment && typeof item.enrichment === "object"
        ? item.enrichment
        : {};
      item.status = "RETRYING";
      item.enrichment = {
        ...currentEnrichment,
        status: "RETRYING",
        attemptCount: Number(job.attemptCount || 0),
        nextAttemptAt: retriedAt.toISOString(),
        lastErrorCode: "",
      };
      item.updatedAt = retriedAt.toISOString();
      await saveState(state);
      return { item: structuredClone(item), job: structuredClone(job) };
    });
  }

  const collectItems = Object.freeze({
    read: readCollectItem,
    save: saveCollectItem,
    complete: completeCollectItem,
    fail: failCollectItem,
    defer: deferCollectItem,
    retry: retryCollectItem,
  });

  async function audit(event = {}) {
    const auditEvent = createAuditEvent({
      correlationId: String(event.requestId || ""),
      action: String(event.action || "COLLECTOR_OZON_ENRICHMENT"),
      status: String(event.status || "UNKNOWN"),
      accountId: String(event.accountId || ""),
      deviceId: String(event.collectorSessionId || ""),
      source: "collector-ozon-enrichment",
      actorType: String(event.actorType || "collector_session"),
      actorId: String(event.actorId || event.collectorSessionId || ""),
      entityType: "ozon_enrichment_job",
      entityId: String(event.jobId || event.sku || ""),
      metadata: {
        requestId: String(event.requestId || ""),
        sku: String(event.sku || ""),
        jobId: String(event.jobId || ""),
        collectorSessionId: String(event.collectorSessionId || ""),
        cacheHit: event.cacheHit === true,
        durationMs: Math.max(0, Number(event.durationMs) || 0),
        code: String(event.code || ""),
        missingFields: Array.isArray(event.missingFields) ? event.missingFields : [],
        responseSha256: String(event.responseHash || ""),
        ...(event.captureContext && typeof event.captureContext === "object"
          ? {
              sellerCompanyId: String(event.captureContext.sellerCompanyId || ""),
              revision: Number(event.captureContext.revision || 0),
              observedAt: String(event.captureContext.observedAt || ""),
            }
          : {}),
      },
    });
    if (persistenceMode() === "postgres") {
      await writePostgresAuditEvent(auditEvent);
      return;
    }
    await auditTransaction.run(() => stateTransaction.run(async () => {
      let lastConflict = null;
      for (let attempt = 0; attempt < AUDIT_SAVE_MAX_ATTEMPTS; attempt += 1) {
        const state = await loadState();
        appendAuditEvent(state, auditEvent);
        try {
          await saveState(state);
          return;
        } catch (error) {
          if (error?.code !== "LOCAL_STATE_VERSION_CONFLICT") throw error;
          lastConflict = error;
        }
      }
      throw lastConflict;
    }));
  }

  const service = createCollectorOzonEnrichmentService({
    repository,
    collectItems,
    audit,
    ...(now ? { now } : {}),
    ...(randomUUID ? { randomUUID } : {}),
    ...(sleep ? { sleep } : {}),
    onAuditError: (event) => logger?.error?.(
      "collector Ozon enrichment audit persistence failed",
      event,
    ),
  });
  const handleHttpRoute = createCollectorOzonEnrichmentHttpHandler({
    authenticate,
    authenticateAccount: authenticateAccount || authenticate,
    service,
    readJson,
    sendJson,
    ...(now ? { now } : {}),
  });

  return Object.freeze({
    repository,
    service,
    handleHttpRoute,
    enqueueForCollect,
    completeLinkedJobsFromCollectEvidence,
  });
}
