import crypto from "node:crypto";

const WORKER_KEYS = new Set([
  "accountPageSize", "enabled", "logger", "pollIntervalMs", "repository", "scheduler",
  "syncService", "timers", "workerId",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const CONCURRENCY = 2;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;

function workerError(code, retryable = false) {
  const error = new Error("AI 模型目录后台同步暂时不可用");
  error.code = code;
  error.status = retryable ? 503 : 422;
  error.retryable = retryable;
  return error;
}

function plainRecord(value) {
  try {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch { return false; }
}

function dataProperties(value, allowed, code) {
  if (!plainRecord(value)) throw workerError(code);
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw workerError(code); }
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
    throw workerError(code);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function id(value, code = "AUTO_LISTING_AI_MODEL_SYNC_WORKER_INVALID") {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_ID.test(value)) throw workerError(code);
  return value;
}

function positiveInteger(value, minimum, maximum, code = "AUTO_LISTING_AI_MODEL_SYNC_WORKER_INVALID") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw workerError(code);
  return value;
}

function ownValue(value, key) {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeCode(error, fallback = "AUTO_LISTING_AI_MODEL_SYNC_WORKER_FAILED") {
  const code = ownValue(error, "code");
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(code) ? code : fallback;
}

function timestampOrNull(value, code) {
  if (value === null) return null;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw workerError(code);
  return new Date(milliseconds).toISOString();
}

function hashId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 40);
  return `${prefix}_${digest}`;
}

function safeAccountPage(value, afterAccountId, limit) {
  if (!Array.isArray(value) || value.length > limit) {
    throw workerError("AUTO_LISTING_AI_MODEL_SYNC_WORKER_CURSOR_INVALID");
  }
  let cursor = afterAccountId ?? "";
  return value.map((raw) => {
    const accountId = id(raw, "AUTO_LISTING_AI_MODEL_SYNC_WORKER_CURSOR_INVALID");
    if (accountId <= cursor) throw workerError("AUTO_LISTING_AI_MODEL_SYNC_WORKER_CURSOR_INVALID");
    cursor = accountId;
    return accountId;
  });
}

function safeCandidatePage(value, afterAccountId, limit) {
  if (!Array.isArray(value) || value.length > limit) {
    throw workerError("AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_CURSOR_INVALID");
  }
  let cursor = afterAccountId ?? "";
  return value.map((raw) => {
    if (!plainRecord(raw)) throw workerError("AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID");
    const accountId = id(raw.accountId, "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID");
    if (accountId <= cursor) throw workerError("AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_CURSOR_INVALID");
    cursor = accountId;
    const latestCatalogId = raw.latestCatalogId === null
      ? null : id(raw.latestCatalogId, "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID");
    return {
      accountId,
      connectionId: id(raw.connectionId, "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID"),
      connectionVersion: positiveInteger(raw.connectionVersion, 1, 2_147_483_646,
        "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID"),
      connectionStatusVersion: positiveInteger(raw.connectionStatusVersion, 1, 2_147_483_646,
        "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID"),
      latestCatalogId,
      lastSyncedAt: timestampOrNull(raw.lastSyncedAt, "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_RESULT_INVALID"),
    };
  });
}

