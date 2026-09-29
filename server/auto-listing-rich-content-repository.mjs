import crypto from "node:crypto";

// Keep enough time after the five-minute provider idle timeout to persist the
// deterministic fallback (or the provider result) under the same fenced lease.
const DEFAULT_RICH_CONTENT_LEASE_MS = 360_000;
import { sha256, verifyPersistedAcceptedGeneratedAssetObjectKey } from "./auto-listing-asset-store.mjs";
import {
  buildRichContentAttemptInputHash,
  buildRichContentEvidenceIdentity,
  validateRichContentDocument,
} from "./auto-listing-rich-content.mjs";
import { isCompatibleAiModelIdentity } from "./auto-listing-ai-model-identity.mjs";

const HASH = /^[a-f0-9]{64}$/;
const CHANNEL_RELEASED = "AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED";
const SCOPE_KEYS = ["accountId", "jobId", "itemId", "planId"];
const VERSION = "AUTO_LISTING_RICH_CONTENT_V1";
const ASSET_ROLES = new Set(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const FACT_KEYS = new Set(["factId", "field", "kind", "value", "numericValue", "unit", "sourcePath"]);
const ASSET_KEYS = new Set([
  "assetId", "status", "accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "role",
  "attemptIdentityHash", "attemptNo", "inputHash", "generationSize", "contentHash", "objectKeyVersion", "objectKey",
  "contentType", "width", "height", "size", "gatewayRequestId", "checkerRequestId", "modelEvidence",
  "profileId", "profileVersion", "modelName", "planHash", "sourceHash", "strategyHash", "configHash",
  "visualGroupsHash", "promptTemplateVersion", "promptHash", "checkerEvidence", "sourceAssetEvidence", "regeneration",
]);
const SOURCE_ASSET_KEYS = new Set(["assetId", "contentHash", "contentType", "width", "height", "size"]);
const clean = (value, maxBytes = 240) => typeof value === "string" && value === value.trim() && value.length > 0
  && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" && !(value instanceof Date)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactObject = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
const scopeKey = (value) => SCOPE_KEYS.map((key) => value[key]).join("\u0001");

function attemptError(message = "富文本生成尝试无效") {
  const error = new Error(message);
  error.code = "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID";
  error.retryable = true;
  return error;
}

function repositoryError() {
  const error = new Error("富文本仓储暂时不可用");
  error.code = "AUTO_LISTING_RICH_CONTENT_REPOSITORY_FAILED";
  error.retryable = true;
  return error;
}

function validTimestamp(value) {
  return value instanceof Date || Number.isFinite(value)
    || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validModelEvidence(value, modelName, gatewayRequestId, inputHash) {
  if (!exactObject(value, new Set(["requestedTextModel", "gatewayReportedTextModel", "gatewayReportedTextModelPresent"]))
    || value.requestedTextModel !== modelName) return false;
  const fallbackRequestId = `auto-listing-rich-fallback-${inputHash}`;
  if (value.gatewayReportedTextModelPresent === false) {
    return value.gatewayReportedTextModel === "" && gatewayRequestId === fallbackRequestId;
  }
  return value.gatewayReportedTextModelPresent === true
    && gatewayRequestId !== fallbackRequestId
    && isCompatibleAiModelIdentity(modelName, value.gatewayReportedTextModel);
}

function validFactEvidence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return false;
  const ids = new Set();
  for (const fact of value) {
    if (!exactObject(fact, FACT_KEYS) || !clean(fact.factId) || ids.has(fact.factId)
      || !clean(fact.field, 512) || !clean(fact.kind, 120) || !clean(fact.value, 2048)
      || !clean(fact.sourcePath, 1024)
      || !((fact.numericValue === null && fact.unit === null)
        || (typeof fact.numericValue === "number" && Number.isFinite(fact.numericValue)
          && (fact.unit === null || clean(fact.unit, 64))))) return false;
    ids.add(fact.factId);
  }
  return true;
}

function validSourceAssetEvidence(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 7
    && value.length === new Set(value.map((entry) => entry?.assetId)).size
    && value.every((entry) => exactObject(entry, SOURCE_ASSET_KEYS) && clean(entry.assetId)
      && HASH.test(entry.contentHash || "") && ["image/png", "image/jpeg", "image/webp"].includes(entry.contentType)
      && Number.isInteger(entry.width) && entry.width > 0 && Number.isInteger(entry.height) && entry.height > 0
      && Number.isInteger(entry.size) && entry.size > 0);
}

function normalizedFactUnit(value) {
  if (value === null) return null;
  const unit = value.normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
  return ({ "мл": "ml", "л": "l", "см": "cm", "мм": "mm", "м": "m", "кг": "kg", "г": "g", "вт": "w" }[unit] || unit);
}

function derivedNumericProjection(value) {
  const normalized = value.normalize("NFKC").trim();
  const exact = normalized.match(/^(-?\d+(?:[.,]\d+)?)\s*([\p{L}%°]{1,16})$/u);
  const labelled = normalized.match(/(?:,\s*([\p{L}%°]{1,16})|\(\s*([\p{L}%°]{1,16})\s*\))\s*:\s*(-?\d+(?:[.,]\d+)?)\s*$/u);
  const number = exact?.[1] ?? labelled?.[3];
  const rawUnit = exact?.[2] ?? labelled?.[1] ?? labelled?.[2];
  if (!number || !rawUnit) return null;
  return {
    numericValue: Number(number.replace(",", ".")),
    unit: normalizedFactUnit(rawUnit),
  };
}

function sameNumericProjection(left, right) {
  if (left.numericValue === null && right.numericValue === null) return true;
  if (typeof left.numericValue === "number" && typeof right.numericValue === "number") {
    return left.numericValue === right.numericValue && normalizedFactUnit(left.unit) === normalizedFactUnit(right.unit);
  }
  const projected = derivedNumericProjection(left.value);
  const explicit = left.numericValue === null ? right : left;
  return projected !== null && explicit.numericValue === projected.numericValue
    && normalizedFactUnit(explicit.unit) === projected.unit;
}

function validImageModelEvidence(value, modelName) {
  const keys = new Set(["requestedImageModel", "gatewayReportedImageModel", "gatewayReportedImageModelPresent", "orchestratorModel"]);
  return exactObject(value, keys) && value.requestedImageModel === modelName
    && typeof value.gatewayReportedImageModel === "string" && typeof value.gatewayReportedImageModelPresent === "boolean"
    && typeof value.orchestratorModel === "string"
    && (value.gatewayReportedImageModelPresent
      ? isCompatibleAiModelIdentity(modelName, value.gatewayReportedImageModel)
      : value.gatewayReportedImageModel === "");
}

function validRegeneration(value) {
  return value === null || (exactObject(value, new Set(["requestId", "reason"]))
    && clean(value.requestId) && clean(value.reason));
}

function sameFactRegistry(left, right) {
  if (!validFactEvidence(left) || !validFactEvidence(right)) return false;
  const byId = new Map(left.map((fact) => [fact.factId, fact]));
  return right.every((fact) => {
    const expected = byId.get(fact.factId);
    return expected && ["field", "kind", "value", "sourcePath"].every((key) => expected[key] === fact[key])
      && sameNumericProjection(expected, fact);
  });
}

function validTask4CheckerEvidence(asset, facts, reservation) {
  const evidence = asset.checkerEvidence;
  const checkerFacts = evidence?.sourceFacts;
  if (!plainObject(evidence) || !plainObject(evidence.checkerResult)
    || typeof evidence.textRequired !== "boolean"
    || (evidence.textForbidden !== undefined && typeof evidence.textForbidden !== "boolean")
    || !(sameFactRegistry(facts, checkerFacts) || sameFactRegistry(checkerFacts, facts))
    || !Array.isArray(evidence.sourceFactIds)
    || evidence.sourceFactIds.length !== new Set(evidence.sourceFactIds).size
    || evidence.sourceFactIds.some((factId) => !clean(factId)
      || !checkerFacts.some((fact) => fact.factId === factId))
    || !validSourceAssetEvidence(evidence.sourceAssets)
    || evidence.generatedHash !== asset.contentHash
    || evidence.checkerModel !== reservation.modelName
    || evidence.profileId !== reservation.profileId
    || evidence.profileAccountId !== reservation.accountId
    || evidence.profileVersion !== reservation.profileVersion
    || evidence.templateVersion !== asset.promptTemplateVersion
    || evidence.requestId !== asset.checkerRequestId) return false;

  const checkerReferences = evidence.sourceAssets.length === asset.sourceAssetEvidence.length
    ? asset.sourceAssetEvidence : asset.sourceAssetEvidence.slice(0, 1);
  if (!same(evidence.sourceAssets, checkerReferences)) return false;

  const modelEvidence = evidence.checkerModelEvidence;
  if (!exactObject(modelEvidence, new Set([
    "requestedTextModel", "gatewayReportedTextModel", "gatewayReportedTextModelPresent",
  ])) || modelEvidence.requestedTextModel !== reservation.modelName
    || typeof modelEvidence.gatewayReportedTextModel !== "string"
    || typeof modelEvidence.gatewayReportedTextModelPresent !== "boolean"
    || (modelEvidence.gatewayReportedTextModelPresent
      ? !isCompatibleAiModelIdentity(reservation.modelName, modelEvidence.gatewayReportedTextModel)
      : modelEvidence.gatewayReportedTextModel !== "")) return false;

  const hasCategoryStyle = evidence.categoryStyleGuidance !== undefined
    || evidence.categoryStyleAssets !== undefined;
  return !hasCategoryStyle || (plainObject(evidence.categoryStyleGuidance)
    && Array.isArray(evidence.categoryStyleAssets)
    && evidence.categoryStyleAssets.length >= 1 && evidence.categoryStyleAssets.length <= 3);
}

function validAssetEvidence(value, reservation) {
  if (!Array.isArray(value) || value.length < 6 || value.length > 20) return false;
  const ids = new Set(); const slots = new Set(); let main = 0;
  for (const asset of value) {
    if (!exactObject(asset, ASSET_KEYS) || !clean(asset.assetId) || ids.has(asset.assetId)
      || !SCOPE_KEYS.every((key) => asset[key] === reservation[key])
      || !clean(asset.visualGroupKey) || !clean(asset.slotKey) || slots.has(`${asset.visualGroupKey}\u0001${asset.slotKey}`)
      || !ASSET_ROLES.has(asset.role) || asset.status !== "ACCEPTED"
      || !HASH.test(asset.attemptIdentityHash || "") || !Number.isInteger(asset.attemptNo) || asset.attemptNo < 1 || asset.attemptNo > 3
      || !HASH.test(asset.inputHash || "") || !/^[1-9][0-9]*x[1-9][0-9]*$/u.test(asset.generationSize || "")
      || !HASH.test(asset.contentHash || "") || !clean(asset.objectKey, 2048)
      || !verifyPersistedAcceptedGeneratedAssetObjectKey(asset)
      || asset.contentType !== "image/png" || !Number.isInteger(asset.width) || asset.width < 1
      || !Number.isInteger(asset.height) || asset.height < 1 || !Number.isInteger(asset.size) || asset.size < 1
      || !clean(asset.gatewayRequestId) || !clean(asset.checkerRequestId)
      || !validImageModelEvidence(asset.modelEvidence, asset.modelName)
      || asset.profileId !== reservation.profileId || asset.profileVersion !== reservation.profileVersion
      || !clean(asset.modelName) || asset.planHash !== reservation.planHash || asset.sourceHash !== reservation.sourceHash
      || ![asset.strategyHash, asset.configHash, asset.visualGroupsHash, asset.promptHash].every((entry) => HASH.test(entry || ""))
      || !clean(asset.promptTemplateVersion) || !validSourceAssetEvidence(asset.sourceAssetEvidence)
      || !validRegeneration(asset.regeneration) || !validTask4CheckerEvidence(asset, reservation.sourceFactEvidence, reservation)) return false;
    ids.add(asset.assetId); slots.add(`${asset.visualGroupKey}\u0001${asset.slotKey}`);
    if (asset.role === "MAIN") main += 1;
  }
  return main === 1;
}

function validateScope(input) {
  if (!input || !SCOPE_KEYS.every((key) => clean(input[key])) || !HASH.test(input.inputHash || "")) {
    throw attemptError();
  }
}

function validGatewayProvenance(input) {
  if (!Object.hasOwn(input, "gatewayConnectionId") && !Object.hasOwn(input, "gatewayConnectionVersion")) return true;
  return (input.gatewayConnectionId === null && input.gatewayConnectionVersion === null)
    || (clean(input.gatewayConnectionId) && Number.isInteger(input.gatewayConnectionVersion)
      && input.gatewayConnectionVersion >= 1 && input.gatewayConnectionVersion <= 2_147_483_647);
}

function validateReservation(input) {
  validateScope(input);
  for (const key of ["planHash", "sourceHash", "factRegistryHash", "assetHash", "promptHash"]) {
    if (!HASH.test(input[key] || "")) throw attemptError();
  }
  if (!Number.isInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1
    || input.expectedStatusVersion > 2_147_483_647
    || !clean(input.profileId) || !Number.isInteger(input.profileVersion) || input.profileVersion < 1
    || !clean(input.modelName) || !clean(input.promptTemplateVersion)
    || !validFactEvidence(input.sourceFactEvidence)
    || !validAssetEvidence(input.assetEvidence, input)
    || !exactObject(input.requestEvidence, new Set(["requestKey", "schemaVersion"]))
    || input.requestEvidence.requestKey !== `auto-listing-rich-${input.inputHash}` || input.requestEvidence.schemaVersion !== VERSION
    || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5
    || !validGatewayProvenance(input)) {
    throw attemptError();
  }
  let identity = null;
  try {
    identity = buildRichContentEvidenceIdentity({
      scope: Object.fromEntries(SCOPE_KEYS.map((key) => [key, input[key]])),
      planHash: input.planHash,
      sourceHash: input.sourceHash,
      sourceFactEvidence: input.sourceFactEvidence,
      assetEvidence: input.assetEvidence,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      modelName: input.modelName,
      promptTemplateVersion: input.promptTemplateVersion,
    });
  } catch {}
  let expectedInputHash = null;
  try {
    expectedInputHash = identity
      ? buildRichContentAttemptInputHash(identity.inputHash, input.expectedStatusVersion)
      : null;
  } catch {}
  if (!identity || input.factRegistryHash !== identity.factRegistryHash || input.assetHash !== identity.assetHash
    || input.promptHash !== identity.promptHash || input.inputHash !== expectedInputHash
  ) {
    throw attemptError();
  }
}

function validPersistenceContract(input) {
  try { validateReservation(input); } catch { return false; }
  if (!plainObject(input) || !validModelEvidence(input.modelEvidence, input.modelName, input.gatewayRequestId, input.inputHash)
    || !clean(input.gatewayRequestId) || !HASH.test(input.outputHash || "")
    || input.outputHash !== sha256(input.richContent)) return false;
  const checked = validateRichContentDocument({
    richContent: input.richContent,
    factRegistry: input.sourceFactEvidence,
    acceptedAssets: input.assetEvidence,
    scope: Object.fromEntries(SCOPE_KEYS.map((key) => [key, input[key]])),
  });
  return checked.valid && same(checked.checkerResult, input.checkerResult);
}

function matchingScope(left, right) {
  return scopeKey(left) === scopeKey(right) && left.inputHash === right.inputHash
    && left.expectedStatusVersion === right.expectedStatusVersion;
}

function mapRow(row) {
  if (!row) return null;
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    mapped[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return mapped;
}

function verifyTerminalEcho(record, input, status) {
  if (!record || record.status !== status || SCOPE_KEYS.some((key) => record[key] !== input[key])
    || record.inputHash !== input.inputHash || record.attemptNo !== input.attemptNo
    || !clean(record.id) || record.leaseOwner !== null || record.leaseToken !== null || record.leaseExpiresAt !== null) return false;
  for (const key of ["planHash", "sourceHash", "factRegistryHash", "assetHash", "promptHash",
    "profileId", "profileVersion", "modelName", "promptTemplateVersion"]) {
    if (record[key] !== input[key]) return false;
  }
  if (!["sourceFactEvidence", "assetEvidence", "requestEvidence"].every((key) => same(record[key], input[key]))) return false;
  return status === "ACCEPTED"
    ? validTimestamp(record.acceptedAt) && record.errorCode === null && record.errorRetryable === null
      && record.outputHash === input.outputHash && record.gatewayRequestId === input.gatewayRequestId
      && same(record.richContent, input.richContent) && same(record.checkerResult, input.checkerResult)
      && same(record.modelEvidence, input.modelEvidence)
    : record.acceptedAt == null && record.errorCode === input.errorCode && record.errorRetryable === input.errorRetryable;
}

/** In-memory reference implementation of the durable fenced attempt port. */
export function createMemoryRichContentRepository({
  now = () => Date.now(),
  leaseMs = DEFAULT_RICH_CONTENT_LEASE_MS,
  token = () => crypto.randomUUID(),
} = {}) {
  if (typeof now !== "function" || typeof token !== "function" || !Number.isInteger(leaseMs) || leaseMs < 1) {
    throw attemptError();
  }
  const rows = [];

  const owned = (input) => {
    validateScope(input);
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || !clean(input.leaseToken)) throw attemptError();
    const row = rows.find((candidate) => matchingScope(candidate, input)
      && candidate.attemptNo === input.attemptNo);
    if (!row || row.status !== "GENERATING" || row.leaseToken !== input.leaseToken
      || row.leaseExpiresAt <= now()) throw attemptError();
    for (const key of ["planHash", "sourceHash", "factRegistryHash", "assetHash", "promptHash",
      "profileId", "profileVersion", "modelName", "promptTemplateVersion"]) {
      if (input[key] !== undefined && input[key] !== row[key]) throw attemptError();
    }
    for (const key of ["sourceFactEvidence", "assetEvidence", "requestEvidence"]) {
      if (input[key] !== undefined && !same(input[key], row[key])) throw attemptError();
    }
    if ((row.gatewayConnectionId ?? null) !== (input.gatewayConnectionId ?? null)
      || (row.gatewayConnectionVersion ?? null) !== (input.gatewayConnectionVersion ?? null)) throw attemptError();
    return row;
  };

  const terminalize = (input, status) => {
    validateReservation(input);
    const row = owned(input);
    Object.assign(row, status === "ACCEPTED" ? clone({
      richContent: input.richContent,
      outputHash: input.outputHash,
      checkerResult: input.checkerResult,
      gatewayRequestId: input.gatewayRequestId,
      modelEvidence: input.modelEvidence,
      usage: input.usage ?? null,
    }) : clone({ errorCode: input.errorCode, errorRetryable: input.errorRetryable }), {
      status,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now(),
      ...(status === "ACCEPTED" ? { acceptedAt: now() } : {}),
    });
    return clone(row);
  };

  const repository = {
    async reserveRichContentAttempt(input) {
      validateReservation(input);
      const related = rows.filter((row) => matchingScope(row, input));
      const accepted = related.find((row) => row.status === "ACCEPTED");
      if (accepted) return { status: "EXISTING_ACCEPTED", record: clone(accepted) };
      if (related.some((row) => row.status === "REJECTED")) {
        return { status: "REJECTED", code: "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED" };
      }
      const timestamp = now();
      const active = related.find((row) => row.status === "GENERATING" && row.leaseExpiresAt > timestamp);
      if (active) return { status: "IN_PROGRESS" };
      for (const row of related) {
        if (row.status === "GENERATING" && row.leaseExpiresAt <= timestamp
          && row.leaseOwner !== CHANNEL_RELEASED) {
          Object.assign(row, {
            status: "FAILED", errorCode: "LEASE_EXPIRED", errorRetryable: true,
            leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: timestamp,
          });
        }
      }
      const reclaimable = related.filter((row) => row.status === "GENERATING"
        && row.leaseExpiresAt <= timestamp
        && row.leaseOwner === CHANNEL_RELEASED);
      if (reclaimable.length > 1) throw attemptError();
      if (reclaimable.length === 1) {
        const leaseToken = token();
        if (!clean(leaseToken)) throw attemptError();
        const leaseOwner = clean(input.leaseOwner) ? input.leaseOwner : "rich-content-generator";
        Object.assign(reclaimable[0], {
          status: "GENERATING", errorCode: null, errorRetryable: null,
          leaseOwner, leaseToken, leaseExpiresAt: timestamp + leaseMs, updatedAt: timestamp,
          gatewayConnectionId: input.gatewayConnectionId ?? null,
          gatewayConnectionVersion: input.gatewayConnectionVersion ?? null,
        });
        return {
          status: "RESERVED", attemptNo: reclaimable[0].attemptNo, leaseToken,
          inputHash: input.inputHash, promptHash: input.promptHash,
        };
      }
      const attemptNo = related.reduce((highest, row) => Math.max(highest, row.attemptNo), 0) + 1;
      if (attemptNo > input.maxAttempts) return { status: "ATTEMPTS_EXHAUSTED" };
      const leaseToken = token();
      if (!clean(leaseToken)) throw attemptError();
      const leaseOwner = clean(input.leaseOwner) ? input.leaseOwner : "rich-content-generator";
      rows.push({
        id: crypto.randomUUID(), ...clone(input), attemptNo, status: "GENERATING",
        richContent: {}, outputHash: "", checkerResult: {}, gatewayRequestId: null,
        modelEvidence: null, errorCode: null, errorRetryable: null,
        leaseOwner, leaseToken, leaseExpiresAt: timestamp + leaseMs,
        createdAt: timestamp, updatedAt: timestamp, acceptedAt: null,
      });
      return { status: "RESERVED", attemptNo, leaseToken, inputHash: input.inputHash, promptHash: input.promptHash };
    },
    async completeRichContentAttempt(input) {
      if (!validPersistenceContract(input)) {
        throw attemptError();
      }
      const record = terminalize(input, "ACCEPTED");
      if (!verifyTerminalEcho(record, input, "ACCEPTED")) throw attemptError();
      return record;
    },
    async rejectRichContentAttempt(input) {
      if (!clean(input?.errorCode) || input.errorRetryable !== false) throw attemptError();
      return terminalize(input, "REJECTED");
    },
    async failRichContentAttempt(input) {
      if (!clean(input?.errorCode) || typeof input.errorRetryable !== "boolean") throw attemptError();
      return terminalize(input, "FAILED");
    },
    async releaseRichContentAttempt(input) {
      if (input?.errorCode !== CHANNEL_RELEASED) throw attemptError();
      validateReservation(input);
      const row = owned(input);
      Object.assign(row, {
        leaseOwner: CHANNEL_RELEASED, errorCode: null, errorRetryable: null,
        leaseExpiresAt: now(), updatedAt: now(),
      });
      return clone(row);
    },
    snapshot() { return clone(rows); },
  };
  repository.reserveRichContent = repository.reserveRichContentAttempt;
  repository.completeRichContent = repository.completeRichContentAttempt;
  repository.rejectRichContent = repository.rejectRichContentAttempt;
  repository.failRichContent = repository.failRichContentAttempt;
  repository.releaseRichContent = repository.releaseRichContentAttempt;
  return Object.freeze(repository);
}

/** PostgreSQL implementation; all transitions use the complete tenant/input/attempt/lease fence. */
export function createPostgresRichContentRepository({
  pool,
  leaseMs = DEFAULT_RICH_CONTENT_LEASE_MS,
  token = () => crypto.randomUUID(),
  id = () => crypto.randomUUID(),
  leaseOwner = "rich-content-generator",
} = {}) {
  if (!pool || typeof pool.query !== "function" || !Number.isInteger(leaseMs) || leaseMs < 1
    || typeof token !== "function" || typeof id !== "function" || !clean(leaseOwner)) throw attemptError();

  async function reserveRichContentAttempt(input) {
    validateReservation(input);
    const leaseToken = token();
    const rowId = id();
    if (![leaseToken, rowId].every((value) => clean(value))) throw attemptError();
    const values = SCOPE_KEYS.map((key) => input[key]);
    let client = null;
    try {
      client = typeof pool.connect === "function" ? await pool.connect() : pool;
      await client.query("BEGIN");
      const boundary = await client.query(
        `SELECT id FROM auto_listing_job_items
         WHERE account_id=$1 AND job_id=$2 AND id=$3
           AND status='GENERATING' AND status_version=$4 AND active_content_plan_id=$5
         FOR UPDATE`,
        [...values.slice(0, 3), input.expectedStatusVersion, input.planId],
      );
      if (boundary.rowCount !== 1) throw attemptError();
      await client.query(
        `UPDATE ai_rich_content_results
         SET status='FAILED',error_code='LEASE_EXPIRED',error_retryable=TRUE,
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
           AND status='GENERATING' AND lease_expires_at <= NOW()
           AND lease_owner <> 'AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED'`,
        [...values, input.inputHash],
      );
      const accepted = await client.query(
        `SELECT * FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5 AND status='ACCEPTED'
         LIMIT 1 FOR SHARE`,
        [...values, input.inputHash],
      );
      if (accepted.rows[0]) {
        await client.query("COMMIT");
        return { status: "EXISTING_ACCEPTED", record: mapRow(accepted.rows[0]) };
      }
      const rejected = await client.query(
        `SELECT 1 FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
           AND status='REJECTED' LIMIT 1 FOR SHARE`,
        [...values, input.inputHash],
      );
      if (rejected.rows[0]) {
        await client.query("COMMIT");
        return { status: "REJECTED", code: "AUTO_LISTING_RICH_CONTENT_POLICY_REJECTED" };
      }
      const active = await client.query(
        `SELECT 1 FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
           AND status='GENERATING' AND lease_expires_at > NOW() LIMIT 1 FOR SHARE`,
        [...values, input.inputHash],
      );
      if (active.rows[0]) {
        await client.query("COMMIT");
        return { status: "IN_PROGRESS" };
      }
      const reclaimable = await client.query(
        `SELECT * FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5
           AND status='GENERATING' AND lease_expires_at <= NOW()
           AND lease_owner='AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED'
         FOR UPDATE`,
        [...values, input.inputHash],
      );
      if (reclaimable.rowCount > 1) throw attemptError();
      if (reclaimable.rowCount === 1) {
        const reclaimed = await client.query(
          `UPDATE ai_rich_content_results
           SET status='GENERATING',error_code=NULL,error_retryable=NULL,
               lease_owner=$2,lease_token=$3,lease_expires_at=NOW()+($4 * INTERVAL '1 millisecond'),
               gateway_connection_id=$5,gateway_connection_version=$6,updated_at=NOW()
           WHERE id=$1 AND status='GENERATING' AND lease_expires_at <= NOW()
             AND lease_owner='AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED'
           RETURNING *`,
          [reclaimable.rows[0].id, leaseOwner, leaseToken, leaseMs,
            input.gatewayConnectionId ?? null, input.gatewayConnectionVersion ?? null],
        );
        const record = mapRow(reclaimed.rows[0]);
        if (reclaimed.rowCount !== 1 || record?.status !== "GENERATING"
          || record.inputHash !== input.inputHash || record.attemptNo !== reclaimable.rows[0].attempt_no
          || record.leaseToken !== leaseToken) throw attemptError();
        await client.query("COMMIT");
        return {
          status: "RESERVED", attemptNo: record.attemptNo, leaseToken,
          inputHash: input.inputHash, promptHash: input.promptHash,
        };
      }
      const attempts = await client.query(
        `SELECT COALESCE(MAX(attempt_no),0)::INTEGER AS attempt_no FROM ai_rich_content_results
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND plan_id=$4 AND input_hash=$5`,
        [...values, input.inputHash],
      );
      const attemptNo = Number(attempts.rows[0]?.attempt_no || 0) + 1;
      if (attemptNo > input.maxAttempts) {
        await client.query("COMMIT");
        return { status: "ATTEMPTS_EXHAUSTED" };
      }
      await client.query(
        `INSERT INTO ai_rich_content_results (
           id,account_id,job_id,item_id,plan_id,profile_id,source_hash,asset_hash,input_hash,attempt_no,
           model_name,profile_version,prompt_template_version,rich_content,output_hash,checker_result,status,
           plan_hash,fact_registry_hash,prompt_hash,request_evidence,model_evidence,source_fact_evidence,
           asset_evidence,gateway_request_id,lease_owner,lease_token,lease_expires_at,
           gateway_connection_id,gateway_connection_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}'::JSONB,'','{}'::JSONB,'GENERATING',
           $14,$15,$16,$17::JSONB,NULL,$18::JSONB,$19::JSONB,NULL,$20,$21,NOW()+($22 * INTERVAL '1 millisecond'),$23,$24)`,
        [rowId, ...values, input.profileId, input.sourceHash, input.assetHash, input.inputHash, attemptNo,
          input.modelName, input.profileVersion, input.promptTemplateVersion, input.planHash,
          input.factRegistryHash, input.promptHash, JSON.stringify(input.requestEvidence),
          JSON.stringify(input.sourceFactEvidence), JSON.stringify(input.assetEvidence), leaseOwner, leaseToken, leaseMs,
          input.gatewayConnectionId ?? null, input.gatewayConnectionVersion ?? null],
      );
      await client.query("COMMIT");
      return { status: "RESERVED", attemptNo, leaseToken, inputHash: input.inputHash, promptHash: input.promptHash };
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      if (error?.code === "AUTO_LISTING_RICH_CONTENT_ATTEMPT_INVALID") throw error;
      throw repositoryError();
    } finally {
      if (client && client !== pool) {
        try { await client.release(); } catch { throw repositoryError(); }
      }
    }
  }

  async function transition(input, status) {
    validateReservation(input);
    if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || !clean(input.leaseToken)) throw attemptError();
    const accepted = status === "ACCEPTED";
    if (accepted) {
      if (!validPersistenceContract(input)) throw attemptError();
    } else if (!clean(input.errorCode) || typeof input.errorRetryable !== "boolean"
      || (status === "REJECTED" && input.errorRetryable !== false)) throw attemptError();
    let result;
    try {
      result = await pool.query(
      `WITH current_item AS (
         SELECT item.account_id,item.job_id,item.id,item.active_content_plan_id
         FROM auto_listing_job_items AS item
         WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
           AND item.status='GENERATING' AND item.status_version=$31 AND item.active_content_plan_id=$4
         FOR UPDATE
       )
       UPDATE ai_rich_content_results AS attempt SET
         status=$7,rich_content=$8::JSONB,output_hash=$9,checker_result=$10::JSONB,
         gateway_request_id=$11,model_evidence=$12::JSONB,error_code=$13,error_retryable=$14,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW(),accepted_at=$15
       FROM current_item AS item
       WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3
         AND attempt.plan_id=$4 AND attempt.input_hash=$5 AND attempt.attempt_no=$6
         AND attempt.status='GENERATING' AND attempt.lease_token=$16 AND attempt.lease_expires_at > NOW()
         AND attempt.plan_hash=$17 AND attempt.source_hash=$18 AND attempt.fact_registry_hash=$19
         AND attempt.asset_hash=$20 AND attempt.prompt_hash=$21 AND attempt.profile_id=$22
         AND attempt.profile_version=$23 AND attempt.model_name=$24 AND attempt.prompt_template_version=$25
         AND attempt.source_fact_evidence=$26::JSONB AND attempt.asset_evidence=$27::JSONB
         AND attempt.request_evidence=$28::JSONB
         AND attempt.gateway_connection_id IS NOT DISTINCT FROM $29
         AND attempt.gateway_connection_version IS NOT DISTINCT FROM $30
         AND item.account_id=$1 AND item.job_id=$2 AND item.id=$3 AND item.active_content_plan_id=$4
       RETURNING attempt.*`,
      [...SCOPE_KEYS.map((key) => input[key]), input.inputHash, input.attemptNo, status,
        JSON.stringify(accepted ? input.richContent : {}), accepted ? input.outputHash : "",
        JSON.stringify(accepted ? input.checkerResult : {}), accepted ? input.gatewayRequestId : null,
        accepted ? JSON.stringify(input.modelEvidence) : null, accepted ? null : input.errorCode,
        accepted ? null : input.errorRetryable, accepted ? new Date() : null, input.leaseToken,
        input.planHash, input.sourceHash, input.factRegistryHash, input.assetHash, input.promptHash,
        input.profileId, input.profileVersion, input.modelName, input.promptTemplateVersion,
        JSON.stringify(input.sourceFactEvidence), JSON.stringify(input.assetEvidence), JSON.stringify(input.requestEvidence),
        input.gatewayConnectionId ?? null, input.gatewayConnectionVersion ?? null, input.expectedStatusVersion],
      );
    } catch {
      throw repositoryError();
    }
    if (result.rowCount !== 1) throw attemptError();
    const record = mapRow(result.rows[0]);
    if (!verifyTerminalEcho(record, input, status)) throw attemptError();
    return record;
  }

  async function releaseRichContentAttempt(input) {
    validateReservation(input);
    if (input?.errorCode !== CHANNEL_RELEASED || !Number.isInteger(input.attemptNo)
      || input.attemptNo < 1 || !clean(input.leaseToken)) throw attemptError();
    let result;
    try {
      result = await pool.query(
        `WITH current_item AS (
           SELECT item.account_id,item.job_id,item.id,item.active_content_plan_id
           FROM auto_listing_job_items AS item
           WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
             AND item.status='GENERATING' AND item.status_version=$22 AND item.active_content_plan_id=$4
           FOR UPDATE
         )
         UPDATE ai_rich_content_results AS attempt SET
           lease_owner='AUTO_LISTING_RICH_CONTENT_CHANNEL_RELEASED',
           lease_expires_at=NOW(),updated_at=NOW()
         FROM current_item AS item
         WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3
           AND attempt.plan_id=$4 AND attempt.input_hash=$5 AND attempt.attempt_no=$6
           AND attempt.status='GENERATING' AND attempt.lease_token=$7 AND attempt.lease_expires_at > NOW()
           AND attempt.plan_hash=$8 AND attempt.source_hash=$9 AND attempt.fact_registry_hash=$10
           AND attempt.asset_hash=$11 AND attempt.prompt_hash=$12 AND attempt.profile_id=$13
           AND attempt.profile_version=$14 AND attempt.model_name=$15 AND attempt.prompt_template_version=$16
           AND attempt.source_fact_evidence=$17::JSONB AND attempt.asset_evidence=$18::JSONB
           AND attempt.request_evidence=$19::JSONB
           AND attempt.gateway_connection_id IS NOT DISTINCT FROM $20
           AND attempt.gateway_connection_version IS NOT DISTINCT FROM $21
           AND item.account_id=$1 AND item.job_id=$2 AND item.id=$3 AND item.active_content_plan_id=$4
         RETURNING attempt.*`,
        [...SCOPE_KEYS.map((key) => input[key]), input.inputHash, input.attemptNo, input.leaseToken,
          input.planHash, input.sourceHash, input.factRegistryHash, input.assetHash, input.promptHash,
          input.profileId, input.profileVersion, input.modelName, input.promptTemplateVersion,
          JSON.stringify(input.sourceFactEvidence), JSON.stringify(input.assetEvidence), JSON.stringify(input.requestEvidence),
          input.gatewayConnectionId ?? null, input.gatewayConnectionVersion ?? null, input.expectedStatusVersion],
      );
    } catch {
      throw repositoryError();
    }
    const record = mapRow(result.rows?.[0]);
    if (result.rowCount !== 1 || record?.status !== "GENERATING"
      || record.leaseOwner !== CHANNEL_RELEASED || record.errorCode !== null || record.errorRetryable !== null
      || record.attemptNo !== input.attemptNo || record.leaseToken !== input.leaseToken) throw attemptError();
    return record;
  }

  const repository = {
    reserveRichContentAttempt,
    completeRichContentAttempt: (input) => transition(input, "ACCEPTED"),
    rejectRichContentAttempt: (input) => transition(input, "REJECTED"),
    failRichContentAttempt: (input) => transition(input, "FAILED"),
    releaseRichContentAttempt,
  };
  repository.reserveRichContent = repository.reserveRichContentAttempt;
  repository.completeRichContent = repository.completeRichContentAttempt;
  repository.rejectRichContent = repository.rejectRichContentAttempt;
  repository.failRichContent = repository.failRichContentAttempt;
  repository.releaseRichContent = repository.releaseRichContentAttempt;
  return Object.freeze(repository);
}

export const createPostgresRichContentAttemptRepository = createPostgresRichContentRepository;
