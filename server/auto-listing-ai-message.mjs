import crypto from "node:crypto";
import { isIP } from "node:net";

export const AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION = "V1";
export const AUTO_LISTING_AI_MESSAGE_MAX_UTF8_BYTES = 2_048;
export const AUTO_LISTING_AI_PHASES = Object.freeze([
  "PLAN_CONTENT",
  "MATERIALIZE_SOURCE_ASSET",
  "FINALIZE_MATERIALIZED_PLAN",
  "GENERATE_IMAGE_SLOT",
  "GENERATE_RICH_CONTENT",
]);

const COMMON_KEYS = Object.freeze([
  "contractVersion",
  "accountId",
  "itemId",
  "phase",
  "expectedStatusVersion",
  "correlationId",
]);
const PHASE_KEY = Object.freeze({
  PLAN_CONTENT: null,
  MATERIALIZE_SOURCE_ASSET: "sourceAssetId",
  FINALIZE_MATERIALIZED_PLAN: null,
  GENERATE_IMAGE_SLOT: "slotKey",
  GENERATE_RICH_CONTENT: null,
});
const SAFE_IDENTIFIER = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;
const FORBIDDEN_VALUE = /(?:https?:|ftp:|file:|data:|www\.|@|(?:^|[._:-])(?:api[-_]?key|secret|password|passwd|bearer|authorization|cookie|credential|private[-_]?key|access[-_]?token|refresh[-_]?token)(?:$|[._:-]))/iu;
const DOMAIN_TOKEN = /(?:^|[^\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[\p{L}]{2,63})(?=$|[^\p{L}\p{N}-])/iu;
const RAW_CREDENTIAL_VALUE = /^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})$/iu;

function invalid() {
  const error = new Error("自动上架 AI 消息无效");
  error.code = "AUTO_LISTING_AI_MESSAGE_INVALID";
  error.retryable = false;
  return error;
}

function snapshotOwnData(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (ownKeys.some((key) => typeof key !== "string"
    || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  const snapshot = Object.create(null);
  for (const key of ownKeys) snapshot[key] = descriptors[key].value;
  return snapshot;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isSafeAutoListingAiIdentifier(value) {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 240
    && SAFE_IDENTIFIER.test(value)
    && !FORBIDDEN_VALUE.test(value)
    && !DOMAIN_TOKEN.test(value)
    && isIP(value) === 0
    && !RAW_CREDENTIAL_VALUE.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function identifier(value) {
  if (!isSafeAutoListingAiIdentifier(value)) throw invalid();
  return value;
}

function ordered(message) {
  return Object.fromEntries(Object.keys(message).sort().map((key) => [key, message[key]]));
}

export function normalizeAutoListingAiMessage(input) {
  try {
    const value = snapshotOwnData(input);
    const contractVersion = value.contractVersion;
    const phase = value.phase;
    if (contractVersion !== AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION || !Object.hasOwn(PHASE_KEY, phase)) throw invalid();
    const phaseKey = PHASE_KEY[phase];
    const keys = phaseKey ? [...COMMON_KEYS, phaseKey] : COMMON_KEYS;
    if (!exactKeys(value, keys)
      || !Number.isInteger(value.expectedStatusVersion)
      || value.expectedStatusVersion < 1
      || value.expectedStatusVersion > 2_147_483_647) {
      throw invalid();
    }

    const message = {
      contractVersion: value.contractVersion,
      accountId: identifier(value.accountId),
      itemId: identifier(value.itemId),
      phase: value.phase,
      expectedStatusVersion: value.expectedStatusVersion,
      correlationId: identifier(value.correlationId),
      ...(phaseKey ? { [phaseKey]: identifier(value[phaseKey]) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > AUTO_LISTING_AI_MESSAGE_MAX_UTF8_BYTES) {
      throw invalid();
    }
    return Object.freeze(message);
  } catch {
    throw invalid();
  }
}

export function canonicalizeAutoListingAiMessage(input) {
  return JSON.stringify(ordered(normalizeAutoListingAiMessage(input)));
}

export function autoListingAiMessageDedupeKey(input) {
  const businessIdentity = { ...normalizeAutoListingAiMessage(input) };
  delete businessIdentity.correlationId;
  return crypto.createHash("sha256")
    .update(JSON.stringify(ordered(businessIdentity)), "utf8")
    .digest("hex");
}