function safeLease(raw, accountId) {
  if (!plainRecord(raw) || raw.accountId !== accountId || raw.syncPurpose !== "CATALOG_SYNC"
    || typeof raw.reclaimed !== "boolean") throw workerError("AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID");
  const attemptCount = positiveInteger(raw.attemptCount, 1, MAX_ATTEMPTS,
    "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID");
  const maxAttempts = positiveInteger(raw.maxAttempts, 1, 20,
    "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID");
  if (attemptCount > maxAttempts) throw workerError("AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID");
  return {
    taskId: id(raw.taskId, "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    accountId,
    connectionId: id(raw.connectionId, "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    connectionVersion: positiveInteger(raw.connectionVersion, 1, 2_147_483_646,
      "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    syncPurpose: "CATALOG_SYNC",
    targetConnectionStatusVersion: positiveInteger(raw.targetConnectionStatusVersion, 1, 2_147_483_646,
      "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    attemptCount,
    maxAttempts,
    leaseVersion: positiveInteger(raw.leaseVersion, 1, 2_147_483_646,
      "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    leaseToken: id(raw.leaseToken, "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    leaseExpiresAt: timestampOrNull(raw.leaseExpiresAt, "AUTO_LISTING_AI_MODEL_SYNC_LEASE_INVALID"),
    reclaimed: raw.reclaimed,
  };
}

function createSummary() {
  return { scheduled: 0, claimed: 0, reclaimed: 0, succeeded: 0, failed: 0, dead: 0, errors: 0 };
}

function addSummary(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

export function createAutoListingAiModelSyncSchedulePostgres(rawOptions = {}) {
  const options = dataProperties(rawOptions, new Set(["pool"]), "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_INVALID");
  const pool = options.pool;
  if (typeof pool?.query !== "function") throw workerError("AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_INVALID");
  return Object.freeze({
    async listDueConnections(rawInput = {}) {
      const input = dataProperties(rawInput, new Set(["afterAccountId", "limit"]),
        "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_INVALID");
      const afterAccountId = input.afterAccountId === null
        ? "" : id(input.afterAccountId, "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_INVALID");
      const limit = positiveInteger(input.limit, 1, 1000, "AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_INVALID");
      let result;
      try {
        result = await pool.query(
          `SELECT c.account_id,c.id AS connection_id,c.version AS connection_version,
                  c.status_version AS connection_status_version,
                  latest.catalog_id AS latest_catalog_id,latest.synced_at AS last_synced_at
             FROM ai_gateway_connection_versions c
             LEFT JOIN LATERAL (
               SELECT catalog.id AS catalog_id,catalog.tested_at AS synced_at
                 FROM ai_gateway_model_catalogs catalog
                 JOIN ai_gateway_model_sync_tasks task
                   ON task.account_id=catalog.account_id AND task.id=catalog.sync_task_id
                  AND task.connection_id=catalog.connection_id
                  AND task.connection_version=catalog.connection_version
                WHERE catalog.account_id=c.account_id
                  AND catalog.connection_id=c.id AND catalog.connection_version=c.version
                  AND task.status='SUCCEEDED' AND task.sync_purpose='CATALOG_SYNC'
                ORDER BY catalog.tested_at DESC,catalog.id DESC
                LIMIT 1
             ) latest ON TRUE
            WHERE c.account_id > $1 AND c.status='ACTIVE'
              AND (latest.synced_at IS NULL OR latest.synced_at <= NOW() - INTERVAL '24 hours')
              AND NOT EXISTS (
                SELECT 1 FROM ai_gateway_model_sync_tasks runnable
                 WHERE runnable.account_id=c.account_id
                   AND runnable.connection_id=c.id AND runnable.connection_version=c.version
                   AND runnable.sync_purpose='CATALOG_SYNC'
                   AND runnable.status IN ('PENDING','LEASED','FAILED')
              )
            ORDER BY c.account_id
            LIMIT $2`,
          [afterAccountId, limit],
        );
      } catch {
        throw workerError("AUTO_LISTING_AI_MODEL_SYNC_SCHEDULE_DATABASE_FAILED", true);
      }
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      return safeCandidatePage(rows.map((row) => ({
        accountId: row.account_id,
        connectionId: row.connection_id,
        connectionVersion: Number(row.connection_version),
        connectionStatusVersion: Number(row.connection_status_version),
        latestCatalogId: row.latest_catalog_id ?? null,
        lastSyncedAt: row.last_synced_at ?? null,
      })), input.afterAccountId, limit);
    },
  });
}

export function createAutoListingAiModelSyncWorker(rawConfig = {}) {
  let enabled;
  try { enabled = ownValue(rawConfig, "enabled"); } catch { enabled = undefined; }
  if (enabled === false) {
    return Object.freeze({ async start() { return false; }, async stop() {}, async runOnce() { return false; } });
  }
  const config = dataProperties(rawConfig, WORKER_KEYS, "AUTO_LISTING_AI_MODEL_SYNC_WORKER_INVALID");
  const repository = config.repository;
  const scheduler = config.scheduler;
  const syncService = config.syncService;
  const workerId = id(config.workerId);
  const pollIntervalMs = positiveInteger(config.pollIntervalMs, 100, 300_000);
  const accountPageSize = positiveInteger(config.accountPageSize, 1, 1000);
  const logger = config.logger;
  const timers = config.timers;
  if (config.enabled !== true
    || !["listRunnableSyncAccountIds", "claimModelSync", "enqueueModelSync"]
      .every((key) => typeof repository?.[key] === "function")
    || typeof scheduler?.listDueConnections !== "function"
    || typeof syncService?.syncModelCatalog !== "function"
    || typeof logger?.log !== "function"
    || typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function") {
    throw workerError("AUTO_LISTING_AI_MODEL_SYNC_WORKER_INVALID");
  }

  let running = false;
  let timer = null;
  let inFlight = null;

  function log(code, taskId = null) {
    try {
      logger.log(Object.freeze({
        component: "AUTO_LISTING_AI_MODEL_SYNC_WORKER",
        workerId,
        taskId: typeof taskId === "string" && SAFE_ID.test(taskId) ? taskId : null,
        code,
      }));
    } catch {}
  }

  async function processAccount(accountId, summary) {
    let rawLease;
    try {
      rawLease = await repository.claimModelSync({
        accountId,
        workerId,
        leaseMs: LEASE_MS,
        syncPurpose: "CATALOG_SYNC",
      });
    } catch (error) {
      summary.errors += 1;
      log(safeCode(error));
      return;
    }
    if (!rawLease) return;
    let claimed;
    try { claimed = safeLease(rawLease, accountId); } catch (error) {
      summary.errors += 1;
      log(safeCode(error));
      return;
    }
    summary.claimed += 1;
    if (claimed.reclaimed) summary.reclaimed += 1;
    try {
      const result = await syncService.syncModelCatalog({
        accountId: claimed.accountId,
        connectionId: claimed.connectionId,
        connectionVersion: claimed.connectionVersion,
        syncPurpose: "CATALOG_SYNC",
        targetConnectionStatusVersion: claimed.targetConnectionStatusVersion,
        taskId: claimed.taskId,
        attemptCount: claimed.attemptCount,
        maxAttempts: claimed.maxAttempts,
        leaseVersion: claimed.leaseVersion,
        leaseToken: claimed.leaseToken,
        leaseExpiresAt: claimed.leaseExpiresAt,
        correlationId: `${claimed.taskId}:${claimed.leaseVersion}`,
      });
      if (!result || !["SUCCEEDED", "FAILED", "DEAD"].includes(result.status)) {
        throw workerError("AUTO_LISTING_AI_MODEL_SYNC_RESULT_INVALID");
      }
      summary[result.status === "SUCCEEDED" ? "succeeded" : result.status === "FAILED" ? "failed" : "dead"] += 1;
    } catch (error) {
      summary.errors += 1;
      log(safeCode(error), claimed.taskId);
    }
  }

  async function processRunnable(summary) {
    let afterAccountId = null;
    while (true) {
      const rawPage = await repository.listRunnableSyncAccountIds({
        afterAccountId,
        limit: accountPageSize,
        syncPurpose: "CATALOG_SYNC",
      });
      const page = safeAccountPage(rawPage, afterAccountId, accountPageSize);
      if (page.length === 0) return;
      for (let index = 0; index < page.length; index += CONCURRENCY) {
        await Promise.all(page.slice(index, index + CONCURRENCY)
          .map((accountId) => processAccount(accountId, summary)));
      }
      afterAccountId = page.at(-1);
    }
  }

  async function scheduleDaily(summary) {
    let afterAccountId = null;
    while (true) {
      const page = safeCandidatePage(await scheduler.listDueConnections({
        afterAccountId,
        limit: accountPageSize,
      }), afterAccountId, accountPageSize);
      if (page.length === 0) return;
      for (const due of page) {
        const sourceCatalog = due.latestCatalogId ?? "initial";
        const intentHashParts = [due.accountId, due.connectionId, due.connectionVersion,
          due.connectionStatusVersion, sourceCatalog];
        try {
          const task = await repository.enqueueModelSync({
            accountId: due.accountId,
            actorId: due.accountId,
            connectionId: due.connectionId,
            connectionVersion: due.connectionVersion,
            expectedConnectionStatusVersion: due.connectionStatusVersion,
            idempotencyKey: hashId("aigsyncdaily", ...intentHashParts),
            correlationId: hashId("aigsyncdailycorr", ...intentHashParts),
            maxAttempts: MAX_ATTEMPTS,
            syncPurpose: "CATALOG_SYNC",
          });
          if (task?.status === "PENDING" && task?.duplicate !== true) summary.scheduled += 1;
        } catch (error) {
          const code = safeCode(error);
          if (code !== "AUTO_LISTING_AI_SETTINGS_SYNC_ALREADY_RUNNABLE") {
            summary.errors += 1;
            log(code);
          }
        }
      }
      afterAccountId = page.at(-1).accountId;
      if (page.length < accountPageSize) return;
    }
  }

  async function executeOnce() {
    const summary = createSummary();
    const before = createSummary();
    await processRunnable(before);
    addSummary(summary, before);
    await scheduleDaily(summary);
    const after = createSummary();
    await processRunnable(after);
    addSummary(summary, after);
    return Object.freeze(summary);
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = executeOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(delayMs) {
    if (!running) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      try { await runOnce(); } catch (error) { log(safeCode(error)); }
      schedule(pollIntervalMs);
    }, delayMs);
  }

  return Object.freeze({
    async start() {
      if (running) return true;
      running = true;
      schedule(0);
      return true;
    },
    runOnce,
    async stop() {
      running = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight.catch(() => {});
    },
  });
}
