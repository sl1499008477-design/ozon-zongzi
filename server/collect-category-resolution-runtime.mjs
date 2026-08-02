import crypto from "node:crypto";
import {
  appendAuditEvent,
  insertPostgresAuditEvent,
} from "./audit-event.mjs";
import {
  createJsonCollectCategoryResolutionRepository,
  createPostgresCollectCategoryResolutionRepository,
} from "./collect-category-resolution-repository.mjs";
import { createCollectCategoryResolutionService } from "./collect-category-resolution-service.mjs";
import { TAXONOMY_SCOPE_OZON_DEFAULT } from "./collect-category-resolution-policy.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import {
  readCollectItemEnrichmentV4,
  readStoreCredentialV3,
} from "./listing-pipeline.mjs";

const DEFAULT_BATCH_LIMIT = 8;
const MAX_BATCH_LIMIT = 16;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_INTERVAL_MS = 15_000;
const AUDIT_EVENT_KEYS = new Set([
  "action",
  "accountId",
  "collectItemId",
  "taxonomyScope",
  "sourceTypeId",
  "targetDescriptionCategoryId",
  "targetTypeId",
  "credentialStoreId",
  "taxonomyFingerprint",
  "attempt",
  "failureCode",
]);

function text(value) {
  return String(value ?? "").trim();
}

