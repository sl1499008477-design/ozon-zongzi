const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

function resolverError(code) {
  const error = new Error(code === "AI_GATEWAY_REQUEST_INVALID"
    ? "AI 网关密钥范围无效"
    : "AI 网关密钥未配置");
  error.code = code;
  error.retryable = false;
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

function exactEncryptedSecret(connection, scope) {
  try {
    const fields = dataFields(connection);
    const encryptedSecret = dataFields(fields?.encryptedSecret);
    if (!fields || !encryptedSecret
      || fields.accountId !== scope.accountId
      || fields.id !== scope.connectionId
      || fields.version !== scope.connectionVersion
      || fields.status !== "ACTIVE") return null;
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
