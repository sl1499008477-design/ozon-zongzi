import crypto from "node:crypto";
import {
  autoListingAiMessageDedupeKey,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";

// V2 fences jobs that carry the category-strategy switch from workers which
// loaded the older frozen-config contract before that field existed.
export const AUTO_LISTING_AI_QUEUE = "auto-listing-ai-v2";

export const AUTO_LISTING_AI_QUEUE_OPTIONS = Object.freeze({
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 86_399,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
  heartbeatSeconds: 30,
  notify: true,
});
const MAX_BATCH_SIZE = 50;
const MAX_LEASE_MS = 5 * 60 * 1000;
const MAX_PUBLISH_TIMEOUT_MS = 60_000;
const MAX_INTERVAL_MS = 60_000;
const QUEUE_FACTORY_KEYS = new Set(["enabled", "bossFactory"]);
const PUBLISHER_FACTORY_KEYS = new Set([
  "enabled", "outboxRepository", "queueAdapter", "accountIds", "timers", "workerId",
  "batchSize", "leaseMs", "publishTimeoutMs", "intervalMs", "accountConcurrency", "logger",
]);

function queueError(code, retryable = false) {
  const error = new Error("自动上架 AI 队列操作失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function publicationId(singletonKey) {
  const value = crypto.createHash("sha256").update(`${AUTO_LISTING_AI_QUEUE}:${singletonKey}`, "utf8").digest("hex");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `5${value.slice(13, 16)}`,
    `${((Number.parseInt(value[16], 16) & 3) | 8).toString(16)}${value.slice(17, 20)}`,
    value.slice(20, 32),
  ].join("-");
}

function singletonConflict(error) {
  try {
    if (!error || typeof error !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (!descriptor || !("value" in descriptor)) return false;
    return descriptor.value === "PGBOSS_SINGLETON_ALREADY_EXISTS"
      || descriptor.value === "PG_BOSS_SINGLETON_ALREADY_EXISTS";
  } catch {
    return false;
  }
}

function validPublicationEvidence(value, singletonKey) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== "string" || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) return false;
    keys.sort();
    return keys.length === 3 && keys.join(",") === "duplicate,publicationId,singletonKey"
      && value.publicationId === publicationId(singletonKey)
      && value.singletonKey === singletonKey
      && typeof value.duplicate === "boolean";
  } catch {
    return false;
  }
}

function positiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function closedFactoryOptions(raw, allowed, code) {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("invalid");
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (!keys.includes("enabled") || keys.some((key) => typeof key !== "string" || !allowed.has(key)
      || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw new Error("invalid");
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch {
    throw queueError(code);
  }
}

function withTimeout(operation, timeoutMs, timers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(queueError("AUTO_LISTING_AI_QUEUE_PUBLISH_TIMEOUT", true));
    }, timeoutMs);
    Promise.resolve(operation).then((value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      reject(error);
    });
  });
}

export function createAutoListingAiQueueAdapter(rawOptions = {}) {
  const { enabled, bossFactory } = closedFactoryOptions(rawOptions, QUEUE_FACTORY_KEYS, "AUTO_LISTING_AI_QUEUE_INVALID");
  if (typeof enabled !== "boolean" || (enabled && typeof bossFactory !== "function")) {
    throw queueError("AUTO_LISTING_AI_QUEUE_INVALID");
  }
  let boss = null;
  let startPromise = null;

  async function start() {
    if (!enabled) return false;
    if (!startPromise) {
      startPromise = (async () => {
        let candidate = null;
        let started = false;
        try {
          candidate = await bossFactory();
          if (!candidate || typeof candidate.start !== "function" || typeof candidate.createQueue !== "function"
            || typeof candidate.send !== "function" || typeof candidate.stop !== "function") {
            throw new Error("invalid boss");
          }
          await candidate.start();
          started = true;
          await candidate.createQueue(AUTO_LISTING_AI_QUEUE, AUTO_LISTING_AI_QUEUE_OPTIONS);
          boss = candidate;
          return true;
        } catch {
          if (started) {
            try { await candidate.stop({ graceful: true, timeout: 30_000 }); } catch {}
          }
          boss = null;
          startPromise = null;
          throw queueError("AUTO_LISTING_AI_QUEUE_UNAVAILABLE", true);
        }
      })();
    }
    return startPromise;
  }

  return Object.freeze({
    start,
    async publish(input) {
      if (!enabled) throw queueError("AUTO_LISTING_AI_QUEUE_DISABLED");
      let message;
      let singletonKey;
      try {
        message = normalizeAutoListingAiMessage(input);
        singletonKey = autoListingAiMessageDedupeKey(message);
      } catch {
        throw queueError("AUTO_LISTING_AI_QUEUE_INVALID");
      }
      const id = publicationId(singletonKey);
      await start();
      let queueJobId;
      try {
        queueJobId = await boss.send(AUTO_LISTING_AI_QUEUE, message, { id, singletonKey });
      } catch (error) {
        if (!singletonConflict(error)) throw queueError("AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED", true);
        queueJobId = null;
      }
      if (!(queueJobId === null || queueJobId === id)) {
        throw queueError("AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED", true);
      }
      return Object.freeze({ publicationId: id, singletonKey, duplicate: queueJobId === null });
    },
    async stop() {
      if (!startPromise) return;
      let active;
      try { active = await startPromise; } catch { return; }
      if (!active || !boss) return;
      const current = boss;
      boss = null;
      startPromise = null;
      try { await current.stop({ graceful: true, timeout: 30_000 }); } catch {
        throw queueError("AUTO_LISTING_AI_QUEUE_UNAVAILABLE", true);
      }
    },
  });
}