function boundedLimit(value) {
  const requested = Number(value);
  if (!Number.isInteger(requested) || requested <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(requested, MAX_BATCH_LIMIT);
}

function stableErrorCode(error) {
  const code = text(error?.code).toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(code) ? code : "CATEGORY_RESOLUTION_RUNTIME_FAILED";
}

function safeLogger(logger) {
  return Object.freeze({
    error(action, context = {}) {
      try {
        logger?.error?.(action, Object.fromEntries(
          Object.entries(context).filter(([, value]) => value !== undefined && value !== null && value !== ""),
        ));
      } catch {
        // Observability must never become a business failure.
      }
    },
  });
}

function categoryAuditEvent(event = {}) {
  return {
    action: text(event.action || "COLLECT_CATEGORY_RESOLUTION"),
    status: "SUCCESS",
    accountId: text(event.accountId),
    storeId: text(event.credentialStoreId),
    source: "collect-category-resolution",
    actorType: "system",
    actorId: text(event.accountId),
    entityType: "collect_category_resolution",
    entityId: text(event.collectItemId),
    metadata: {
      collectItemId: text(event.collectItemId),
      taxonomyScope: text(event.taxonomyScope),
      sourceTypeId: event.sourceTypeId ?? null,
      targetDescriptionCategoryId: event.targetDescriptionCategoryId ?? null,
      targetTypeId: event.targetTypeId ?? null,
      taxonomyFingerprint: text(event.taxonomyFingerprint),
      attempt: Number(event.attempt || 0),
      failureCode: text(event.failureCode),
    },
  };
}

function validInstantMillis(value) {
  if (!value) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function createCollectCategoryResolutionRuntime({
  loadState,
  saveState,
  stateTransaction,
  persistenceMode,
  categoryService,
  currentCredentialStoreForAccount,
  readCollectItem: providedReadCollectItem = null,
  readCredentialStore: providedReadCredentialStore = null,
  listCollectItems: providedListCollectItems = null,
  readPostgresStoreCredential = readStoreCredentialV3,
  appendAudit = appendAuditEvent,
  initializePostgresRepository = null,
  createPostgresRepository = createPostgresCollectCategoryResolutionRepository,
  postgresPool = getPostgresPool,
  persistPostgresAuditEvent = insertPostgresAuditEvent,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
  logger = console,
  timers = globalThis,
} = {}) {
  if (
    typeof loadState !== "function"
    || typeof saveState !== "function"
    || typeof stateTransaction?.run !== "function"
    || typeof persistenceMode !== "function"
    || typeof categoryService?.getCategorySnapshot !== "function"
    || typeof categoryService?.validateTarget !== "function"
    || typeof currentCredentialStoreForAccount !== "function"
    || typeof appendAudit !== "function"
    || typeof readPostgresStoreCredential !== "function"
    || typeof createPostgresRepository !== "function"
    || typeof now !== "function"
    || typeof randomUUID !== "function"
  ) {
    throw new TypeError("Collect category resolution runtime dependencies are required");
  }

  const log = safeLogger(logger);
  let postgresRepositoryPromise = null;
  let drainPromise = null;
  let initialTimer = null;
  let intervalTimer = null;
  const storeWakeTimers = new Set();
  const activeStoreWakes = new Set();
  const trustedCredentialStoreSnapshots = new WeakMap();
  let storeWakeEpoch = 0;

  async function initializeDefaultPostgresRepository() {
    const pool = await postgresPool();
    return createPostgresRepository({
      pool,
      auditWriter: ({ executor, event }) => persistPostgresAuditEvent(
        executor,
        categoryAuditEvent(event),
      ),
    });
  }

  async function postgresRepository() {
    if (!postgresRepositoryPromise) {
      const initialization = Promise.resolve().then(
        initializePostgresRepository || initializeDefaultPostgresRepository,
      );
      postgresRepositoryPromise = initialization;
      initialization.catch(() => {
        if (postgresRepositoryPromise === initialization) postgresRepositoryPromise = null;
      });
    }
    return postgresRepositoryPromise;
  }

  async function callJsonRepository(method, input) {
    return stateTransaction.run(async () => {
      const state = await loadState();
      const jsonRepository = createJsonCollectCategoryResolutionRepository({
        state,
        persist: saveState,
        stateTransaction,
        auditWriter: async ({ state: transactionState, event }) => {
          await appendAudit(transactionState, categoryAuditEvent(event));
        },
      });
      return jsonRepository[method](input);
    });
  }

  async function callRepository(method, input) {
    if (persistenceMode() === "postgres") {
      return (await postgresRepository())[method](input);
    }
    return callJsonRepository(method, input);
  }

  const repository = Object.freeze(Object.fromEntries(
    [
      "enqueue",
      "readForItem",
      "claimNext",
      "completeMatched",
      "completeNeedsReview",
      "deferRetry",
      "invalidate",
      "saveManual",
      "requeueClaim",
      "validateMatched",
      "deferValidation",
    ].map((method) => [method, (input) => callRepository(method, input)]),
  ));

  async function readCollectItem(input) {
    if (typeof providedReadCollectItem === "function") return providedReadCollectItem(input);
    if (persistenceMode() === "postgres") return readCollectItemEnrichmentV4(input);
    return stateTransaction.run(async () => {
      const state = await loadState();
      const item = (Array.isArray(state?.caches?.collectBox) ? state.caches.collectBox : [])
        .find((candidate) => text(candidate?.id) === text(input.collectItemId)
          && text(candidate?.accountId) === text(input.accountId)
          && candidate?.deletedAt == null
          && text(candidate?.status).toUpperCase() !== "DELETED");
      return item ? structuredClone(item) : null;
    });
  }

  async function readCredentialStore(input) {
    if (typeof providedReadCredentialStore === "function") return providedReadCredentialStore(input);
    if (persistenceMode() === "postgres") {
      const credential = await readPostgresStoreCredential(input.storeId, input.accountId);
      if (!credential) return null;
      const state = await loadState();
      const catalogStore = (Array.isArray(state?.stores) ? state.stores : [])
        .find((candidate) => text(candidate?.id) === text(input.storeId)
          && text(candidate?.ownerAccountId) === text(input.accountId));
      return catalogStore
        ? { ...structuredClone(catalogStore), ...credential, ownerAccountId: input.accountId }
        : null;
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const store = (Array.isArray(state?.stores) ? state.stores : [])
        .find((candidate) => text(candidate?.id) === text(input.storeId)
          && text(candidate?.ownerAccountId) === text(input.accountId));
      return store ? structuredClone(store) : null;
    });
  }

  async function listStoreWakeItems({
    accountId,
    afterCollectItemId = "",
    afterTaxonomyScope = "",
    limit = MAX_BATCH_LIMIT,
  }) {
    const safeLimit = Math.min(MAX_BATCH_LIMIT + 1, Math.max(1, Number(limit) || MAX_BATCH_LIMIT));
    const cursor = text(afterCollectItemId);
    const scopeCursor = text(afterTaxonomyScope);
    if (typeof providedListCollectItems === "function") {
      const items = await providedListCollectItems({
        accountId,
        afterCollectItemId: cursor,
        afterTaxonomyScope: scopeCursor,
        limit: safeLimit,
        purpose: "STORE_WAKE",
        statuses: ["WAITING_STORE", "MATCHED"],
      });
      return Array.isArray(items) ? items : [];
    }
    if (persistenceMode() === "postgres") {
      const pool = await postgresPool();
      const result = await pool.query(
        `SELECT item.id,item.account_id,resolution.taxonomy_scope
           FROM collect_category_resolutions resolution
           JOIN collect_items item
             ON item.account_id=resolution.account_id
            AND item.id=resolution.collect_item_id
          WHERE resolution.account_id=$1
            AND resolution.status IN ('WAITING_STORE','MATCHED')
            AND item.deleted_at IS NULL
            AND (item.id,resolution.taxonomy_scope)>($2,$3)
          ORDER BY item.id,resolution.taxonomy_scope
          LIMIT $4`,
        [accountId, cursor, scopeCursor, safeLimit],
      );
      const items = await Promise.all(result.rows.map(async (row) => {
        const item = await readCollectItem({
          accountId: text(row.account_id),
          collectItemId: text(row.id),
        });
        return item ? { ...item, taxonomyScope: text(row.taxonomy_scope) } : null;
      }));
      return items.filter(Boolean);
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      const itemsById = new Map(
        (Array.isArray(state?.caches?.collectBox) ? state.caches.collectBox : [])
          .filter((item) => text(item?.accountId) === accountId
            && item?.deletedAt == null
            && text(item?.status).toUpperCase() !== "DELETED")
          .map((item) => [text(item?.id), item]),
      );
      return (Array.isArray(state?.collectCategoryResolutions)
        ? state.collectCategoryResolutions
        : [])
        .filter((record) => text(record?.accountId) === accountId
          && ["WAITING_STORE", "MATCHED"].includes(text(record?.status).toUpperCase())
          && (text(record?.collectItemId) > cursor
            || (text(record?.collectItemId) === cursor
              && text(record?.taxonomyScope) > scopeCursor))
          && itemsById.has(text(record?.collectItemId)))
        .sort((left, right) => text(left.collectItemId).localeCompare(text(right.collectItemId))
          || text(left.taxonomyScope).localeCompare(text(right.taxonomyScope)))
        .slice(0, safeLimit)
        .map((record) => ({
          ...structuredClone(itemsById.get(text(record.collectItemId))),
          taxonomyScope: text(record.taxonomyScope),
        }));
    });
  }

  const collectItemPort = Object.freeze({ read: readCollectItem });

  const auditPort = Object.freeze({
    prepare(event = {}) {
      const prepared = {};
      for (const [key, value] of Object.entries(event)) {
        if (AUDIT_EVENT_KEYS.has(key)) prepared[key] = structuredClone(value);
      }
      return prepared;
    },
  });

  const service = createCollectCategoryResolutionService({
    repository,
    categoryPort: categoryService,
    collectItemPort,
    storePort: { readCredentialStore },
    auditPort,
    now,
    randomUUID,
  });

  async function backendCredentialStoreId(accountId) {
    const value = await currentCredentialStoreForAccount(accountId);
    return text(value?.id ?? value);
  }

  async function captureCredentialStoreSnapshot(input = {}) {
    const accountId = text(input.accountId);
    const acceptedContext = Object.freeze({
      accountId,
      credentialStoreId: await backendCredentialStoreId(accountId),
    });
    const snapshot = Object.freeze({});
    trustedCredentialStoreSnapshots.set(snapshot, acceptedContext);
    return snapshot;
  }

  function credentialStoreContextFromSnapshot(accountId, snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const acceptedContext = trustedCredentialStoreSnapshots.get(snapshot);
    if (!acceptedContext || text(acceptedContext.accountId) !== accountId) return null;
    return acceptedContext;
  }

  async function scheduleForCollect(input = {}) {
    const accountId = text(input.accountId);
    const acceptedStoreContext = credentialStoreContextFromSnapshot(
      accountId,
      input.credentialStoreSnapshot,
    );
    return service.scheduleForCollect({
      accountId,
      collectItemId: input.collectItemId,
      credentialStoreId: acceptedStoreContext
        ? acceptedStoreContext.credentialStoreId
        : await backendCredentialStoreId(accountId),
      taxonomyScope: input.taxonomyScope,
    });
  }

  async function onEnrichmentComplete(input = {}) {
    const accountId = text(input.accountId);
    return service.onEnrichmentComplete({
      accountId,
      collectItemId: input.collectItemId,
      credentialStoreId: await backendCredentialStoreId(accountId),
      taxonomyScope: input.taxonomyScope,
    });
  }

  async function processStoreWakePage({
    accountId,
    storeId,
    afterCollectItemId = "",
    afterTaxonomyScope = "",
  }) {
    const storeContext = await service.operatingStoreContext({ accountId, storeId });
    if (!storeContext) return { results: [], nextCursor: null };
    const candidates = await listStoreWakeItems({
      accountId,
      afterCollectItemId,
      afterTaxonomyScope,
      limit: MAX_BATCH_LIMIT + 1,
    });
    const page = candidates.slice(0, MAX_BATCH_LIMIT);
    const results = [];
    for (const candidate of page) {
      const collectItemId = text(candidate?.collectItemId ?? candidate?.id);
      const taxonomyScope = text(candidate?.taxonomyScope) || TAXONOMY_SCOPE_OZON_DEFAULT;
      if (!collectItemId) continue;
      const current = await readForItem({ accountId, collectItemId, taxonomyScope });
      if (current?.status === "WAITING_STORE") {
        results.push(await service.scheduleForCollect({
          accountId,
          collectItemId,
          credentialStoreId: storeId,
          taxonomyScope,
        }));
      } else if (current?.status === "MATCHED") {
        results.push(await service.validateForStore({
          accountId,
          collectItemId,
          storeId,
          taxonomyScope,
        }));
      }
    }
    return {
      results,
      nextCursor: candidates.length > MAX_BATCH_LIMIT
        ? {
          collectItemId: text(page.at(-1)?.collectItemId ?? page.at(-1)?.id),
          taxonomyScope: text(page.at(-1)?.taxonomyScope) || TAXONOMY_SCOPE_OZON_DEFAULT,
        }
        : null,
    };
  }

  function scheduleStoreWakeContinuation(input, wakeKey, epoch) {
    let timer = null;
    const run = async () => {
      storeWakeTimers.delete(timer);
      if (epoch !== storeWakeEpoch) {
        activeStoreWakes.delete(wakeKey);
        return;
      }
      try {
        const page = await processStoreWakePage(input);
        if (epoch !== storeWakeEpoch) {
          activeStoreWakes.delete(wakeKey);
          return;
        }
        if (page.nextCursor) {
          scheduleStoreWakeContinuation({
            ...input,
            afterCollectItemId: page.nextCursor.collectItemId,
            afterTaxonomyScope: page.nextCursor.taxonomyScope,
          }, wakeKey, epoch);
        } else {
          activeStoreWakes.delete(wakeKey);
        }
      } catch (error) {
        activeStoreWakes.delete(wakeKey);
        log.error("collect category store wake continuation failed", {
          accountId: input.accountId,
          storeId: input.storeId,
          code: stableErrorCode(error),
        });
      }
    };
    timer = timers.setTimeout(run, 0);
    storeWakeTimers.add(timer);
    timer?.unref?.();
  }

  function onOperatingStoreAvailable(input = {}) {
    const accountId = text(input.accountId);
    const storeId = text(input.storeId);
    const wakeKey = `${accountId}:${storeId}`;
    if (activeStoreWakes.has(wakeKey)) return Promise.resolve([]);
    activeStoreWakes.add(wakeKey);
    const epoch = storeWakeEpoch;
    scheduleStoreWakeContinuation({ accountId, storeId }, wakeKey, epoch);
    return Promise.resolve([]);
  }

  async function readForItem(input = {}) {
    return repository.readForItem({
      accountId: input.accountId,
      collectItemId: input.collectItemId,
      taxonomyScope: text(input.taxonomyScope) || TAXONOMY_SCOPE_OZON_DEFAULT,
    });
  }

  function runtimeCandidateKey(candidate) {
    return crypto.createHash("sha256").update(JSON.stringify([
      text(candidate.accountId),
      candidate.kind === "RESOLVE" ? "0" : "1",
      text(candidate.collectItemId),
      text(candidate.taxonomyScope) || TAXONOMY_SCOPE_OZON_DEFAULT,
    ])).digest("hex");
  }

  function rotateCandidates(candidates, cursorKey, limit) {
    const ordered = candidates
      .map((candidate) => ({ ...candidate, cursorKey: runtimeCandidateKey(candidate) }))
      .sort((left, right) => (
        left.cursorKey < right.cursorKey ? -1 : left.cursorKey > right.cursorKey ? 1 : 0
      ));
    if (!ordered.length) return [];
    const after = ordered.filter((candidate) => candidate.cursorKey > cursorKey);
    const before = ordered.filter((candidate) => candidate.cursorKey <= cursorKey);
    return [...after, ...before].slice(0, limit);
  }

  async function readRuntimeCursor(workerKey) {
    if (persistenceMode() === "postgres") {
      const pool = await postgresPool();
      const result = await pool.query(
        `SELECT cursor_key
           FROM collect_category_resolution_runtime_cursors
          WHERE worker_key=$1`,
        [workerKey],
      );
      return text(result.rows[0]?.cursor_key);
    }
    return stateTransaction.run(async () => {
      const state = await loadState();
      return text(state?.collectCategoryResolutionRuntimeCursors?.[workerKey]);
    });
  }

  async function saveRuntimeCursor(workerKey, cursorKey) {
    if (persistenceMode() === "postgres") {
      const pool = await postgresPool();
      await pool.query(
        `INSERT INTO collect_category_resolution_runtime_cursors (worker_key,cursor_key,updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (worker_key) DO UPDATE
         SET cursor_key=EXCLUDED.cursor_key,updated_at=EXCLUDED.updated_at`,
        [workerKey, cursorKey],
      );
      return;
    }
    await stateTransaction.run(async () => {
      const state = await loadState();
      state.collectCategoryResolutionRuntimeCursors = (
        state.collectCategoryResolutionRuntimeCursors
        && typeof state.collectCategoryResolutionRuntimeCursors === "object"
      ) ? state.collectCategoryResolutionRuntimeCursors : {};
      state.collectCategoryResolutionRuntimeCursors[workerKey] = cursorKey;
      await saveState(state);
    });
  }

  async function listJsonRuntimeCandidates({ accountId, cursorKey, limit }) {
    return stateTransaction.run(async () => {
      const state = await loadState();
      const items = (Array.isArray(state?.caches?.collectBox) ? state.caches.collectBox : [])
        .filter((item) => (!accountId || text(item?.accountId) === accountId)
          && item?.deletedAt == null
          && text(item?.status).toUpperCase() !== "DELETED");
      const itemKeys = new Set(items.map((item) => `${text(item.accountId)}\u001f${text(item.id)}`));
      const resolutions = (Array.isArray(state?.collectCategoryResolutions)
        ? state.collectCategoryResolutions
        : []).filter((record) => (!accountId || text(record?.accountId) === accountId)
          && itemKeys.has(`${text(record?.accountId)}\u001f${text(record?.collectItemId)}`));
      const resolutionsByItem = new Map();
      for (const record of resolutions) {
        const itemKey = `${text(record.accountId)}\u001f${text(record.collectItemId)}`;
        const scopedRecords = resolutionsByItem.get(itemKey) || [];
        scopedRecords.push(record);
        resolutionsByItem.set(itemKey, scopedRecords);
      }
      const candidates = [];
      for (const item of items) {
        const scopedRecords = resolutionsByItem.get(
          `${text(item.accountId)}\u001f${text(item.id)}`,
        ) || [];
        if (!scopedRecords.some((record) => (
          (text(record.taxonomyScope) || TAXONOMY_SCOPE_OZON_DEFAULT)
            === TAXONOMY_SCOPE_OZON_DEFAULT
        ))) {
          candidates.push({
            kind: "RECONCILE",
            accountId: text(item.accountId),
            collectItemId: text(item.id),
            taxonomyScope: TAXONOMY_SCOPE_OZON_DEFAULT,
          });
        }
      }
      const nowMillis = now().getTime();
      for (const record of resolutions) {
        const status = text(record.status).toUpperCase();
        const candidate = {
          accountId: text(record.accountId),
          collectItemId: text(record.collectItemId),
          taxonomyScope: text(record.taxonomyScope) || TAXONOMY_SCOPE_OZON_DEFAULT,
        };
        if (["WAITING_ENRICHMENT", "WAITING_STORE", "MATCHED"].includes(status)) {
          candidates.push({ ...candidate, kind: "RECONCILE" });
        }
        const due = validInstantMillis(record.nextAttemptAt) <= nowMillis;
        const expiredLease = status === "MATCHING"
          && validInstantMillis(record.leaseExpiresAt) <= nowMillis;
        const validationRetry = status === "MATCHED"
          && text(record.failureDetailSafe) === "VALIDATION_RETRY_PENDING";
        if (due && (["QUEUED", "RETRYABLE_ERROR", "INVALIDATED"].includes(status)
          || expiredLease || validationRetry)) {
          candidates.push({ ...candidate, kind: "RESOLVE" });
        }
      }
      return rotateCandidates(candidates, cursorKey, limit).map((candidate) => structuredClone(candidate));
    });
  }

  async function listPostgresRuntimeCandidates({ accountId, cursorKey, limit }) {
    const pool = await postgresPool();
    const result = await pool.query(
      `WITH candidates AS (
         SELECT item.account_id,item.id AS collect_item_id,$2::TEXT AS taxonomy_scope,
                'RECONCILE'::TEXT AS kind
           FROM collect_items item
          WHERE ($1::TEXT IS NULL OR item.account_id=$1)
            AND item.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM collect_category_resolutions current
               WHERE current.account_id=item.account_id
                 AND current.collect_item_id=item.id
                 AND current.taxonomy_scope=$2
            )
         UNION ALL
         SELECT resolution.account_id,resolution.collect_item_id,resolution.taxonomy_scope,
                'RECONCILE'::TEXT AS kind
           FROM collect_category_resolutions resolution
           JOIN collect_items item
             ON item.account_id=resolution.account_id
            AND item.id=resolution.collect_item_id
          WHERE ($1::TEXT IS NULL OR resolution.account_id=$1)
            AND item.deleted_at IS NULL
            AND resolution.status IN ('WAITING_ENRICHMENT','WAITING_STORE','MATCHED')
         UNION ALL
         SELECT resolution.account_id,resolution.collect_item_id,resolution.taxonomy_scope,
                'RESOLVE'::TEXT AS kind
           FROM collect_category_resolutions resolution
           JOIN collect_items item
             ON item.account_id=resolution.account_id
            AND item.id=resolution.collect_item_id
          WHERE ($1::TEXT IS NULL OR resolution.account_id=$1)
            AND item.deleted_at IS NULL
            AND resolution.next_attempt_at<=$3
            AND (
              resolution.status IN ('QUEUED','RETRYABLE_ERROR','INVALIDATED')
              OR (resolution.status='MATCHING' AND resolution.lease_expires_at<=$3)
              OR (resolution.status='MATCHED'
                  AND resolution.failure_detail_safe='VALIDATION_RETRY_PENDING')
            )
       ), keyed AS (
         SELECT *,md5(concat_ws(E'\\x1f',account_id,
                         CASE WHEN kind='RESOLVE' THEN '0' ELSE '1' END,
                         collect_item_id,taxonomy_scope)) AS cursor_key
           FROM candidates
       )
       SELECT account_id,collect_item_id,taxonomy_scope,kind,cursor_key
         FROM keyed
       ORDER BY CASE WHEN cursor_key>$4 THEN 0 ELSE 1 END,cursor_key
       LIMIT $5`,
      [accountId || null, TAXONOMY_SCOPE_OZON_DEFAULT, now(), cursorKey, limit],
    );
    return result.rows.map((row) => ({
      kind: text(row.kind),
      accountId: text(row.account_id),
      collectItemId: text(row.collect_item_id ?? row.id),
      taxonomyScope: text(row.taxonomy_scope) || TAXONOMY_SCOPE_OZON_DEFAULT,
      cursorKey: text(row.cursor_key) || runtimeCandidateKey({
        kind: text(row.kind),
        accountId: text(row.account_id),
        collectItemId: text(row.collect_item_id ?? row.id),
        taxonomyScope: text(row.taxonomy_scope) || TAXONOMY_SCOPE_OZON_DEFAULT,
      }),
    }));
  }

  async function listRuntimeCandidates(input) {
    return persistenceMode() === "postgres"
      ? listPostgresRuntimeCandidates(input)
      : listJsonRuntimeCandidates(input);
  }

  async function drain(input = {}) {
    const limit = boundedLimit(input.limit);
    const requestedAccountId = text(input.accountId);
    const workerKey = requestedAccountId
      ? `account:${crypto.createHash("sha256").update(requestedAccountId).digest("hex")}`
      : "global";
    let scheduled = 0;
    let processed = 0;
    let attempted = 0;
    const errors = [];
    const cursorKey = await readRuntimeCursor(workerKey);
    const candidates = await listRuntimeCandidates({
      accountId: requestedAccountId,
      cursorKey,
      limit,
    });
    const storeIds = new Map();
    const storeIdForAccount = (accountId) => {
      if (!storeIds.has(accountId)) storeIds.set(accountId, backendCredentialStoreId(accountId));
      return storeIds.get(accountId);
    };
    for (const candidate of candidates) {
      attempted += 1;
      const { accountId, collectItemId, taxonomyScope } = candidate;
      try {
        if (candidate.kind === "RESOLVE") {
          const result = await service.resolveNext({ accountId, taxonomyScope });
          if (result) processed += 1;
        } else {
          const current = await readForItem({ accountId, collectItemId, taxonomyScope });
          if (!current) {
            await service.scheduleForCollect({
              accountId,
              collectItemId,
              credentialStoreId: await storeIdForAccount(accountId),
              taxonomyScope,
            });
            scheduled += 1;
          } else if (current.status === "WAITING_ENRICHMENT") {
            const result = await service.onEnrichmentComplete({
              accountId,
              collectItemId,
              credentialStoreId: await storeIdForAccount(accountId),
              taxonomyScope,
            });
            if (result?.status !== current.status) scheduled += 1;
          } else if (["WAITING_STORE", "MATCHED"].includes(current.status)) {
            const storeId = await storeIdForAccount(accountId);
            const storeContext = storeId
              ? await service.operatingStoreContext({ accountId, storeId })
              : null;
            if (current.status === "WAITING_STORE" && storeContext) {
              const result = await service.scheduleForCollect({
                accountId,
                collectItemId,
                credentialStoreId: storeContext.id,
                taxonomyScope,
              });
              if (result?.status !== "WAITING_STORE") scheduled += 1;
            } else if (current.status === "MATCHED" && storeContext) {
              const storeChanged = text(current.credentialStoreId) !== text(storeContext.id);
              const storeUpdatedAt = validInstantMillis(storeContext.updatedAt);
              const validatedAt = validInstantMillis(current.validatedAt);
              if (storeChanged || (storeUpdatedAt !== null
                && (validatedAt === null || validatedAt < storeUpdatedAt))) {
                await service.validateForStore({
                  accountId,
                  collectItemId,
                  storeId: storeContext.id,
                  taxonomyScope,
                });
                processed += 1;
              }
            }
          }
        }
      } catch (error) {
        const code = stableErrorCode(error);
        errors.push({ accountId, collectItemId, taxonomyScope, code });
        log.error("collect category runtime candidate failed", {
          accountId, collectItemId, taxonomyScope, code,
        });
      }
      try {
        await saveRuntimeCursor(workerKey, candidate.cursorKey);
      } catch (error) {
        const code = stableErrorCode(error);
        errors.push({ accountId, collectItemId, taxonomyScope, code });
        log.error("collect category runtime cursor failed", {
          accountId, collectItemId, taxonomyScope, code,
        });
        break;
      }
    }
    return { skipped: false, attempted, scheduled, processed, errors };
  }

  function resolveDue(input = {}) {
    if (drainPromise) {
      return Promise.resolve({ skipped: true, attempted: 0, scheduled: 0, processed: 0, errors: [] });
    }
    const current = drain(input).finally(() => {
      if (drainPromise === current) drainPromise = null;
    });
    drainPromise = current;
    return current;
  }

  function stop() {
    if (initialTimer) timers.clearTimeout(initialTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    for (const timer of storeWakeTimers) timers.clearTimeout(timer);
    initialTimer = null;
    intervalTimer = null;
    storeWakeTimers.clear();
    activeStoreWakes.clear();
    storeWakeEpoch += 1;
  }

  function start({
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = {}) {
    stop();
    const run = async () => {
      try {
        await resolveDue();
      } catch (error) {
        log.error("collect category resolution worker failed", {
          code: stableErrorCode(error),
        });
      }
    };
    initialTimer = timers.setTimeout(run, Math.max(0, Number(initialDelayMs) || 0));
    intervalTimer = timers.setInterval(run, Math.max(1, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    initialTimer?.unref?.();
    intervalTimer?.unref?.();
    return stop;
  }

  return Object.freeze({
    captureCredentialStoreSnapshot,
    scheduleForCollect,
    onEnrichmentComplete,
    onOperatingStoreAvailable,
    resolveDue,
    readForItem,
    start,
    stop,
  });
}
