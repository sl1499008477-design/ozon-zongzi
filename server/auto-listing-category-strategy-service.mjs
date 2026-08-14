import crypto from "node:crypto";
import { types } from "node:util";

import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import { projectCategoryStrategyScope } from "./auto-listing-category-strategy-contract.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MODES = new Set(["LEGACY_FALLBACK", "REQUIRE_EXACT_STRATEGY"]);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const REPLAY_CACHE_TTL_MS = 30 * 60 * 1000;
const FACTORY_KEYS = new Set([
  "repository", "readModel", "sampleStore", "exactProductFacts", "extensionSessionChannel",
  "publicationService", "now", "deriveSessionIdentity",
]);

function failure(code, status = 422, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function invalid() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID", 400);
}

function dataBoundary() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
}

function dependencyDto(project) {
  try {
    return project();
  } catch {
    throw dataBoundary();
  }
}

function closed(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID") throw error;
    throw invalid();
  }
}

function closedArray(raw, minimum, maximum) {
  try {
    if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
      || raw.length < minimum || raw.length > maximum) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== raw.length + 1 || descriptors.length?.value !== raw.length) throw invalid();
    return Array.from({ length: raw.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw invalid();
      return descriptor.value;
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(text)) throw invalid();
  return text;
}

function secret(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length < 32 || text.length > 512 || /[\u0000-\u001f\u007f]/u.test(text)) throw invalid();
  return text;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function productId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function operationId(prefix, ...identity) {
  return `${prefix}-${hash(identity.join("\0")).slice(0, 40)}`;
}

function actorAccount(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (descriptors.id?.enumerable !== true || !Object.hasOwn(descriptors.id, "value")
      || descriptors.role?.enumerable !== true || !Object.hasOwn(descriptors.role, "value")) throw invalid();
    const actor = Object.freeze({ id: identifier(descriptors.id.value), role: descriptors.role.value });
    assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
    return actor.id;
  } catch (error) {
    if (error?.code === "PERMISSION_FORBIDDEN" || error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID") {
      throw error;
    }
    throw invalid();
  }
}

function scopeFor(accountId, raw, includesAccount = false) {
  let input;
  if (includesAccount) input = closed(raw,
    new Set(["accountId", "taxonomyScope", "descriptionCategoryId", "typeId"]));
  else {
    const value = closed(raw, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
    input = { accountId, ...value };
  }
  let scope;
  try { scope = projectCategoryStrategyScope(input); } catch { throw invalid(); }
  if (scope.accountId !== accountId) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
  }
  return scope;
}

function publicScope(scope) {
  return Object.freeze({ taxonomyScope: scope.taxonomyScope,
    descriptionCategoryId: scope.descriptionCategoryId, typeId: scope.typeId });
}

function browserUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2048) throw invalid();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalid(); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash
    || !(host === "ozon.ru" || host.endsWith(".ozon.ru"))) throw invalid();
  parsed.search = "";
  return parsed.href;
}

function exactIsoDate(value) {
  if (typeof value !== "string") throw invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalid();
  return value;
}

function duplicate(value) {
  if (typeof value !== "boolean") throw invalid();
  return value;
}

function sameScope(left, right) {
  return left.accountId === right.accountId && left.taxonomyScope === right.taxonomyScope
    && left.descriptionCategoryId === right.descriptionCategoryId && left.typeId === right.typeId;
}

function policyRow(raw, accountId, expectedMode = null, expectedVersion = null) {
  return dependencyDto(() => {
    const value = closed(raw, new Set(["accountId", "mode", "version", "duplicate"]));
    const mode = value.mode;
    const version = positive(value.version);
    if (identifier(value.accountId) !== accountId || !MODES.has(mode)
      || (expectedMode !== null && mode !== expectedMode)
      || (expectedVersion !== null && version !== expectedVersion)) throw invalid();
    return Object.freeze({ mode, version, duplicate: duplicate(value.duplicate) });
  });
}

