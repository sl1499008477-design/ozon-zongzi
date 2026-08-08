import crypto from "node:crypto";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const REQUIRED_FEATURES = new Set(["STRUCTURED_TEXT", "IMAGE_GENERATION"]);
const DECODE_FEATURES = new Set(["IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP"]);
const ALLOWED_FEATURES = new Set([...REQUIRED_FEATURES, ...DECODE_FEATURES]);
const SAFE_GATEWAY_ERROR_CODES = new Set([
  "AI_GATEWAY_CAPABILITY_FAILED",
  "AI_GATEWAY_PROFILE_INVALID",
  "AI_GATEWAY_PROFILE_DISABLED",
  "AI_GATEWAY_REQUEST_INVALID",
  "AI_GATEWAY_SECRET_MISSING",
  "AI_GATEWAY_PROTOCOL_UNSUPPORTED",
  "AI_GATEWAY_MODEL_MISMATCH",
  "AI_GATEWAY_INPUT_UNSUPPORTED",
  "GATEWAY_REDIRECT_BLOCKED",
  "GATEWAY_TIMEOUT",
  "GATEWAY_CANCELLED",
  "RETRYABLE_GATEWAY",
  "NON_RETRYABLE_AUTH",
  "NON_RETRYABLE_GATEWAY",
  "INVALID_GATEWAY_RESPONSE",
]);

