import crypto from "node:crypto";
import {
  autoListingAiMessageDedupeKey,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/;
const SENSITIVE_CODE_FRAGMENT = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTHORIZATION|BEARER|COOKIE|SESSION_?ID|PRIVATE_?KEY)/u;
const DEFAULT_BASE_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_ROWS = 10_000;
const MAX_MEMORY_ROWS = 100_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;
const MAX_CLAIM_LIMIT = 100;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const OPTION_KEYS = new Set(["now", "token", "baseRetryMs", "maxRetryMs", "maxAttempts", "maxRows"]);

function problem(code) {
  const error = new Error("自动上架 AI 发件箱操作无效");
  error.code = code;
  error.retryable = code === "AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED";
  return error;
}

function copy(value) {
  return structuredClone(value);
}

function snapshotOwnData(raw) {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
    const keys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.some((key) => typeof key !== "string"
      || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) {
      throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
    }
    const value = Object.create(null);
    for (const key of keys) value[key] = descriptors[key].value;
    return { keys, value };
  } catch {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
}

function sameKeys(actual, expected) {
  if (actual.length !== expected.length) return false;
  const wanted = new Set(expected);
  return actual.every((key) => wanted.has(key));
}

function closedInput(raw, allowedShapes) {
  const { keys, value } = snapshotOwnData(raw);
  if (!allowedShapes.some((shape) => sameKeys(keys, shape))) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return value;
}

function factoryOptions(raw) {
  const { keys, value } = snapshotOwnData(raw);
  if (keys.some((key) => !OPTION_KEYS.has(key))) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return value;
}

function identifier(value) {
  if (!isSafeAutoListingAiIdentifier(value)) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  return value;
}

function positiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return value;
}

function validErrorCode(value) {
  if (typeof value !== "string" || !ERROR_CODE.test(value) || SENSITIVE_CODE_FRAGMENT.test(value)) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }
  return value;
}

function retryDelay(attemptCount, { baseRetryMs, maxRetryMs }) {
  return Math.min(maxRetryMs, baseRetryMs * (2 ** Math.min(Math.max(attemptCount - 1, 0), 30)));
}