function createdDraftRow(raw, accountId, expectedScope, expectedSourceCollectItemId, expectedSourceVersion) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "draftId", "accountId", "scope", "draftVersion", "status", "sourceCollectItemId",
      "expectedSourceVersion", "duplicate",
    ]));
    const scope = scopeFor(accountId, value.scope, true);
    if (identifier(value.accountId) !== accountId || !sameScope(scope, expectedScope)
      || value.status !== "COLLECTING"
      || identifier(value.sourceCollectItemId) !== expectedSourceCollectItemId
      || identifier(value.expectedSourceVersion) !== expectedSourceVersion) throw invalid();
    return Object.freeze({ draftId: identifier(value.draftId), scope, draftVersion: positive(value.draftVersion),
      status: value.status, duplicate: duplicate(value.duplicate) });
  });
}

function samplingSessionRow(raw, accountId, draftId) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "sessionId", "draftId", "accountId", "state", "createdAt", "expiresAt", "duplicate",
    ]));
    if (identifier(value.accountId) !== accountId || identifier(value.draftId) !== draftId
      || value.state !== "ACTIVE") throw invalid();
    exactIsoDate(value.createdAt);
    return Object.freeze({ sessionId: identifier(value.sessionId), expiresAt: exactIsoDate(value.expiresAt),
      duplicate: duplicate(value.duplicate) });
  });
}

function derivedSessionIdentity(raw) {
  return dependencyDto(() => {
    const value = closed(raw, new Set(["sessionId", "sessionSecret"]));
    return Object.freeze({ sessionId: identifier(value.sessionId), sessionSecret: secret(value.sessionSecret) });
  });
}

function committedSampleSetRow(raw, expected) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "sampleSetId", "draftId", "accountId", "sampleSetHash", "sampleCount", "draftVersion",
      "status", "idempotencyKey", "duplicate",
    ]));
    if (identifier(value.accountId) !== expected.accountId
      || identifier(value.draftId) !== expected.draftId
      || identifier(value.sampleSetId) !== expected.sampleSetId
      || identifier(value.idempotencyKey) !== expected.idempotencyKey
      || typeof value.sampleSetHash !== "string" || !SHA256.test(value.sampleSetHash)
      || value.sampleCount !== expected.sampleCount || value.draftVersion !== expected.draftVersion
      || value.status !== "SAMPLES_READY") throw invalid();
    return Object.freeze({ sampleSetId: value.sampleSetId, sampleSetHash: value.sampleSetHash,
      sampleCount: value.sampleCount, draftVersion: value.draftVersion, status: value.status,
      duplicate: duplicate(value.duplicate) });
  });
}

function readDraftRow(raw, accountId) {
  let row;
  let rowAccountId;
  try {
    row = closed(raw, new Set([
      "draftId", "accountId", "scope", "draftVersion", "status", "sampleCount",
      "sourceCollectItemId", "expectedSourceVersion", "browserUrl",
    ]));
    rowAccountId = identifier(row.accountId);
  } catch {
    throw dataBoundary();
  }
  if (rowAccountId !== accountId) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
  }
  try {
    const scope = scopeFor(accountId, row.scope, true);
    if (!["COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED", "NEEDS_REVIEW"].includes(row.status)
      || !Number.isSafeInteger(row.sampleCount) || row.sampleCount < 0 || row.sampleCount > 20) throw invalid();
    return Object.freeze({
      draftId: identifier(row.draftId), scope, draftVersion: positive(row.draftVersion), status: row.status,
      sampleCount: row.sampleCount, sourceCollectItemId: identifier(row.sourceCollectItemId),
      expectedSourceVersion: identifier(row.expectedSourceVersion), browserUrl: browserUrl(row.browserUrl),
    });
  } catch {
    throw dataBoundary();
  }
}

