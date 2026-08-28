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

function closed(value, keys, code = "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID", optional = new Set()) {
  try {
    if (!plainRecord(value)) throw settingsError(code);
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length < keys.size || ownKeys.some((key) => typeof key !== "string"
      || (!keys.has(key) && !optional.has(key))
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))
      || [...keys].some((key) => !Object.hasOwn(descriptors, key))) {
      throw settingsError(code);
    }
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === code) throw error;
    throw settingsError(code);
  }
}

function externalCursor(value, kind, accountId) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
  let parsed;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical cursor");
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
  const keys = kind === "connections"
    ? new Set(["v", "kind", "accountId", "createdAt", "fence", "id"])
    : new Set(["v", "kind", "accountId", "createdAt", "id"]);
  const cursor = closed(parsed, keys);
  if (cursor.v !== 1 || cursor.kind !== kind || cursor.accountId !== accountId
    || typeof cursor.createdAt !== "string" || Number.isNaN(Date.parse(cursor.createdAt))
    || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
  }
  const result = { createdAt: cursor.createdAt, id: text(cursor.id) };
  if (kind === "connections") {
    if (typeof cursor.fence !== "string" || !/^[1-9][0-9]{0,18}$/u.test(cursor.fence)) {
      throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
    }
    result.fence = cursor.fence;
  }
  return result;
}

function encodeCursor(value, kind, accountId) {
  if (value === null) return null;
  const keys = kind === "connections"
    ? new Set(["createdAt", "fence", "id"]) : new Set(["createdAt", "id"]);
  const source = closed(value, keys, "AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY");
  if (typeof source.createdAt !== "string" || Number.isNaN(Date.parse(source.createdAt))
    || new Date(source.createdAt).toISOString() !== source.createdAt
    || typeof source.id !== "string" || !SAFE_ID.test(source.id)) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
  }
  if (kind === "connections"
    && (typeof source.fence !== "string" || !/^[1-9][0-9]{0,18}$/u.test(source.fence))) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
  }
  const cursor = kind === "connections"
    ? { v: 1, kind, accountId, createdAt: source.createdAt, fence: source.fence, id: source.id }
    : { v: 1, kind, accountId, createdAt: source.createdAt, id: source.id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
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

function catalogSummary(row) {
  const catalog = plainRecord(row?.catalog) ? row.catalog : null;
  const models = Array.isArray(catalog?.models) ? catalog.models : null;
  if (!catalog || !models || models.length > 2_000) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_INVALID", 500);
  }
  return {
    id: row.id,
    accountId: row.accountId,
    connectionId: row.connectionId,
    connectionVersion: row.connectionVersion,
    syncTaskId: row.syncTaskId,
    catalog: {
      schemaVersion: catalog.schemaVersion,
      connectionVersion: catalog.connectionVersion,
      syncedAt: catalog.syncedAt,
      requestIdHash: catalog.requestIdHash,
      activeSelectionState: catalog.activeSelectionState,
      activeSelection: catalog.activeSelection,
      modelCount: models.length,
    },
    catalogHash: row.catalogHash,
    capabilityResult: row.capabilityResult,
    capabilityHash: row.capabilityHash,
    rollbackEvidenceIdentity: row.rollbackEvidenceIdentity,
    testedAt: row.testedAt,
    createdAt: row.createdAt,
  };
}

