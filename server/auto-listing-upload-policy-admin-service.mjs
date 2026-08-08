import crypto from "node:crypto";

import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const LIST_KEYS = new Set(["actor"]);
const PUBLISH_KEYS = new Set([
  "actor", "mode", "publicationReason", "idempotencyKey", "correlationId",
]);
const PUBLICATION_KEYS = new Set(["origin", "baseUrl", "prefix", "publicationVersion"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_VERSION = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,159}$/u;

function policyAdminError(code, status = 422, retryable = false) {
  const error = new Error("自动上架上传策略操作失败");
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function exact(raw, keys) {
  if (!plain(raw)) throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID", 400);
  const own = Reflect.ownKeys(raw);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
    throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID", 400);
  }
  return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
}

function identifier(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID", 400);
  return result;
}

function actorAccount(actor) {
  assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
  return identifier(actor?.id);
}

function publicationPolicy(raw) {
  const value = exact(raw, PUBLICATION_KEYS);
  let parsed;
  try { parsed = new URL(value.baseUrl); } catch {
    throw new TypeError("Auto-listing upload policy publication configuration is invalid");
  }
  const origin = typeof value.origin === "string" ? value.origin.trim() : "";
  const prefix = typeof value.prefix === "string" ? value.prefix.trim() : "";
  const version = typeof value.publicationVersion === "string" ? value.publicationVersion.trim() : "";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.pathname.endsWith("/") || parsed.origin !== origin || !SAFE_PREFIX.test(prefix)
    || prefix.includes("//") || prefix.endsWith("/") || !SAFE_VERSION.test(version)) {
    throw new TypeError("Auto-listing upload policy publication configuration is invalid");
  }
  return Object.freeze({ origin, baseUrl: parsed.href, prefix, publicationVersion: version });
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify({
    origin: value.origin,
    baseUrl: value.baseUrl,
    prefix: value.prefix,
    publicationVersion: value.publicationVersion,
  }), "utf8").digest("hex");
}

function reason(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || Buffer.byteLength(result, "utf8") > 500) {
    throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID", 400);
  }
  return result;
}

function rowDto(row, accountId) {
  if (!plain(row) || row.accountId !== accountId || !SAFE_ID.test(row.id || "")
    || !Number.isSafeInteger(row.version) || row.version < 1 || row.version > 2_147_483_647
    || !["REVIEW", "DIRECT"].includes(row.mode) || row.enabled !== true
    || !SAFE_ID.test(row.publishedBy || "") || !Number.isFinite(Date.parse(row.publishedAt || ""))
    || typeof row.publicationReason !== "string" || !row.publicationReason.trim()
    || typeof row.publicationOrigin !== "string" || typeof row.publicationBaseUrl !== "string"
    || typeof row.publicationPrefix !== "string" || !SAFE_VERSION.test(row.publicationVersion || "")
    || !/^[a-f0-9]{64}$/u.test(row.publicationPolicyHash || "")) {
    throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY", 500);
  }
  const dto = {
    id: row.id, accountId: row.accountId, version: row.version, mode: row.mode, enabled: true,
    publicationReason: row.publicationReason, publishedBy: row.publishedBy,
    publishedAt: new Date(row.publishedAt).toISOString(), publicationOrigin: row.publicationOrigin,
    publicationBaseUrl: row.publicationBaseUrl, publicationPrefix: row.publicationPrefix,
    publicationVersion: row.publicationVersion, publicationPolicyHash: row.publicationPolicyHash,
  };
  if (typeof row.duplicate === "boolean") dto.duplicate = row.duplicate;
  return Object.freeze(dto);
}

function healthDto(row, accountId) {
  if (!plain(row) || row.accountId !== accountId || !SAFE_ID.test(row.evidenceId || "")
    || !["PASSED", "FAILED"].includes(row.outcome)
    || !Number.isFinite(Date.parse(row.checkedAt || ""))
    || !Number.isFinite(Date.parse(row.expiresAt || ""))) {
    throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY", 500);
  }
  return Object.freeze({
    accountId, evidenceId: row.evidenceId, outcome: row.outcome,
    checkedAt: new Date(row.checkedAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(),
  });
}

export function createAutoListingUploadPolicyAdminService({
  repository, publicationPolicy: configuredPolicy, assertDirectReady, checkPublicationHealth,
} = {}) {
  if (typeof repository?.findPolicyReplay !== "function" || typeof repository?.listPolicies !== "function"
    || typeof repository?.publishPolicy !== "function" || typeof assertDirectReady !== "function"
    || typeof checkPublicationHealth !== "function") {
    throw new TypeError("Auto-listing upload policy admin dependencies are required");
  }
  const media = publicationPolicy(configuredPolicy);
  const mediaHash = canonicalHash(media);
  return Object.freeze({
    async listPolicies(raw = {}) {
      const input = exact(raw, LIST_KEYS);
      const accountId = actorAccount(input.actor);
      let rows;
      try { rows = await repository.listPolicies({ accountId }); } catch (error) {
        if (error?.code) throw error;
        throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_FAILED", 503, true);
      }
      if (!Array.isArray(rows) || rows.length > 1_000) {
        throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY", 500);
      }
      return Object.freeze(rows.map((row) => rowDto(row, accountId)));
    },

    async publishPolicy(raw = {}) {
      const input = exact(raw, PUBLISH_KEYS);
      const accountId = actorAccount(input.actor);
      if (!["REVIEW", "DIRECT"].includes(input.mode)) {
        throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_INVALID", 400);
      }
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      const publicationReason = reason(input.publicationReason);
      let replay;
      try {
        replay = await repository.findPolicyReplay({
          accountId, mode: input.mode, publicationReason, idempotencyKey,
        });
      } catch (error) {
        if (error?.code) throw error;
        throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_FAILED", 503, true);
      }
      if (replay) return rowDto(replay, accountId);
      let healthEvidenceId = null;
      if (input.mode === "DIRECT") {
        try {
          const ready = await assertDirectReady({ accountId });
          if (ready?.ready !== true || !SAFE_ID.test(ready.evidenceId || "")) throw new Error("not ready");
          healthEvidenceId = ready.evidenceId;
        } catch {
          throw policyAdminError("AUTO_LISTING_DIRECT_POLICY_NOT_READY", 503, true);
        }
      }
      let stored;
      try {
        stored = await repository.publishPolicy({
          accountId, actorId: accountId, mode: input.mode,
          publicationReason, idempotencyKey, correlationId,
          publicationOrigin: media.origin, publicationBaseUrl: media.baseUrl,
          publicationPrefix: media.prefix, publicationVersion: media.publicationVersion,
          publicationPolicyHash: mediaHash, healthEvidenceId,
        });
      } catch (error) {
        if (error?.code) throw error;
        throw policyAdminError("AUTO_LISTING_UPLOAD_POLICY_ADMIN_FAILED", 503, true);
      }
      return rowDto(stored, accountId);
    },

    async checkPublicationHealth(raw = {}) {
      const input = exact(raw, LIST_KEYS);
      const accountId = actorAccount(input.actor);
      try {
        return healthDto(await checkPublicationHealth({
          accountId, checkedByAccountId: accountId,
        }), accountId);
      } catch (error) {
        if (error?.code === "AUTO_LISTING_UPLOAD_POLICY_ADMIN_DATA_BOUNDARY") throw error;
        throw policyAdminError("AUTO_LISTING_PUBLICATION_HEALTH_CHECK_FAILED", 503, true);
      }
    },
  });
}