function publicDraft(row) {
  return Object.freeze({ draftId: row.draftId, scope: publicScope(row.scope),
    draftVersion: row.draftVersion, status: row.status, sampleCount: row.sampleCount });
}

function sourceReference(raw) {
  const value = closed(raw, new Set(["imageId", "role", "ordinal", "sourceUrl", "sourceResponseHash"]));
  if (!["MAIN", "DETAIL"].includes(value.role) || !Number.isInteger(value.ordinal)
    || (value.role === "MAIN") !== (value.ordinal === 0)
    || typeof value.sourceResponseHash !== "string" || !SHA256.test(value.sourceResponseHash)) throw invalid();
  return Object.freeze({ imageId: identifier(value.imageId), role: value.role, ordinal: value.ordinal,
    sourceUrl: value.sourceUrl, sourceResponseHash: value.sourceResponseHash });
}

function verifiedFact(raw, claimed, scope) {
  const value = closed(raw, new Set([
    "sku", "sourceProductId", "sourceProductRef", "sourceProductResponseHash", "pageScope",
    "productScope", "sourceReferences",
  ]));
  const pageScope = evidenceScope(value.pageScope);
  const productScope = evidenceScope(value.productScope);
  if (identifier(value.sku) !== claimed.sku || productId(value.sourceProductId) !== claimed.sourceProductId
    || identifier(value.sourceProductRef) !== claimed.sourceProductRef
    || typeof value.sourceProductResponseHash !== "string" || !SHA256.test(value.sourceProductResponseHash)
    || [pageScope, productScope].some((candidate) => candidate.taxonomyScope !== scope.taxonomyScope
      || candidate.descriptionCategoryId !== scope.descriptionCategoryId || candidate.typeId !== scope.typeId)) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SCOPE_CONFLICT", 409);
  }
  const references = closedArray(value.sourceReferences, 1, 6).map(sourceReference);
  if (references.some((entry, ordinal) => entry.ordinal !== ordinal
    || entry.role !== (ordinal === 0 ? "MAIN" : "DETAIL"))) throw invalid();
  return Object.freeze({ sku: claimed.sku, sourceProductId: claimed.sourceProductId,
    sourceProductRef: claimed.sourceProductRef, sourceProductResponseHash: value.sourceProductResponseHash,
    sourceReferences: Object.freeze(references) });
}

function sampleSelection(raw) {
  const value = closed(raw, new Set(["sku", "sourceProductId", "sourceProductRef"]));
  return Object.freeze({ sku: identifier(value.sku), sourceProductId: productId(value.sourceProductId),
    sourceProductRef: identifier(value.sourceProductRef) });
}

