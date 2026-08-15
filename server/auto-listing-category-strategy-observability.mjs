import crypto from "node:crypto";
import { types } from "node:util";

const METRICS = Object.freeze(new Set([
  "category_strategy_required_total",
  "category_strategy_sampling_started_total",
  "category_strategy_sample_set_committed_total",
  "category_strategy_analysis_attempt_total",
  "category_strategy_publish_total",
  "category_strategy_continue_create_total",
]));
const OUTCOME_METRICS = new Set([
  "category_strategy_analysis_attempt_total",
  "category_strategy_publish_total",
  "category_strategy_continue_create_total",
]);
const EVENT_KEYS = new Set([
  "metric", "accountId", "draftId", "sessionId", "attemptId", "strategyVersionId",
  "scope", "correlationId", "outcome", "startedAt",
]);
const SCOPE_KEYS = new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]);
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,240}$/u;
const SAFE_OUTCOME = /^[a-z][a-z0-9_:-]{0,79}$/u;

function invalid() {
  return Object.assign(new Error("AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_INVALID"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_INVALID",
  });
}

function closed(raw, expected) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expected.size || keys.some((key) => typeof key !== "string"
      || !expected.has(key) || descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_OBSERVABILITY_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SAFE_VALUE.test(value)) throw invalid();
  return value;
}

function safeScope(raw) {
  const scope = closed(raw, SCOPE_KEYS);
  if (scope.taxonomyScope !== "OZON:DEFAULT"
    || !Number.isSafeInteger(scope.descriptionCategoryId) || scope.descriptionCategoryId < 1
    || !Number.isSafeInteger(scope.typeId) || scope.typeId < 1) throw invalid();
  return Object.freeze({ ...scope });
}

function eventTime(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time < 0) throw invalid();
  return time;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

export function createCategoryStrategyObservability({ metrics = null, logger = null,
  now = () => Date.now(), accountHashSecret } = {}) {
  if (!(metrics === null || typeof metrics?.increment === "function")
    || !(logger === null || typeof logger?.info === "function")
    || typeof now !== "function" || typeof accountHashSecret !== "string"
    || accountHashSecret.length < 16 || accountHashSecret.length > 1_024) throw new TypeError();

  return Object.freeze({
    async observe(raw) {
      const input = closed(raw, EVENT_KEYS);
      if (!METRICS.has(input.metric) || typeof input.outcome !== "string"
        || !SAFE_OUTCOME.test(input.outcome)) throw invalid();
      const accountId = identifier(input.accountId, false);
      const currentTime = eventTime(now());
      const startedAt = eventTime(input.startedAt);
      const event = {
        metric: input.metric,
        accountHash: crypto.createHmac("sha256", accountHashSecret).update(accountId).digest("hex"),
        ...(input.draftId === null ? {} : { draftId: identifier(input.draftId) }),
        ...(input.sessionId === null ? {} : { sessionId: identifier(input.sessionId) }),
        ...(input.attemptId === null ? {} : { attemptId: identifier(input.attemptId) }),
        ...(input.strategyVersionId === null ? {} : { strategyVersionId: identifier(input.strategyVersionId) }),
        scope: safeScope(input.scope),
        correlationId: identifier(input.correlationId, false),
        outcome: input.outcome,
        durationMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(currentTime - startedAt))),
      };
      freeze(event);
      const labels = freeze(OUTCOME_METRICS.has(input.metric) ? { outcome: input.outcome } : {});
      try { await metrics?.increment?.(input.metric, labels); } catch {}
      try { await logger?.info?.(event); } catch {}
    },
  });
}
