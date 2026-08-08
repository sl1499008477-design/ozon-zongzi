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
  const accountId = typeof value?.accountId === "string" ? value.accountId.trim() : "";
  const connectionId = typeof value?.connectionId === "string" ? value.connectionId.trim() : "";
  const connectionVersion = value?.connectionVersion;
  if (!SAFE_ID.test(accountId) || !SAFE_ID.test(connectionId)
    || !Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
    throw resolverError("AI_GATEWAY_REQUEST_INVALID");
  }
  return Object.freeze({ accountId, connectionId, connectionVersion });
}

function exactConnection(connection, scope) {
  return connection
    && connection.accountId === scope.accountId
    && connection.id === scope.connectionId
    && connection.version === scope.connectionVersion
    && connection.status === "ACTIVE"
    && connection.encryptedSecret
    && typeof connection.encryptedSecret === "object"
    && !Array.isArray(connection.encryptedSecret);
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
      if (!exactConnection(connection, scope)) throw resolverError("AI_GATEWAY_SECRET_MISSING");
      try {
        const plaintext = cipher.decrypt(scope, connection.encryptedSecret);
        const secret = typeof plaintext === "string" ? plaintext.trim() : "";
        if (!secret) throw resolverError("AI_GATEWAY_SECRET_MISSING");
        return secret;
      } catch {
        throw resolverError("AI_GATEWAY_SECRET_MISSING");
      }
    },
  });
}