function clean(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function serviceError(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function requireDependencies(repository, gateway) {
  if (!repository || typeof repository.beginCapabilityTest !== "function"
    || typeof repository.completeCapabilityTest !== "function") {
    throw new TypeError("AI gateway profile repository is required");
  }
  if (!gateway || typeof gateway.testCapabilities !== "function") {
    throw new TypeError("AI gateway port is required");
  }
}

function normalizedProfile(row) {
  const result = {
    id: clean(row?.id),
    accountId: clean(row?.accountId ?? row?.account_id),
    configVersion: Number(row?.configVersion ?? row?.config_version),
    baseUrl: clean(row?.baseUrl ?? row?.base_url, 2048),
    apiKeyEnvName: clean(row?.apiKeyEnvName ?? row?.api_key_env_name),
    textProtocol: clean(row?.textProtocol ?? row?.text_protocol),
    imageProtocol: clean(row?.imageProtocol ?? row?.image_protocol),
    textModel: clean(row?.textModel ?? row?.text_model),
    imageModel: clean(row?.imageModel ?? row?.image_model),
    enabled: row?.enabled === true,
  };
  if (!result.id || !result.accountId || !Number.isInteger(result.configVersion) || result.configVersion < 1
    || !result.baseUrl || !result.apiKeyEnvName || !result.textModel || !result.imageModel) {
    throw serviceError("AI_GATEWAY_PROFILE_INVALID");
  }
  return result;
}

function validateCapabilityResult(result, profile) {
  const features = Array.isArray(result?.features) ? [...new Set(result.features.map((value) => clean(value)))] : [];
  const validFeatures = features.length === 3
    && features.every((feature) => ALLOWED_FEATURES.has(feature))
    && [...REQUIRED_FEATURES].every((feature) => features.includes(feature))
    && features.some((feature) => DECODE_FEATURES.has(feature));
  const latencyMs = result?.latencyMs;
  const models = result?.models;
  const modelEvidence = result?.modelEvidence;
  const requestedImageModel = clean(modelEvidence?.requestedImageModel);
  const gatewayReportedImageModel = clean(modelEvidence?.gatewayReportedImageModel);
  const gatewayReportedImageModelPresent = modelEvidence?.gatewayReportedImageModelPresent === true;
  if (!validFeatures || !Number.isFinite(latencyMs) || latencyMs < 0
    || clean(models?.text) !== profile.textModel || clean(models?.image) !== profile.imageModel
    || requestedImageModel !== profile.imageModel
    || gatewayReportedImageModelPresent !== Boolean(gatewayReportedImageModel)
    || (gatewayReportedImageModel && gatewayReportedImageModel !== profile.imageModel)) {
    throw serviceError("INVALID_GATEWAY_RESPONSE");
  }
  return {
    features,
    latencyMs: Math.round(latencyMs),
    models: { text: profile.textModel, image: profile.imageModel },
  };
}

function attemptId(accountId, profileId, configVersion, correlationId) {
  return `ai_capability_${crypto.createHash("sha256")
    .update(`ai-gateway-capability-attempt\0${accountId}\0${profileId}\0${configVersion}\0${correlationId}`)
    .digest("hex").slice(0, 40)}`;
}

function requestKey(accountId, profileId, configVersion, capabilityAttemptId) {
  return crypto.createHash("sha256")
    .update(`ai-gateway-capability\0${accountId}\0${profileId}\0${configVersion}\0${capabilityAttemptId}`)
    .digest("hex");
}

function persistedResponse(value, profile) {
  const keys = ["profileId", "configVersion", "outcome", "features", "latencyMs", "models", "checkedAt", "errorCode", "enabled"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.profileId !== profile.id || value.configVersion !== profile.configVersion
    || typeof value.enabled !== "boolean" || Number.isNaN(Date.parse(value.checkedAt))) {
    throw serviceError("INVALID_GATEWAY_RESPONSE");
  }
  if (value.outcome === "PASSED") {
    validateCapabilityResult({ ...value, modelEvidence: {
      requestedImageModel: profile.imageModel,
      gatewayReportedImageModel: "",
      gatewayReportedImageModelPresent: false,
    } }, profile);
    if (value.errorCode !== null) throw serviceError("INVALID_GATEWAY_RESPONSE");
  } else if (value.outcome !== "FAILED" || !Array.isArray(value.features) || value.features.length !== 0
    || value.latencyMs !== null || value.models?.text !== profile.textModel || value.models?.image !== profile.imageModel
    || !SAFE_GATEWAY_ERROR_CODES.has(value.errorCode)) {
    throw serviceError("INVALID_GATEWAY_RESPONSE");
  }
  return structuredClone(value);
}

function safeErrorCode(error) {
  const code = clean(error?.code);
  return SAFE_GATEWAY_ERROR_CODES.has(code) ? code : "AI_GATEWAY_CAPABILITY_FAILED";
}

function safeLog(logger, event, fields) {
  if (typeof logger?.info !== "function") return;
  try {
    const pending = logger.info(event, {
      accountId: clean(fields.accountId),
      profileId: clean(fields.profileId),
      configVersion: Number(fields.configVersion) || null,
      outcome: clean(fields.outcome),
      errorCode: clean(fields.errorCode),
    });
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // Capability persistence is authoritative; logging is best-effort only.
  }
}
export function createAiGatewayProfileService({ repository, gateway, now = () => new Date(), logger = null } = {}) {
  requireDependencies(repository, gateway);
  return Object.freeze({
    async testGatewayCapabilities(input = {}) {
      assertPermission(input.actor, PERMISSIONS.AI_CONTENT_MANAGE);
      const accountId = clean(input.actor.id);
      const profileId = clean(input.profileId);
      const configVersion = Number(input.configVersion);
      const correlationId = clean(input.correlationId);
      if (!accountId || !profileId || !Number.isInteger(configVersion) || configVersion < 1 || !correlationId) {
        throw serviceError("AI_GATEWAY_CAPABILITY_REQUEST_INVALID");
      }
      const capabilityAttemptId = attemptId(accountId, profileId, configVersion, correlationId);
      const begun = await repository.beginCapabilityTest({
        accountId, actorId: accountId, profileId, configVersion, correlationId,
        attemptId: capabilityAttemptId,
      });
      if (!begun) throw serviceError("AI_GATEWAY_PROFILE_NOT_FOUND", 404);
      const profile = normalizedProfile(begun.profile);
      if (profile.accountId !== accountId || profile.id !== profileId || profile.configVersion !== configVersion) {
        throw serviceError("AI_GATEWAY_PROFILE_NOT_FOUND", 404);
      }
      const validAttemptIdentity = begun.attemptId === capabilityAttemptId
        && Number.isSafeInteger(Number(begun.fence)) && Number(begun.fence) >= 1;
      if (!validAttemptIdentity) throw serviceError("AI_GATEWAY_CAPABILITY_IN_PROGRESS", 409, true);
      if (["PASSED", "FAILED"].includes(begun.status)) return persistedResponse(begun.response, profile);
      if (begun.status === "STALE") throw serviceError("AI_GATEWAY_PROFILE_VERSION_CONFLICT", 409, false);
      const leaseVersion = Number(begun.leaseVersion);
      const leaseToken = clean(begun.leaseToken);
      if (begun.status !== "RUNNING" || begun.duplicate === true
        || !Number.isSafeInteger(leaseVersion) || leaseVersion < 1 || !leaseToken
        || Number.isNaN(Date.parse(begun.leaseExpiresAt))) {
        throw serviceError("AI_GATEWAY_CAPABILITY_IN_PROGRESS", 409, true);
      }

      const checkedAt = now().toISOString();
      let capabilityResult;
      try {
        const raw = await gateway.testCapabilities({
          profile,
          correlationId,
          requestKey: requestKey(accountId, profileId, configVersion, capabilityAttemptId),
          timeoutMs: 120_000,
          signal: input.signal,
        });
        const verified = validateCapabilityResult(raw, profile);
        capabilityResult = {
          outcome: "PASSED",
          ...verified,
          checkedAt,
          errorCode: null,
        };
      } catch (error) {
        capabilityResult = {
          outcome: "FAILED",
          features: [],
          latencyMs: null,
          models: { text: profile.textModel, image: profile.imageModel },
          checkedAt,
          errorCode: safeErrorCode(error),
        };
      }

      const saved = await repository.completeCapabilityTest({
        accountId, actorId: accountId, profileId, configVersion, correlationId,
        attemptId: capabilityAttemptId, fence: Number(begun.fence),
        leaseVersion, leaseToken,
        capabilityResult,
      });
      if (saved?.applied !== true || saved?.stale === true) {
        throw serviceError("AI_GATEWAY_PROFILE_VERSION_CONFLICT", 409, false);
      }
      const response = persistedResponse(saved.response, profile);
      safeLog(logger, "ai_gateway.capability_test_completed", {
        accountId,
        profileId,
        configVersion,
        outcome: capabilityResult.outcome,
        errorCode: capabilityResult.errorCode,
      });
      return response;
    },
  });
}
