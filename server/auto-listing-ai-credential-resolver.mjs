const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const CATALOG_SYNC_LEASE_KEYS = new Set([
  "accountId", "leaseToken", "leaseVersion", "minimumLeaseRemainingMs", "taskId", "workerId",
]);

function resolverError(code) {
  const error = new Error(code === "AI_GATEWAY_REQUEST_INVALID"
    ? "AI 网关密钥范围无效"
    : "AI 网关密钥未配置");
  error.code = code;
  error.retryable = false;
  return error;
}

function catalogResolverError(code, retryable = false) {
  const error = new Error(code === "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE"
    ? "AI 网关连接已变更"
    : code === "AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT"
      ? "AI 模型目录同步租约已失效"
      : "AI 网关密钥未配置");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function normalizedScope(value) {
  try {
    const fields = dataFields(value);
    const accountId = fields?.accountId;
    const connectionId = fields?.connectionId;
    const connectionVersion = fields?.connectionVersion;
    if (typeof accountId !== "string" || accountId !== accountId.trim() || !SAFE_ID.test(accountId)
      || typeof connectionId !== "string" || connectionId !== connectionId.trim() || !SAFE_ID.test(connectionId)
      || !Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
      throw resolverError("AI_GATEWAY_REQUEST_INVALID");
    }
    return Object.freeze({ accountId, connectionId, connectionVersion });
  } catch {
    throw resolverError("AI_GATEWAY_REQUEST_INVALID");
  }
}

function dataFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, "value") || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      return null;
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function normalizedCatalogSyncLease(value) {
  try {
    const fields = dataFields(value);
    if (!fields || Object.keys(fields).length !== CATALOG_SYNC_LEASE_KEYS.size
      || Object.keys(fields).some((key) => !CATALOG_SYNC_LEASE_KEYS.has(key))
      || typeof fields.accountId !== "string" || fields.accountId !== fields.accountId.trim()
      || !SAFE_ID.test(fields.accountId)
      || typeof fields.taskId !== "string" || fields.taskId !== fields.taskId.trim()
      || !SAFE_ID.test(fields.taskId)
      || typeof fields.workerId !== "string" || fields.workerId !== fields.workerId.trim()
      || !SAFE_ID.test(fields.workerId)
      || typeof fields.leaseToken !== "string" || fields.leaseToken !== fields.leaseToken.trim()
      || !SAFE_ID.test(fields.leaseToken)
      || !Number.isSafeInteger(fields.leaseVersion) || fields.leaseVersion < 1
      || !Number.isSafeInteger(fields.minimumLeaseRemainingMs)
      || fields.minimumLeaseRemainingMs < 15_001 || fields.minimumLeaseRemainingMs > 75_000) {
      throw catalogResolverError("AI_GATEWAY_REQUEST_INVALID");
    }
    return Object.freeze({
      accountId: fields.accountId,
      taskId: fields.taskId,
      workerId: fields.workerId,
      leaseVersion: fields.leaseVersion,
      leaseToken: fields.leaseToken,
      minimumLeaseRemainingMs: fields.minimumLeaseRemainingMs,
    });
  } catch {
    throw catalogResolverError("AI_GATEWAY_REQUEST_INVALID");
  }
}

function errorCode(error) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
      ? descriptor.value : "";
  } catch { return ""; }
}

function exactCatalogSyncConnection(connection, accountId) {
  try {
    const fields = dataFields(connection);
    const encryptedSecret = dataFields(fields?.encryptedSecret);
    if (!fields || !encryptedSecret || fields.accountId !== accountId
      || typeof fields.id !== "string" || fields.id !== fields.id.trim() || !SAFE_ID.test(fields.id)
      || !Number.isSafeInteger(fields.version) || fields.version < 1
      || typeof fields.baseUrl !== "string" || fields.baseUrl !== fields.baseUrl.trim() || !fields.baseUrl
      || !["PENDING", "VALIDATED", "ACTIVE"].includes(fields.status)) return null;
    return {
      connection: Object.freeze({
        id: fields.id,
        accountId: fields.accountId,
        version: fields.version,
        baseUrl: fields.baseUrl,
        status: fields.status,
      }),
      encryptedSecret: fields.encryptedSecret,
    };
  } catch { return null; }
}

function exactEncryptedSecret(connection, scope) {
  try {
    const fields = dataFields(connection);
    const encryptedSecret = dataFields(fields?.encryptedSecret);
    if (!fields || !encryptedSecret
      || fields.accountId !== scope.accountId
      || fields.id !== scope.connectionId
      || fields.version !== scope.connectionVersion
      || !["VALIDATED", "ACTIVE", "RETIRED"].includes(fields.status)) return null;
    return fields.encryptedSecret;
  } catch {
    return null;
  }
}

export function createAutoListingAiCredentialResolver({ repository, cipher } = {}) {
  if (typeof repository?.loadConnectionForSecretResolution !== "function"
    || typeof cipher?.decrypt !== "function") {
    throw new TypeError("AI gateway credential repository and cipher are required");
  }

  return Object.freeze({
    async resolveSecret(rawScope = {}) {
      const scope = normalizedScope(rawScope);
      let connection;
      try {
        connection = await repository.loadConnectionForSecretResolution(scope);
      } catch {
        throw resolverError("AI_GATEWAY_SECRET_MISSING");
      }
      const encryptedSecret = exactEncryptedSecret(connection, scope);
      if (!encryptedSecret) throw resolverError("AI_GATEWAY_SECRET_MISSING");
      try {
        const plaintext = cipher.decrypt(scope, encryptedSecret);
        const secret = typeof plaintext === "string" ? plaintext.trim() : "";
        if (!secret) throw resolverError("AI_GATEWAY_SECRET_MISSING");
        return secret;
      } catch {
        throw resolverError("AI_GATEWAY_SECRET_MISSING");
      }
    },
  });
}

export function createAutoListingAiCatalogSyncCredentialResolver({ repository, cipher } = {}) {
  if (typeof repository?.loadCatalogSyncConnectionForSecretResolution !== "function"
    || typeof cipher?.decrypt !== "function") {
    throw new TypeError("catalog sync credential repository and cipher are required");
  }

  return Object.freeze({
    async resolveCredential(rawLease = {}) {
      const lease = normalizedCatalogSyncLease(rawLease);
      let loaded;
      try {
        loaded = await repository.loadCatalogSyncConnectionForSecretResolution(lease);
      } catch (error) {
        const code = errorCode(error);
        if (code === "AUTO_LISTING_AI_SETTINGS_CATALOG_LEASE_CONFLICT") {
          throw catalogResolverError("AUTO_LISTING_AI_MODEL_SYNC_LEASE_CONFLICT");
        }
        if (code === "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT") {
          throw catalogResolverError("AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
        }
        if (code === "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED") {
          throw catalogResolverError(code, true);
        }
        throw catalogResolverError("AI_GATEWAY_SECRET_MISSING");
      }
      const exact = exactCatalogSyncConnection(loaded, lease.accountId);
      if (!exact) throw catalogResolverError("AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE");
      try {
        const plaintext = await cipher.decrypt({
          accountId: exact.connection.accountId,
          connectionId: exact.connection.id,
          connectionVersion: exact.connection.version,
        }, exact.encryptedSecret);
        const secret = typeof plaintext === "string" ? plaintext.trim() : "";
        if (!secret) throw catalogResolverError("AI_GATEWAY_SECRET_MISSING");
        return Object.freeze({ connection: exact.connection, secret });
      } catch {
        throw catalogResolverError("AI_GATEWAY_SECRET_MISSING");
      }
    },
  });
}
