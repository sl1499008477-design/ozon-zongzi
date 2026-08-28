import {
  autoListingAiMessageDedupeKey,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";

export const AUTO_LISTING_AI_WORK_CONTRACT_VERSION = "CHANNEL_WORK_V1";

const WORK_KEYS = Object.freeze(["workContractVersion", "message", "execution"]);
const EXECUTION_KEYS = Object.freeze([
  "outboxId",
  "dispatchGeneration",
  "channelId",
  "connectionId",
  "connectionVersion",
  "leaseOwner",
  "leaseToken",
  "leaseExpiresAt",
]);
const MAX_VERSION = 2_147_483_647;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

function invalid() {
  const error = new Error("自动上架 AI 执行消息无效");
  error.code = "AUTO_LISTING_AI_WORK_MESSAGE_INVALID";
  error.retryable = false;
  return error;
}

function snapshotOwnData(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== "string"
    || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  const snapshot = Object.create(null);
  for (const key of keys) snapshot[key] = descriptors[key].value;
  return snapshot;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function identifier(value) {
  if (!isSafeAutoListingAiIdentifier(value)) throw invalid();
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) throw invalid();
  return value;
}

function normalizationTime(options) {
  if (options === undefined) return Date.now();
  const value = snapshotOwnData(options);
  if (!exactKeys(value, ["now"]) || !Number.isFinite(value.now)) throw invalid();
  return value.now;
}

export function normalizeAutoListingAiWorkMessage(input, options) {
  try {
    const now = normalizationTime(options);
    const value = snapshotOwnData(input);
    const execution = snapshotOwnData(value.execution);
    if (!exactKeys(value, WORK_KEYS)
      || !exactKeys(execution, EXECUTION_KEYS)
      || value.workContractVersion !== AUTO_LISTING_AI_WORK_CONTRACT_VERSION
      || typeof execution.leaseExpiresAt !== "string"
      || !ISO_TIMESTAMP.test(execution.leaseExpiresAt)) throw invalid();

    const leaseTimestamp = Date.parse(execution.leaseExpiresAt);
    if (!Number.isFinite(leaseTimestamp) || leaseTimestamp <= now) throw invalid();
    const message = normalizeAutoListingAiMessage(value.message);
    return Object.freeze({
      workContractVersion: AUTO_LISTING_AI_WORK_CONTRACT_VERSION,
      message,
      execution: Object.freeze({
        outboxId: identifier(execution.outboxId),
        dispatchGeneration: version(execution.dispatchGeneration),
        channelId: identifier(execution.channelId),
        connectionId: identifier(execution.connectionId),
        connectionVersion: version(execution.connectionVersion),
        leaseOwner: identifier(execution.leaseOwner),
        leaseToken: identifier(execution.leaseToken),
        leaseExpiresAt: new Date(leaseTimestamp).toISOString(),
      }),
    });
  } catch {
    throw invalid();
  }
}

export function autoListingAiWorkSingletonKey(input, options) {
  const work = normalizeAutoListingAiWorkMessage(input, options);
  return `${autoListingAiMessageDedupeKey(work.message)}:${work.execution.dispatchGeneration}`;
}