export function createAutoListingAiOutboxPublisher(rawOptions = {}) {
  const options = closedFactoryOptions(rawOptions, PUBLISHER_FACTORY_KEYS, "AUTO_LISTING_AI_PUBLISHER_INVALID");
  const enabled = options.enabled;
  if (typeof enabled !== "boolean") throw queueError("AUTO_LISTING_AI_PUBLISHER_INVALID");
  if (!enabled) {
    return Object.freeze({
      async publishOnce() { return Object.freeze({ claimed: 0, published: 0, duplicates: 0, failed: 0 }); },
      async start() { return false; },
      async stop() {},
    });
  }
  const outboxRepository = options.outboxRepository;
  const queueAdapter = options.queueAdapter;
  const accountIds = options.accountIds;
  const timers = options.timers;
  const workerId = options.workerId ?? "auto-listing-ai-outbox-publisher-v1";
  const batchSize = options.batchSize ?? 20;
  // Claim one row per account visit. Claimed leases start together, so a
  // larger serial batch can expire behind a slow first publish even when each
  // row is renewed immediately before send.
  const perAccountClaimLimit = 1;
  const leaseMs = options.leaseMs ?? 30_000;
  const publishTimeoutMs = options.publishTimeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const accountConcurrency = options.accountConcurrency ?? 4;
  const logger = options.logger ?? Object.freeze({
    log(record) { console.log(JSON.stringify(record)); },
  });
  if (!outboxRepository || !queueAdapter
    || typeof accountIds !== "function" || !timers
    || typeof outboxRepository.claimAutoListingAiMessages !== "function"
    || typeof outboxRepository.renewAutoListingAiMessageLease !== "function"
    || typeof outboxRepository.completeAutoListingAiMessage !== "function"
    || typeof outboxRepository.failAutoListingAiMessage !== "function"
    || typeof queueAdapter.publish !== "function" || typeof queueAdapter.stop !== "function"
    || !["setTimeout", "clearTimeout", "setInterval", "clearInterval"].every((key) => typeof timers[key] === "function")
    || !isSafeAutoListingAiIdentifier(workerId)
    || !positiveInteger(batchSize, MAX_BATCH_SIZE)
    || !positiveInteger(leaseMs, MAX_LEASE_MS)
    || !positiveInteger(publishTimeoutMs, MAX_PUBLISH_TIMEOUT_MS)
    || !positiveInteger(intervalMs, MAX_INTERVAL_MS)
    || !positiveInteger(accountConcurrency, 16)
    || typeof logger?.log !== "function") {
    throw queueError("AUTO_LISTING_AI_PUBLISHER_INVALID");
  }

  let intervalTimer = null;
  let startPromise = null;
  let cyclePromise = null;
  function logFailure() {
    try {
      logger.log(Object.freeze({
        component: "AUTO_LISTING_AI_OUTBOX_RELAY",
        code: "AUTO_LISTING_AI_PUBLISHER_FAILED",
      }));
    } catch {}
  }

  async function publishAccounts(values) {
    if (!Array.isArray(values) || values.length > 100 || new Set(values).size !== values.length
      || values.some((accountId) => !isSafeAutoListingAiIdentifier(accountId))) {
      throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
    }
    const outcomes = new Array(values.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(accountConcurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const accountId = values[index];
        try {
          const result = await api.publishOnce({ accountId });
          outcomes[index] = Object.freeze({ accountId, status: "COMPLETED", ...result });
        } catch {
          outcomes[index] = Object.freeze({
            accountId,
            status: "FAILED",
            errorCode: "AUTO_LISTING_AI_PUBLISHER_FAILED",
          });
        }
      }
    });
    await Promise.all(runners);
    return Object.freeze(outcomes);
  }

  function runCycle({ scheduled = false } = {}) {
    if (cyclePromise) return cyclePromise;
    const cycle = (async () => {
      let values;
      try {
        values = await withTimeout(Promise.resolve().then(() => accountIds()), publishTimeoutMs, timers);
      } catch {
        throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
      }
      const outcomes = await publishAccounts(values);
      if (outcomes.some((outcome) => outcome.status === "FAILED")) logFailure();
      return outcomes;
    })();
    cyclePromise = cycle.finally(() => {
      if (cyclePromise === cyclePromiseWithCleanup) cyclePromise = null;
    });
    const cyclePromiseWithCleanup = cyclePromise;
    if (!scheduled) return cyclePromiseWithCleanup;
    return cyclePromiseWithCleanup.catch(() => {
      logFailure();
      return undefined;
    });
  }

  const api = {
    async publishOnce(input = {}) {
      if (!enabled) return Object.freeze({ claimed: 0, published: 0, duplicates: 0, failed: 0 });
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).length !== 1 || !Object.hasOwn(input, "accountId")
        || !isSafeAutoListingAiIdentifier(input.accountId)) {
        throw queueError("AUTO_LISTING_AI_PUBLISHER_INVALID");
      }
      let rows;
      try {
        rows = await withTimeout(outboxRepository.claimAutoListingAiMessages({
          accountId: input.accountId,
          workerId,
          limit: perAccountClaimLimit,
          leaseMs,
        }), publishTimeoutMs, timers);
      } catch {
        throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
      }
      if (!Array.isArray(rows) || rows.length > perAccountClaimLimit) throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
      let published = 0;
      let duplicates = 0;
      let failed = 0;
      for (const row of rows) {
        let message;
        try {
          message = normalizeAutoListingAiMessage(row?.message);
          if (row.status !== "PROCESSING" || row.accountId !== input.accountId || row.itemId !== message.itemId
            || row.dedupeKey !== autoListingAiMessageDedupeKey(message)
            || !isSafeAutoListingAiIdentifier(row.id) || !isSafeAutoListingAiIdentifier(row.leaseOwner)
            || !isSafeAutoListingAiIdentifier(row.leaseToken) || row.leaseOwner !== workerId) throw new Error("invalid claim");
        } catch {
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
        try {
          const renewed = await withTimeout(outboxRepository.renewAutoListingAiMessageLease({
            accountId: row.accountId,
            itemId: row.itemId,
            id: row.id,
            workerId: row.leaseOwner,
            leaseToken: row.leaseToken,
            leaseMs,
          }), publishTimeoutMs, timers);
          if (!renewed || renewed.status !== "PROCESSING"
            || renewed.accountId !== row.accountId || renewed.itemId !== row.itemId
            || renewed.id !== row.id || renewed.leaseOwner !== row.leaseOwner
            || renewed.leaseToken !== row.leaseToken) {
            throw new Error("invalid renewed lease");
          }
        } catch {
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
        let publication;
        try { publication = await withTimeout(queueAdapter.publish(message), publishTimeoutMs, timers); } catch {
          try {
            await withTimeout(outboxRepository.failAutoListingAiMessage({
              accountId: row.accountId,
              itemId: row.itemId,
              id: row.id,
              workerId: row.leaseOwner,
              leaseToken: row.leaseToken,
              errorCode: "AUTO_LISTING_AI_QUEUE_PUBLISH_FAILED",
            }), publishTimeoutMs, timers);
          } catch {
            throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
          }
          failed += 1;
          continue;
        }
        if (!validPublicationEvidence(publication, row.dedupeKey)) {
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
        try {
          await withTimeout(outboxRepository.completeAutoListingAiMessage({
            accountId: row.accountId,
            itemId: row.itemId,
            id: row.id,
            workerId: row.leaseOwner,
            leaseToken: row.leaseToken,
          }), publishTimeoutMs, timers);
        } catch {
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
        published += 1;
        if (publication.duplicate === true) duplicates += 1;
      }
      if (typeof outboxRepository.reconcileDeadAutoListingAiMessages === "function") {
        try {
          await withTimeout(outboxRepository.reconcileDeadAutoListingAiMessages({
            accountId: input.accountId,
            limit: batchSize,
          }), publishTimeoutMs, timers);
        } catch {
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
      }
      if (typeof outboxRepository.reconcileInterruptedAutoListingAiItems === "function") {
        try {
          await withTimeout(outboxRepository.reconcileInterruptedAutoListingAiItems({
            accountId: input.accountId,
            limit: batchSize,
          }), publishTimeoutMs, timers);
        } catch {
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
      }
      return Object.freeze({ claimed: rows.length, published, duplicates, failed });
    },
    async start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        try {
          if (typeof queueAdapter.start !== "function") throw new Error("queue start unavailable");
          await queueAdapter.start();
          await runCycle();
          const tick = () => runCycle({ scheduled: true });
          intervalTimer = timers.setInterval(tick, intervalMs);
          if (intervalTimer && typeof intervalTimer.unref === "function") intervalTimer.unref();
          return true;
        } catch {
          if (intervalTimer !== null) {
            try { timers.clearInterval(intervalTimer); } catch {}
            intervalTimer = null;
          }
          try { await queueAdapter.stop(); } catch {}
          logFailure();
          startPromise = null;
          throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
        }
      })();
      return startPromise;
    },
    async stop() {
      let failed = false;
      const activeStart = startPromise;
      if (activeStart) {
        try { await activeStart; } catch { failed = true; }
      }
      if (intervalTimer !== null) {
        timers.clearInterval(intervalTimer);
        intervalTimer = null;
      }
      if (cyclePromise) {
        try { await cyclePromise; } catch { failed = true; }
      }
      startPromise = null;
      try { await queueAdapter.stop(); } catch { failed = true; }
      if (failed) throw queueError("AUTO_LISTING_AI_PUBLISHER_FAILED", true);
    },
  };
  return Object.freeze(api);
}