function explicitActions(overview) {
  const connections = Array.isArray(overview.connections) ? overview.connections : [];
  const syncableConnections = Array.isArray(overview.syncableConnections)
    ? overview.syncableConnections : connections;
  const profiles = Array.isArray(overview.profiles) ? overview.profiles : [];
  const byConnection = new Map(connections.map((connection) => [
    `${connection?.id}\0${connection?.version}`, connection,
  ]));
  const catalogs = latestCatalogs(overview);
  const testable = [];
  const publishable = [];
  const rollback = [];
  const profileCreatableCatalogIds = [];
  for (const [key, catalog] of catalogs) {
    const connection = byConnection.get(key);
    if (["VALIDATED", "ACTIVE"].includes(connection?.status) && typeof catalog?.id === "string") {
      profileCreatableCatalogIds.push(catalog.id);
    }
  }
  for (const profile of profiles) {
    if (typeof profile?.id !== "string") continue;
    if (profile.connectionId === null || profile.connectionId === undefined) {
      if (profile.enabled !== true) {
        testable.push(profile.id);
        if (profile.capabilityResult?.outcome === "PASSED") publishable.push(profile.id);
      }
      continue;
    }
    const key = `${profile.connectionId}\0${profile.connectionVersion}`;
    const connection = byConnection.get(key);
    const catalogModels = models(catalogs.get(key));
    const exactModels = catalogModels.has(profile.textModel) && catalogModels.has(profile.imageModel);
    if (["VALIDATED", "ACTIVE"].includes(connection?.status) && profile.enabled !== true && exactModels) {
      testable.push(profile.id);
      if (profile.capabilityResult?.outcome === "PASSED") publishable.push(profile.id);
    }
    if (connection?.status === "RETIRED" && exactModels) rollback.push(profile.id);
  }
  return {
    canCreateConnection: true,
    syncableConnectionIds: [...new Set(syncableConnections
      .filter((connection) => ["PENDING", "VALIDATED", "ACTIVE"].includes(connection?.status))
      .map((connection) => connection.id))],
    profileCreatableCatalogIds,
    testableProfileIds: testable,
    publishableProfileIds: publishable,
    rollbackProfileIds: rollback,
  };
}

function actionConnection(row, accountId, expected = null) {
  if (!plainRecord(row) || row.accountId !== accountId || typeof row.id !== "string"
    || !SAFE_ID.test(row.id) || !Number.isSafeInteger(row.version) || row.version < 1
    || !["PENDING", "VALIDATED", "ACTIVE", "RETIRED"].includes(row.status)
    || (expected && (row.id !== expected.connectionId || row.version !== expected.connectionVersion))) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
  }
  return Object.freeze({ id: row.id, accountId, version: row.version, status: row.status });
}

function connectionReference(row, { nullable = false } = {}) {
  const connectionId = row?.connectionId;
  const connectionVersion = row?.connectionVersion;
  if (nullable && connectionId == null && connectionVersion == null) return null;
  if (typeof connectionId !== "string" || !SAFE_ID.test(connectionId)
    || !Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
  }
  return Object.freeze({ connectionId, connectionVersion });
}

const CHANNEL_KEYS = new Set(["channelId", "displayName", "channelOrder", "enabled", "status",
  "connectionDisplayName", "connectionId", "connectionVersion", "assignedItemId", "cooldownUntil",
  "requiresRevalidation", "lastErrorCode"]);

function safeChannel(row) {
  const source = safeValue(row, "");
  if (!plainRecord(source)
    || typeof source.channelId !== "string" || !SAFE_ID.test(source.channelId)
    || typeof source.displayName !== "string" || typeof source.connectionDisplayName !== "string"
    || typeof source.connectionId !== "string" || !SAFE_ID.test(source.connectionId)
    || !Number.isSafeInteger(source.channelOrder) || source.channelOrder < 1
    || !Number.isSafeInteger(source.connectionVersion) || source.connectionVersion < 1
    || typeof source.enabled !== "boolean" || typeof source.requiresRevalidation !== "boolean"
    || !["AVAILABLE", "BUSY", "COOLDOWN", "DISABLED", "REQUIRES_REVALIDATION"].includes(source.status)
    || !(source.assignedItemId === null || (typeof source.assignedItemId === "string" && SAFE_ID.test(source.assignedItemId)))
    || !(source.cooldownUntil === null || (typeof source.cooldownUntil === "string" && !Number.isNaN(Date.parse(source.cooldownUntil))))
    || !(source.lastErrorCode === null || (typeof source.lastErrorCode === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(source.lastErrorCode)))) {
    throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
  }
  return Object.freeze({ channelId: source.channelId, displayName: source.displayName,
    channelOrder: source.channelOrder, enabled: source.enabled, status: source.status,
    connectionDisplayName: source.connectionDisplayName, connectionId: source.connectionId,
    connectionVersion: source.connectionVersion, assignedItemId: source.assignedItemId,
    cooldownUntil: source.cooldownUntil, requiresRevalidation: source.requiresRevalidation,
    lastErrorCode: source.lastErrorCode });
}

