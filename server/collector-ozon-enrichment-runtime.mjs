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
import { getPostgresPool } from "./db/connection.mjs";
import { createJsonStateTransactionBoundary } from "./json-state-transaction.mjs";

const AUDIT_SAVE_MAX_ATTEMPTS = 4;

export function createCollectorOzonEnrichmentRuntime({
  loadState,
  saveState,
  persistenceMode,
  stateTransaction,
  authenticate,
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

  const repository = Object.freeze({
    readCache: (input) => callRepository("readCache", input),
    tryAcquireCacheLease: (input) => callRepository("tryAcquireCacheLease", input),
    releaseCacheLease: (input) => callRepository("releaseCacheLease", input),
    createOrGetJob: (input) => callRepository("createOrGetJob", input),
    claimNextJob: (input) => callRepository("claimNextJob", input),
    completeJobAndCache: (input) => callRepository("completeJobAndCache", input),
    failJobAndCache: (input) => callRepository("failJobAndCache", input),
    readJob: (input) => callRepository("readJob", input),
  });

  async function audit(event = {}) {
    const auditEvent = createAuditEvent({
      correlationId: String(event.requestId || ""),
      action: String(event.action || "COLLECTOR_OZON_ENRICHMENT"),
      status: String(event.status || "UNKNOWN"),
      accountId: String(event.accountId || ""),
      deviceId: String(event.collectorSessionId || ""),
      source: "collector-ozon-enrichment",
      actorType: "collector_session",
      actorId: String(event.collectorSessionId || ""),
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
    service,
    readJson,
    sendJson,
  });

  return Object.freeze({ repository, service, handleHttpRoute, enqueueForCollect });
}