function compareRows(left, right) {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function boundedOrderedRows(rows, limit, predicate) {
  const selected = [];
  for (const row of rows.values()) {
    if (!predicate(row)) continue;
    let index = selected.findIndex((candidate) => compareRows(row, candidate) < 0);
    if (index < 0) index = selected.length;
    selected.splice(index, 0, row);
    if (selected.length > limit) selected.pop();
  }
  return selected;
}

export function createMemoryAutoListingAiOutboxRepository(rawOptions = {}) {
  const options = factoryOptions(rawOptions);
  const now = options.now ?? (() => Date.now());
  const token = options.token ?? (() => crypto.randomUUID());
  const baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (typeof now !== "function" || typeof token !== "function"
    || !Number.isSafeInteger(baseRetryMs) || baseRetryMs < 1
    || !Number.isSafeInteger(maxRetryMs) || maxRetryMs < baseRetryMs
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_MEMORY_ROWS) {
    throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
  }

  const rows = new Map();
  const timestamp = () => {
    let value;
    try {
      value = now();
    } catch {
      throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
    }
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
    }
    return milliseconds;
  };
  const addTime = (milliseconds, duration) => {
    const result = milliseconds + duration;
    if (!Number.isSafeInteger(result) || result < milliseconds) {
      throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
    }
    return result;
  };
  const prepare = (row) => Object.freeze({ ...row, message: Object.freeze(copy(row.message)) });
  const commit = (stored) => {
    rows.set(stored.dedupeKey, stored);
    return copy(stored);
  };
  const replace = (row) => commit(prepare(row));
  const listRequest = (raw) => {
    const input = closedInput(raw, [
      ["accountId"],
      ["accountId", "limit"],
      ["accountId", "limit", "afterId"],
    ]);
    return {
      accountId: identifier(input.accountId),
      limit: input.limit === undefined ? DEFAULT_LIST_LIMIT : positiveInteger(input.limit, MAX_LIST_LIMIT),
      afterId: input.afterId === undefined ? null : identifier(input.afterId),
    };
  };
  const claimRequest = (raw) => {
    const input = closedInput(raw, [["accountId", "workerId", "limit", "leaseMs"]]);
    return {
      accountId: identifier(input.accountId),
      workerId: identifier(input.workerId),
      limit: positiveInteger(input.limit, MAX_CLAIM_LIMIT),
      leaseMs: positiveInteger(input.leaseMs, MAX_LEASE_MS),
    };
  };
  const ownership = (raw, { requireLeaseMs = false, requireErrorCode = false } = {}) => {
    const required = ["accountId", "itemId", "id", "workerId", "leaseToken"];
    if (requireLeaseMs) required.push("leaseMs");
    if (requireErrorCode) required.push("errorCode");
    const input = closedInput(raw, [required]);
    return {
      accountId: identifier(input.accountId),
      itemId: identifier(input.itemId),
      id: identifier(input.id),
      workerId: identifier(input.workerId),
      leaseToken: identifier(input.leaseToken),
      leaseMs: requireLeaseMs ? positiveInteger(input.leaseMs, MAX_LEASE_MS) : null,
      errorCode: requireErrorCode ? validErrorCode(input.errorCode) : null,
    };
  };
  const owned = (value) => {
    const currentTime = timestamp();
    let row = null;
    for (const candidate of rows.values()) {
      if (candidate.accountId === value.accountId && candidate.itemId === value.itemId && candidate.id === value.id) {
        row = candidate;
        break;
      }
    }
    if (!row || row.status !== "PROCESSING" || row.leaseOwner !== value.workerId
      || row.leaseToken !== value.leaseToken || row.leaseExpiresAt <= currentTime) {
      throw problem("AUTO_LISTING_AI_OUTBOX_CLAIM_REJECTED");
    }
    return { row, currentTime };
  };
  const terminalRow = (row, currentTime, status, errorCode = row.lastErrorCode) => ({
    ...row,
    status,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: status === "COMPLETED" ? null : errorCode,
    nextAttemptAt: null,
    completedAt: status === "COMPLETED" ? currentTime : null,
    deadAt: status === "DEAD" ? currentTime : null,
    updatedAt: currentTime,
  });
  const terminal = (row, currentTime, status, errorCode = row.lastErrorCode) => replace(
    terminalRow(row, currentTime, status, errorCode),
  );

  return Object.freeze({
    async enqueueAutoListingAiMessage(input) {
      let message;
      let dedupeKey;
      try {
        message = normalizeAutoListingAiMessage(input);
        dedupeKey = autoListingAiMessageDedupeKey(message);
      } catch {
        throw problem("AUTO_LISTING_AI_MESSAGE_INVALID");
      }
      const existing = rows.get(dedupeKey);
      if (existing) return copy(existing);
      if (rows.size >= maxRows) throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      const currentTime = timestamp();
      return replace({
        id: `ai-outbox-${dedupeKey}`,
        dedupeKey,
        accountId: message.accountId,
        itemId: message.itemId,
        message,
        status: "PENDING",
        attemptCount: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        nextAttemptAt: currentTime,
        createdAt: currentTime,
        updatedAt: currentTime,
        completedAt: null,
        deadAt: null,
      });
    },

    async listAutoListingAiOutbox(raw) {
      const request = listRequest(raw);
      let cursor = null;
      if (request.afterId !== null) {
        for (const row of rows.values()) {
          if (row.accountId === request.accountId && row.id === request.afterId) {
            cursor = row;
            break;
          }
        }
        if (!cursor) throw problem("AUTO_LISTING_AI_OUTBOX_INVALID");
      }
      return boundedOrderedRows(rows, request.limit, (row) => row.accountId === request.accountId
        && (cursor === null || compareRows(row, cursor) > 0)).map(copy);
    },

    async claimAutoListingAiMessages(raw) {
      const request = claimRequest(raw);
      const currentTime = timestamp();
      const leaseExpiresAt = addTime(currentTime, request.leaseMs);
      const expiredAtLimit = [];
      for (const row of rows.values()) {
        if (row.accountId === request.accountId && row.status === "PROCESSING"
          && row.leaseExpiresAt <= currentTime && row.attemptCount >= maxAttempts) {
          expiredAtLimit.push(row);
        }
      }
      const candidates = boundedOrderedRows(rows, request.limit, (row) => row.accountId === request.accountId
        && row.attemptCount < maxAttempts
        && ((row.status === "PENDING" && row.nextAttemptAt <= currentTime)
          || (row.status === "PROCESSING" && row.leaseExpiresAt <= currentTime)));
      let preparedClaims;
      try {
        preparedClaims = candidates.map((row) => {
          const attemptCount = row.attemptCount + 1;
          const leaseToken = identifier(`${token()}:${attemptCount}`);
          return prepare({
            ...row,
            status: "PROCESSING",
            attemptCount,
            leaseOwner: request.workerId,
            leaseToken,
            leaseExpiresAt,
            updatedAt: currentTime,
          });
        });
      } catch {
        throw problem("AUTO_LISTING_AI_OUTBOX_REPOSITORY_FAILED");
      }
      const preparedDead = expiredAtLimit.map((row) => prepare(
        terminalRow(row, currentTime, "DEAD", "AUTO_LISTING_AI_LEASE_EXHAUSTED"),
      ));
      for (const stored of [...preparedDead, ...preparedClaims]) rows.set(stored.dedupeKey, stored);
      return preparedClaims.map(copy);
    },

    async renewAutoListingAiMessageLease(input) {
      const value = ownership(input, { requireLeaseMs: true });
      const { row, currentTime } = owned(value);
      return replace({ ...row, leaseExpiresAt: addTime(currentTime, value.leaseMs), updatedAt: currentTime });
    },

    async completeAutoListingAiMessage(input) {
      const value = ownership(input);
      const { row, currentTime } = owned(value);
      return terminal(row, currentTime, "COMPLETED");
    },

    async failAutoListingAiMessage(input) {
      const value = ownership(input, { requireErrorCode: true });
      const { row, currentTime } = owned(value);
      if (row.attemptCount >= maxAttempts) return terminal(row, currentTime, "DEAD", value.errorCode);
      return replace({
        ...row,
        status: "PENDING",
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: value.errorCode,
        nextAttemptAt: addTime(currentTime, retryDelay(row.attemptCount, { baseRetryMs, maxRetryMs })),
        updatedAt: currentTime,
      });
    },

    async deadLetterAutoListingAiMessage(input) {
      const value = ownership(input, { requireErrorCode: true });
      const { row, currentTime } = owned(value);
      return terminal(row, currentTime, "DEAD", value.errorCode);
    },
  });
}