function safeChannelCandidates(value) {
  if (!Array.isArray(value)) throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
  return Object.freeze(value.map((row) => {
    const source = safeValue(row, "");
    if (!plainRecord(source) || !["connectionId", "connectionVersion", "connectionDisplayName"].every((key) => Object.hasOwn(source, key))
      || typeof source.connectionId !== "string" || !SAFE_ID.test(source.connectionId)
      || !Number.isSafeInteger(source.connectionVersion) || source.connectionVersion < 1
      || typeof source.connectionDisplayName !== "string") {
      throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
    }
    return Object.freeze({ connectionId: source.connectionId, connectionVersion: source.connectionVersion,
      connectionDisplayName: source.connectionDisplayName });
  }));
}

async function actionOverview({ safe, repository, accountId }) {
  const visibleProfiles = Array.isArray(safe.profiles) ? safe.profiles : [];
  const profiles = [...visibleProfiles,
    ...(safe.activeProfile && !visibleProfiles.some((row) => row?.id === safe.activeProfile.id)
      ? [safe.activeProfile] : [])];
  const visibleConnections = (Array.isArray(safe.connections) ? safe.connections : [])
    .map((row) => actionConnection(row, accountId));
  const activeConnection = safe.activeConnection === null || safe.activeConnection === undefined
    ? null : actionConnection(safe.activeConnection, accountId);
  const publicActionConnections = [...visibleConnections, ...(activeConnection ? [activeConnection] : [])];
  const byKey = new Map(publicActionConnections.map((row) => [`${row.id}\0${row.version}`, row]));
  const references = new Map();
  for (const catalog of Array.isArray(safe.catalogs) ? safe.catalogs : []) {
    const reference = connectionReference(catalog);
    references.set(`${reference.connectionId}\0${reference.connectionVersion}`, reference);
  }
  for (const profile of profiles) {
    const reference = connectionReference(profile, { nullable: true });
    if (reference) references.set(`${reference.connectionId}\0${reference.connectionVersion}`, reference);
  }
  const missingReferences = [...references].filter(([key]) => !byKey.has(key));
  const loadedConnections = await Promise.all(missingReferences.map(async ([key, reference]) => {
    const loaded = await repository.loadSettingsConnection({ accountId, ...reference });
    if (loaded === null || loaded === undefined) return [key, null];
    const safeLoaded = safeValue(loaded, accountId);
    return [key, actionConnection(safeLoaded, accountId, reference)];
  }));
  for (const [key, connection] of loadedConnections) {
    if (connection) byKey.set(key, connection);
  }
  return {
    ...safe,
    profiles,
    connections: [...byKey.values()],
    syncableConnections: publicActionConnections,
  };
}

