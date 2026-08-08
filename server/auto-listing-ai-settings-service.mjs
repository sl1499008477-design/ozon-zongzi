import crypto from "node:crypto";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import { normalizeSub2ApiGatewayBaseUrl } from "./sub2api-gateway-boundary.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u;
const IMAGE_PROTOCOLS = new Set(["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"]);
const SECRET_KEYS = new Set([
  "gatewayKey", "encryptedSecret", "ciphertext", "iv", "authTag", "auth_tag", "authorization",
  "leaseToken", "lease_token", "apiKeyEnvName", "api_key_env_name",
]);

function settingsError(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function plainRecord(value) {
  try {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch {
    return false;
  }
}

function closed(value, keys, code = "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID") {
  try {
    if (!plainRecord(value)) throw settingsError(code);
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw settingsError(code);
    }
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === code) throw error;
    throw settingsError(code);
  }
}

function text(value, { maximum = 240, pattern = SAFE_ID } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || Buffer.byteLength(result, "utf8") > maximum || (pattern && !pattern.test(result))) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
  return result;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
  return value;
}

function actorScope(actor) {
  assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
  return text(actor.id);
}

function safeValue(value, accountId, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_INVALID", 500);
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_INVALID", 500);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => safeValue(entry, accountId, seen));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_INVALID", 500);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || SECRET_KEYS.has(key) || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")) {
        if (typeof key === "string" && SECRET_KEYS.has(key)) continue;
        throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_INVALID", 500);
      }
      output[key] = safeValue(descriptors[key].value, accountId, seen);
    }
    const rowAccountId = typeof output.accountId === "string" ? output.accountId : null;
    if (rowAccountId !== null && rowAccountId !== accountId) {
      throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function models(catalog) {
  return Array.isArray(catalog?.catalog?.models) ? new Set(catalog.catalog.models
    .map((model) => typeof model?.id === "string" ? model.id : "").filter(Boolean)) : new Set();
}

function latestCatalogs(overview) {
  const successfulCatalogSyncTasks = new Set((Array.isArray(overview.syncTasks) ? overview.syncTasks : [])
    .filter((task) => task?.status === "SUCCEEDED" && task?.syncPurpose === "CATALOG_SYNC")
    .map((task) => task.id));
  const result = new Map();
  for (const catalog of Array.isArray(overview.catalogs) ? overview.catalogs : []) {
    if (!successfulCatalogSyncTasks.has(catalog?.syncTaskId)) continue;
    const key = `${catalog?.connectionId}\0${catalog?.connectionVersion}`;
    if (!result.has(key)) result.set(key, catalog);
  }
  return result;
}

function explicitActions(overview) {
  const connections = Array.isArray(overview.connections) ? overview.connections : [];
  const profiles = Array.isArray(overview.profiles) ? overview.profiles : [];
  const byConnection = new Map(connections.map((connection) => [
    `${connection?.id}\0${connection?.version}`, connection,
  ]));
  const catalogs = latestCatalogs(overview);
  const testable = [];
  const publishable = [];
  const rollback = [];
  for (const profile of profiles) {
    if (typeof profile?.id !== "string") continue;
    if (profile.connectionId === null || profile.connectionId === undefined) {
      testable.push(profile.id);
      if (profile.capabilityResult?.outcome === "PASSED") publishable.push(profile.id);
      continue;
    }
    const key = `${profile.connectionId}\0${profile.connectionVersion}`;
    const connection = byConnection.get(key);
    const catalogModels = models(catalogs.get(key));
    const exactModels = catalogModels.has(profile.textModel) && catalogModels.has(profile.imageModel);
    if (connection?.status === "VALIDATED" && exactModels) {
      testable.push(profile.id);
      if (profile.capabilityResult?.outcome === "PASSED") publishable.push(profile.id);
    }
    if (connection?.status === "RETIRED" && exactModels) rollback.push(profile.id);
  }
  return {
    canCreateConnection: true,
    syncableConnectionIds: connections.filter((connection) => ["PENDING", "VALIDATED"].includes(connection?.status))
      .map((connection) => connection.id),
    testableProfileIds: testable,
    publishableProfileIds: publishable,
    rollbackProfileIds: rollback,
  };
}

function requireDependencies(repository, profileRepository, cipher, capabilityService) {
  const repositoryMethods = ["connectionIdForIntent", "loadSettingsOverview", "createPendingConnection",
    "enqueueModelSync", "createProfileFromSelection"];
  const profileMethods = ["publishProfile", "prepareProfileRollback", "rollbackProfile"];
  if (!repository || repositoryMethods.some((method) => typeof repository[method] !== "function")
    || !profileRepository || profileMethods.some((method) => typeof profileRepository[method] !== "function")
    || !cipher || typeof cipher.encrypt !== "function" || typeof cipher.fingerprint !== "function"
    || !capabilityService || typeof capabilityService.testGatewayCapabilities !== "function") {
    throw new TypeError("Auto-listing AI settings service dependencies are required");
  }
}

export function createAutoListingAiSettingsService({
  repository, profileRepository, cipher, capabilityService, allowLocalGateway = false,
} = {}) {
  requireDependencies(repository, profileRepository, cipher, capabilityService);
  if (typeof allowLocalGateway !== "boolean") {
    throw new TypeError("Auto-listing AI settings local gateway policy must be boolean");
  }

  return Object.freeze({
    async getOverview(raw = {}) {
      const input = closed(raw, new Set(["actor"]));
      const accountId = actorScope(input.actor);
      const loaded = await repository.loadSettingsOverview({ accountId });
      const safe = safeValue(loaded, accountId);
      if (!plainRecord(safe) || safe.accountId !== accountId) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
      }
      return Object.freeze({ ...safe, actions: explicitActions(safe) });
    },

    async createConnection(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "idempotencyKey", "correlationId", "displayName", "baseUrl", "gatewayKey",
      ]));
      const accountId = actorScope(input.actor);
      const idempotencyKey = text(input.idempotencyKey);
      const correlationId = text(input.correlationId);
      const displayName = text(input.displayName, { maximum: 200, pattern: null });
      let baseUrl;
      try {
        baseUrl = normalizeSub2ApiGatewayBaseUrl(
          text(input.baseUrl, { maximum: 2048, pattern: null }),
          { allowLocalGateway },
        );
      } catch {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_BASE_URL_INVALID", 422, false);
      }
      const gatewayKey = text(input.gatewayKey, { maximum: 16_384, pattern: null });
      const connectionId = repository.connectionIdForIntent({ accountId, idempotencyKey });
      const encryptedSecret = {
        ...cipher.encrypt({ accountId, connectionId, connectionVersion: 1 }, gatewayKey),
        fingerprint: cipher.fingerprint(gatewayKey),
      };
      const row = await repository.createPendingConnection({
        accountId, actorId: accountId, connectionId, idempotencyKey, correlationId,
        displayName, baseUrl, encryptedSecret,
      });
      return Object.freeze(safeValue(row, accountId));
    },

    async requestModelSync(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "connectionId", "connectionVersion", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorScope(input.actor);
      const connectionId = text(input.connectionId);
      const connectionVersion = version(input.connectionVersion);
      const loaded = await repository.loadSettingsOverview({ accountId });
      const connection = Array.isArray(loaded?.connections) ? loaded.connections.find((candidate) =>
        candidate?.accountId === accountId && candidate?.id === connectionId
        && candidate?.version === connectionVersion) : null;
      if (!connection) throw settingsError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND", 404);
      if (!["PENDING", "VALIDATED"].includes(connection.status) || !Number.isSafeInteger(connection.statusVersion)) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_SYNCABLE", 409);
      }
      const row = await repository.enqueueModelSync({
        accountId, actorId: accountId, connectionId, connectionVersion,
        expectedConnectionStatusVersion: connection.statusVersion, syncPurpose: "CATALOG_SYNC", maxAttempts: 5,
        idempotencyKey: text(input.idempotencyKey), correlationId: text(input.correlationId),
      });
      return Object.freeze(safeValue(row, accountId));
    },

    async createProfileSelection(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "connectionId", "connectionVersion", "catalogId", "displayName", "textModel", "imageModel",
        "textProtocol", "imageProtocol", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorScope(input.actor);
      const textProtocol = text(input.textProtocol);
      const imageProtocol = text(input.imageProtocol);
      if (textProtocol !== "SUB2API_RESPONSES" || !IMAGE_PROTOCOLS.has(imageProtocol)) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
      }
      const row = await repository.createProfileFromSelection({
        accountId, actorId: accountId, connectionId: text(input.connectionId),
        connectionVersion: version(input.connectionVersion), catalogId: text(input.catalogId),
        displayName: text(input.displayName, { maximum: 200, pattern: null }),
        textModel: text(input.textModel, { maximum: 300, pattern: MODEL_ID }),
        imageModel: text(input.imageModel, { maximum: 300, pattern: MODEL_ID }),
        textProtocol, imageProtocol,
        idempotencyKey: text(input.idempotencyKey), correlationId: text(input.correlationId),
      });
      return Object.freeze(safeValue(row, accountId));
    },

    async testProfile(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "profileId", "configVersion", "correlationId", "costConfirmed",
      ]));
      const accountId = actorScope(input.actor);
      if (input.costConfirmed !== true) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED", 409);
      }
      const result = await capabilityService.testGatewayCapabilities({
        actor: input.actor, profileId: text(input.profileId), configVersion: version(input.configVersion),
        correlationId: text(input.correlationId), purpose: "PROFILE_CAPABILITY", costConfirmed: true,
      });
      return Object.freeze(safeValue(result, accountId));
    },

    async publishProfile(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "profileId", "configVersion", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorScope(input.actor);
      const row = await profileRepository.publishProfile({
        accountId, actorId: accountId, profileId: text(input.profileId),
        configVersion: version(input.configVersion), idempotencyKey: text(input.idempotencyKey),
        correlationId: text(input.correlationId),
      });
      return Object.freeze(safeValue(row, accountId));
    },

    async rollbackProfile(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "profileId", "configVersion", "idempotencyKey", "correlationId", "costConfirmed",
      ]));
      const accountId = actorScope(input.actor);
      if (input.costConfirmed !== true) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED", 409);
      }
      const profileId = text(input.profileId);
      const configVersion = version(input.configVersion);
      const correlationId = text(input.correlationId);
      const idempotencyKey = text(input.idempotencyKey);
      const prepared = await profileRepository.prepareProfileRollback({
        accountId, actorId: accountId, profileId, configVersion, idempotencyKey, correlationId,
      });
      if (prepared?.completed === true && prepared.profile) {
        return Object.freeze(safeValue(prepared.profile, accountId));
      }
      const capability = await capabilityService.testGatewayCapabilities({
        actor: input.actor, profileId, configVersion,
        correlationId: `rollback-capability:${crypto.createHash("sha256")
          .update(`${accountId}\0${profileId}\0${configVersion}\0${idempotencyKey}`).digest("hex").slice(0, 40)}`,
        purpose: "ROLLBACK_CAPABILITY", costConfirmed: true,
      });
      if (capability?.outcome !== "PASSED") {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_ROLLBACK_CAPABILITY_REQUIRED", 409);
      }
      const row = await profileRepository.rollbackProfile({
        accountId, actorId: accountId, profileId, configVersion,
        idempotencyKey, correlationId,
      });
      return Object.freeze(safeValue(row, accountId));
    },
  });
}