function evidenceScope(raw) {
  const value = closed(raw, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
  if (value.taxonomyScope !== "OZON:DEFAULT" || !Number.isSafeInteger(value.descriptionCategoryId)
    || value.descriptionCategoryId < 1 || !Number.isSafeInteger(value.typeId) || value.typeId < 1) throw invalid();
  return Object.freeze({ taxonomyScope: value.taxonomyScope,
    descriptionCategoryId: value.descriptionCategoryId, typeId: value.typeId });
}

function dependencyError(error) {
  if (typeof error?.code === "string" && (error.code === "PERMISSION_FORBIDDEN"
    || error.code.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_"))) throw error;
  throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SERVICE_FAILED", 503, true);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function publicationDto(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error("boundary");
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    const required = new Set(["id", "strategyKey", "version", "status"]);
    const allowed = new Set([...required, "duplicate"]);
    if (![4, 5].includes(own.length) || own.some((key) => typeof key !== "string" || !allowed.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))
      || [...required].some((key) => !Object.hasOwn(descriptors, key))) throw new Error("boundary");
    const id = typeof descriptors.id.value === "string" ? descriptors.id.value.trim() : "";
    const strategyKey = typeof descriptors.strategyKey.value === "string" ? descriptors.strategyKey.value.trim() : "";
    const status = typeof descriptors.status.value === "string" ? descriptors.status.value.trim() : "";
    const version = descriptors.version.value;
    if (!SAFE_ID.test(id) || !SAFE_ID.test(strategyKey) || status !== "PUBLISHED"
      || !Number.isSafeInteger(version) || version < 1
      || (Object.hasOwn(descriptors, "duplicate") && typeof descriptors.duplicate.value !== "boolean")) {
      throw new Error("boundary");
    }
    return Object.freeze({ id, strategyKey, version, status,
      ...(Object.hasOwn(descriptors, "duplicate") ? { duplicate: descriptors.duplicate.value } : {}) });
  } catch {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
  }
}

export function createAutoListingCategoryStrategyService(rawOptions = {}) {
  const options = closed(rawOptions, FACTORY_KEYS);
  const { repository, readModel, sampleStore, exactProductFacts, extensionSessionChannel,
    publicationService, now, deriveSessionIdentity } = options;
  if (!["getDraftReplay", "createDraft", "startSamplingSession", "getSamplingSessionReplay", "validateSamplingSession",
    "getCommittedSampleSetReplay", "commitSampleSetCanonical", "transitionAccountPolicy",
    "getAccountPolicy"].every((method) => typeof repository?.[method] === "function")
    || typeof readModel?.listStrategies !== "function" || typeof readModel?.getDraft !== "function"
    || typeof sampleStore?.persistSampleImages !== "function" || typeof exactProductFacts?.verify !== "function"
    || typeof extensionSessionChannel?.putSession !== "function"
    || typeof publicationService?.publishCategoryStrategyDraft !== "function"
    || typeof publicationService?.rollbackCategoryStrategyVersion !== "function"
    || typeof now !== "function" || typeof deriveSessionIdentity !== "function") {
    throw new TypeError("Auto-listing category strategy service dependencies are required");
  }
  const sessionReplays = new Map();
  const sampleReplays = new Map();

  function replayCacheTime() {
    const value = new Date(now()).getTime();
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }

  function pruneReplayCache(cache, currentTime) {
    for (const [key, record] of cache) {
      if (record.settled === true && record.cachedAt + REPLAY_CACHE_TTL_MS <= currentTime) {
        cache.delete(key);
      }
    }
  }

  function markReplaySettled(record) {
    const value = new Date(now()).getTime();
    if (Number.isFinite(value)) record.cachedAt = value;
    record.settled = true;
  }

  async function ownDraft(accountId, draftId) {
    let raw;
    try { raw = await readModel.getDraft({ accountId, draftId }); } catch (error) { dependencyError(error); }
    if (!raw) throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
    return readDraftRow(raw, accountId);
  }

  async function accountPolicy(accountId) {
    let row;
    try { row = await repository.getAccountPolicy({ accountId }); } catch (error) { dependencyError(error); }
    return policyRow(row, accountId);
  }

  async function requireEnabled(accountId) {
    const policy = await accountPolicy(accountId);
    if (policy.mode !== "REQUIRE_EXACT_STRATEGY") {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", 409);
    }
    return policy;
  }

  return Object.freeze({
    async listStrategies(raw = {}) {
      const input = closed(raw, new Set(["actor"]));
      const accountId = actorAccount(input.actor);
      let rows;
      try { rows = await readModel.listStrategies({ accountId }); } catch (error) { dependencyError(error); }
      return freeze(closedArray(rows, 0, 1_000).map((row) => publicDraft(readDraftRow(row, accountId))));
    },

    async getSettings(raw = {}) {
      const input = closed(raw, new Set(["actor"]));
      const accountId = actorAccount(input.actor);
      const value = await accountPolicy(accountId);
      return Object.freeze({ mode: value.mode, version: value.version });
    },

    async updateSettings(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "expectedVersion", "mode", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      if (!MODES.has(input.mode)) throw invalid();
      let row;
      try {
        row = await repository.transitionAccountPolicy({ accountId, actorId: accountId,
          expectedVersion: positive(input.expectedVersion), mode: input.mode,
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) });
      } catch (error) { dependencyError(error); }
      return policyRow(row, accountId, input.mode, positive(input.expectedVersion) + 1);
    },

    async getDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId"]));
      const accountId = actorAccount(input.actor);
      return publicDraft(await ownDraft(accountId, identifier(input.draftId)));
    },

    async createDraft(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "scope", "sourceCollectItemId", "expectedSourceVersion", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      const scope = scopeFor(accountId, input.scope);
      const sourceCollectItemId = identifier(input.sourceCollectItemId);
      const expectedSourceVersion = identifier(input.expectedSourceVersion);
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      let replay;
      try {
        replay = await repository.getDraftReplay({ accountId, actorId: accountId, scope,
          sourceCollectItemId, expectedSourceVersion, idempotencyKey, correlationId });
      } catch (error) { dependencyError(error); }
      if (replay) {
        const value = createdDraftRow(replay, accountId, scope, sourceCollectItemId, expectedSourceVersion);
        return Object.freeze({ draftId: value.draftId, scope: publicScope(value.scope),
          draftVersion: value.draftVersion, status: value.status, duplicate: true });
      }
      await requireEnabled(accountId);
      let row;
      try {
        row = await repository.createDraft({ accountId, actorId: accountId, scope,
          sourceCollectItemId, expectedSourceVersion,
          idempotencyKey, correlationId });
      } catch (error) { dependencyError(error); }
      const value = createdDraftRow(row, accountId, scope, sourceCollectItemId, expectedSourceVersion);
      return Object.freeze({ draftId: value.draftId, scope: publicScope(value.scope),
        draftVersion: value.draftVersion, status: value.status, duplicate: value.duplicate });
    },

    async startSamplingSession(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "draftId", "expectedDraftVersion", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      const expectedDraftVersion = positive(input.expectedDraftVersion);
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      const fingerprint = hash(JSON.stringify({ accountId, draftId, expectedDraftVersion,
        idempotencyKey, correlationId }));
      const replayKey = `${accountId}\\0${idempotencyKey}`;
      const currentTime = replayCacheTime();
      pruneReplayCache(sessionReplays, currentTime);
      let replay = sessionReplays.get(replayKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
        }
        if (replay.promise) return replay.promise;
      } else {
        const candidateExpiry = new Date(new Date(now()).getTime() + TWO_HOURS_MS);
        if (Number.isNaN(candidateExpiry.getTime())) throw invalid();
        let identity;
        try {
          identity = derivedSessionIdentity(await deriveSessionIdentity({ accountId, draftId,
            expectedDraftVersion, idempotencyKey, correlationId }));
        } catch (error) { dependencyError(error); }
        replay = {
          fingerprint,
          sessionId: identity.sessionId,
          sessionSecret: identity.sessionSecret,
          expiresAt: candidateExpiry.toISOString(),
          promise: null,
          settled: false,
          cachedAt: currentTime,
        };
        sessionReplays.set(replayKey, replay);
      }
      replay.settled = false;
      const promise = (async () => {
        const draft = await ownDraft(accountId, draftId);
        let durable;
        try {
          durable = await repository.getSamplingSessionReplay({ accountId, actorId: accountId, draftId,
            expectedDraftVersion, sessionId: replay.sessionId,
            sessionSecretHash: hash(replay.sessionSecret), idempotencyKey, correlationId });
        } catch (error) { dependencyError(error); }
        if (durable) {
          const row = samplingSessionRow(durable, accountId, draftId);
          try {
            await extensionSessionChannel.putSession({ accountId, actorId: accountId, draftId,
              sessionId: row.sessionId, sessionSecret: replay.sessionSecret, expiresAt: row.expiresAt,
              extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope: publicScope(draft.scope) });
          } catch (error) { dependencyError(error); }
          replay.sessionSecret = null;
          return Object.freeze({ sessionId: row.sessionId, expiresAt: row.expiresAt,
            browserUrl: draft.browserUrl, extensionMode: "CATEGORY_STRATEGY_SAMPLING",
            scope: publicScope(draft.scope), duplicate: true });
        }
        await requireEnabled(accountId);
        let row;
        try {
          const stored = await repository.startSamplingSession({ accountId, actorId: accountId, draftId,
            expectedDraftVersion, sessionId: replay.sessionId, sessionSecretHash: hash(replay.sessionSecret),
            expiresAt: replay.expiresAt, idempotencyKey, correlationId });
          row = samplingSessionRow(stored, accountId, draftId);
          await extensionSessionChannel.putSession({ accountId, actorId: accountId, draftId,
            sessionId: row.sessionId, sessionSecret: replay.sessionSecret, expiresAt: row.expiresAt,
            extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope: publicScope(draft.scope) });
          replay.sessionSecret = null;
        } catch (error) { dependencyError(error); }
        return Object.freeze({ sessionId: row.sessionId, expiresAt: row.expiresAt,
          browserUrl: draft.browserUrl, extensionMode: "CATEGORY_STRATEGY_SAMPLING",
          scope: publicScope(draft.scope), duplicate: row.duplicate });
      })();
      replay.promise = promise;
      promise.then(() => { markReplaySettled(replay); }, () => { markReplaySettled(replay); });
      promise.catch(() => {
        const current = sessionReplays.get(replayKey);
        if (current === replay && current.promise === promise) current.promise = null;
      });
      return promise;
    },

    async confirmSampleSet(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "draftId", "expectedDraftVersion", "sessionId", "sessionSecret", "samples",
        "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      const sessionId = identifier(input.sessionId);
      const sessionSecret = secret(input.sessionSecret);
      const expectedDraftVersion = positive(input.expectedDraftVersion);
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      const selections = closedArray(input.samples, 5, 20).map(sampleSelection);
      if (new Set(selections.map((entry) => entry.sku)).size !== selections.length
        || new Set(selections.map((entry) => entry.sourceProductId)).size !== selections.length) {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_DUPLICATE", 409);
      }
      const fingerprint = hash(JSON.stringify({ accountId, draftId, expectedDraftVersion, sessionId,
        sessionSecretHash: hash(sessionSecret), selections, idempotencyKey, correlationId }));
      const replayKey = `${accountId}\0${idempotencyKey}`;
      const currentTime = replayCacheTime();
      pruneReplayCache(sampleReplays, currentTime);
      const existing = sampleReplays.get(replayKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
        }
        return existing.promise;
      }
      const promise = (async () => {
        let durable;
        try {
          durable = await repository.getCommittedSampleSetReplay({ accountId, actorId: accountId, draftId,
            sessionId, sessionSecretHash: hash(sessionSecret), expectedDraftVersion,
            selections, idempotencyKey, correlationId });
        } catch (error) { dependencyError(error); }
        if (durable) {
          const value = committedSampleSetRow(durable, { accountId, draftId,
            sampleSetId: identifier(durable.sampleSetId), idempotencyKey,
            sampleCount: selections.length, draftVersion: expectedDraftVersion + 1 });
          return Object.freeze({ draftId, ...value });
        }
        await requireEnabled(accountId);
        const draft = await ownDraft(accountId, draftId);
        if (draft.draftVersion !== expectedDraftVersion || draft.status !== "COLLECTING") {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        try {
          samplingSessionRow(await repository.validateSamplingSession({ accountId, actorId: accountId,
            draftId, expectedDraftVersion, sessionId, sessionSecretHash: hash(sessionSecret) }),
          accountId, draftId);
        } catch (error) { dependencyError(error); }
        const verified = [];
        for (const selected of selections) {
          let fact;
          try {
            fact = await exactProductFacts.verify({ accountId, draftId, sessionId,
              sessionSecretHash: hash(sessionSecret), scope: publicScope(draft.scope),
              ...selected, correlationId });
          } catch (error) { dependencyError(error); }
          verified.push(verifiedFact(fact, selected, draft.scope));
        }
        const sampleSetId = operationId("sample-set", accountId, draftId, idempotencyKey);
        const samples = [];
        for (const [ordinal, fact] of verified.entries()) {
          const sampleId = operationId("sample", accountId, draftId, idempotencyKey,
            String(ordinal), fact.sku, String(fact.sourceProductId));
          let images;
          try {
            images = await sampleStore.persistSampleImages({ accountId, draftId, sampleSetId, sampleId,
              correlationId, sourceReferences: fact.sourceReferences });
          } catch (error) { dependencyError(error); }
          samples.push({ sampleSetId, sampleId, sku: fact.sku, sourceProductId: fact.sourceProductId,
            sourceProductRef: fact.sourceProductRef,
            sourceProductResponseHash: fact.sourceProductResponseHash,
            taxonomyScope: draft.scope.taxonomyScope,
            descriptionCategoryId: draft.scope.descriptionCategoryId,
            typeId: draft.scope.typeId, images });
        }
        let row;
        try {
          row = await repository.commitSampleSetCanonical({ accountId, actorId: accountId, draftId,
            sessionId, sessionSecretHash: hash(sessionSecret), expectedDraftVersion,
            samples, idempotencyKey, correlationId });
        } catch (error) { dependencyError(error); }
        const value = committedSampleSetRow(row, { accountId, draftId, sampleSetId,
          idempotencyKey, sampleCount: samples.length, draftVersion: expectedDraftVersion + 1 });
        return Object.freeze({ draftId, ...value });
      })();
      const replay = { fingerprint, promise, settled: false, cachedAt: currentTime };
      sampleReplays.set(replayKey, replay);
      promise.then(() => { markReplaySettled(replay); }, () => { markReplaySettled(replay); });
      promise.catch(() => { if (sampleReplays.get(replayKey)?.promise === promise) sampleReplays.delete(replayKey); });
      return promise;
    },

    async removeSample(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "sampleId", "expectedDraftVersion", "idempotencyKey", "correlationId"]));
      await requireEnabled(actorAccount(input.actor));
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_CHANGE_NOT_READY", 409);
    },

    async createAnalysisAttempt(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "costConfirmed", "idempotencyKey", "correlationId"]));
      await requireEnabled(actorAccount(input.actor));
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY", 409);
    },

    async updateDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "expectedDraftVersion", "patch", "idempotencyKey", "correlationId"]));
      await requireEnabled(actorAccount(input.actor));
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_EDIT_NOT_READY", 409);
    },

    async publishDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "expectedDraftVersion",
        "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      await ownDraft(accountId, draftId);
      try {
        return publicationDto(await publicationService.publishCategoryStrategyDraft({ actor: { id: accountId, role: "admin" },
          draftId, expectedDraftVersion: positive(input.expectedDraftVersion),
          expectedPublishedStrategyVersionId: identifier(input.expectedPublishedStrategyVersionId),
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) }));
      } catch (error) { dependencyError(error); }
    },

    async rollbackDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "targetStrategyVersionId",
        "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]));
      const accountId = actorAccount(input.actor);
      await ownDraft(accountId, identifier(input.draftId));
      try {
        return publicationDto(await publicationService.rollbackCategoryStrategyVersion({ actor: { id: accountId, role: "admin" },
          targetStrategyVersionId: identifier(input.targetStrategyVersionId),
          expectedPublishedStrategyVersionId: identifier(input.expectedPublishedStrategyVersionId),
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) }));
      } catch (error) { dependencyError(error); }
    },
  });
}