function requireDependencies(repository, profileRepository, cipher, capabilityService) {
  const repositoryMethods = ["connectionIdForIntent", "loadSettingsOverviewPage", "loadSettingsCatalog",
    "loadSettingsConnection", "createPendingConnection", "enqueueModelSync", "createProfileFromSelection",
    "listProfileChannels", "addProfileChannel", "setProfileChannelEnabled"];
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
      const input = closed(raw, new Set(["actor"]), "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID",
        new Set(["connectionCursor", "profileCursor"]));
      const accountId = actorScope(input.actor);
      const loaded = await repository.loadSettingsOverviewPage({
        accountId,
        connectionCursor: externalCursor(input.connectionCursor, "connections", accountId),
        profileCursor: externalCursor(input.profileCursor, "profiles", accountId),
        pageSize: 10,
      });
      const safe = safeValue(loaded, accountId);
      if (!plainRecord(safe) || safe.accountId !== accountId || !plainRecord(safe.pageInfo)
        || !plainRecord(safe.pageInfo.connections) || !plainRecord(safe.pageInfo.profiles)) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
      }
      const actionSource = await actionOverview({ safe, repository, accountId });
      const membership = safe.activeProfile && typeof safe.activeProfile.id === "string"
        && Number.isSafeInteger(safe.activeProfile.configVersion) && safe.activeProfile.configVersion > 0
        ? await repository.listProfileChannels({ accountId, profileId: safe.activeProfile.id,
          profileVersion: safe.activeProfile.configVersion }) : { channels: [], channelCandidates: [] };
      const safeMembership = safeValue(membership, accountId);
      if (!plainRecord(safeMembership) || !Array.isArray(safeMembership.channels)) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
      }
      const pagination = {
        connections: {
          pageSize: safe.pageInfo.connections.pageSize,
          hasMore: safe.pageInfo.connections.next !== null,
          nextCursor: encodeCursor(safe.pageInfo.connections.next, "connections", accountId),
        },
        profiles: {
          pageSize: safe.pageInfo.profiles.pageSize,
          hasMore: safe.pageInfo.profiles.next !== null,
          nextCursor: encodeCursor(safe.pageInfo.profiles.next, "profiles", accountId),
        },
      };
      return Object.freeze({
        accountId,
        activeConnection: safe.activeConnection ?? null,
        activeProfile: safe.activeProfile ?? null,
        connections: Array.isArray(safe.connections) ? safe.connections : [],
        catalogs: (Array.isArray(safe.catalogs) ? safe.catalogs : []).map(catalogSummary),
        syncTasks: Array.isArray(safe.syncTasks) ? safe.syncTasks : [],
        profiles: Array.isArray(safe.profiles) ? safe.profiles : [],
        channels: Object.freeze(safeMembership.channels.map(safeChannel)),
        channelCandidates: safeChannelCandidates(safeMembership.channelCandidates),
        pagination,
        actions: explicitActions(actionSource),
      });
    },

    async getCatalog(raw = {}) {
      const input = closed(raw, new Set(["actor", "catalogId"]));
      const accountId = actorScope(input.actor);
      const loaded = await repository.loadSettingsCatalog({
        accountId, catalogId: text(input.catalogId),
      });
      const safe = safeValue(loaded, accountId);
      if (!plainRecord(safe) || !plainRecord(safe.catalog)
        || safe.catalog.accountId !== accountId || typeof safe.canCreateProfile !== "boolean") {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
      }
      return Object.freeze({
        accountId,
        catalog: safe.catalog,
        actions: Object.freeze({ canCreateProfile: safe.canCreateProfile }),
      });
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
      const connection = await repository.loadSettingsConnection({
        accountId, connectionId, connectionVersion,
      });
      if (connection && connection.accountId !== accountId) {
        throw settingsError("AUTO_LISTING_AI_SETTINGS_DATA_BOUNDARY", 500);
      }
      if (!connection) throw settingsError("AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND", 404);
      if (!["PENDING", "VALIDATED", "ACTIVE"].includes(connection.status)
        || !Number.isSafeInteger(connection.statusVersion)) {
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

    async addProfileChannel(raw = {}) {
      const input = closed(raw, new Set(["actor", "profileId", "profileVersion", "connectionId", "connectionVersion", "displayName"]));
      const accountId = actorScope(input.actor);
      return safeChannel(await repository.addProfileChannel({ accountId, actorAccountId: accountId,
        profileId: text(input.profileId), profileVersion: version(input.profileVersion),
        connectionId: text(input.connectionId), connectionVersion: version(input.connectionVersion),
        displayName: text(input.displayName, { maximum: 200, pattern: null }) }));
    },

    async setProfileChannelEnabled(raw = {}) {
      const input = closed(raw, new Set(["actor", "profileId", "profileVersion", "channelId", "enabled"]));
      const accountId = actorScope(input.actor);
      if (typeof input.enabled !== "boolean") throw settingsError("AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID");
      return safeChannel(await repository.setProfileChannelEnabled({ accountId, actorAccountId: accountId,
        profileId: text(input.profileId), profileVersion: version(input.profileVersion), channelId: text(input.channelId),
        enabled: input.enabled }));
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
