import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import {
  createSub2ApiGatewayPolicy,
  normalizeSub2ApiGatewayBaseUrl,
  requireSub2ApiGatewayPolicy,
  verifySub2ApiGatewayDnsBoundary,
} from "./sub2api-gateway-boundary.mjs";
import { normalizeAutoListingTextDensityByRole } from "./auto-listing-text-density-contract.mjs";

const PROFILE_KEYS = new Set([
  "displayName", "baseUrl", "apiKeyEnvName", "textProtocol", "imageProtocol", "textModel", "imageModel",
]);
const MATCH_TYPES = new Set(["EXACT_CATEGORY", "ANCESTOR_CATEGORY", "PRODUCT_STYLE"]);
const STYLES = new Set([
  "VISUAL_FIRST", "PARAMETER_FIRST", "DEMONSTRATION_FIRST", "SPECIFICATION_FIRST", "BALANCED_DEFAULT",
]);
const IMAGE_PROTOCOLS = new Set(["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"]);
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,159}$/;
const SAFE_CAPABILITY_ERROR_CODES = new Set([
  "PERMISSION_FORBIDDEN", "AI_GATEWAY_CAPABILITY_REQUEST_INVALID", "AI_GATEWAY_PROFILE_NOT_FOUND",
  "AI_GATEWAY_PROFILE_INVALID", "AI_GATEWAY_PROFILE_VERSION_CONFLICT", "AI_GATEWAY_CAPABILITY_IN_PROGRESS",
  "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", "AUTO_LISTING_AI_ADMIN_REPOSITORY_INVALID",
]);
const SAFE_CAPABILITY_RESULT_ERROR_CODES = new Set([
  "AI_GATEWAY_CAPABILITY_FAILED", "AI_GATEWAY_PROFILE_INVALID", "AI_GATEWAY_PROFILE_DISABLED",
  "AI_GATEWAY_REQUEST_INVALID", "AI_GATEWAY_SECRET_MISSING", "AI_GATEWAY_PROTOCOL_UNSUPPORTED",
  "AI_GATEWAY_MODEL_MISMATCH", "AI_GATEWAY_INPUT_UNSUPPORTED", "GATEWAY_REDIRECT_BLOCKED",
  "GATEWAY_TIMEOUT", "GATEWAY_CANCELLED", "RETRYABLE_GATEWAY", "NON_RETRYABLE_AUTH",
  "NON_RETRYABLE_GATEWAY", "INVALID_GATEWAY_RESPONSE",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

function adminError(code, status = 422, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function closedObject(value, keys, errorCode) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw adminError(errorCode);
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw adminError(errorCode);
    }
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw adminError(errorCode);
  }
}

function text(value, { max = 240, pattern = SAFE_IDENTIFIER, code = "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID" } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max || (pattern && !pattern.test(normalized))) throw adminError(code);
  return normalized;
}

function positiveVersion(value, code = "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID") {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_646) throw adminError(code);
  return value;
}

function actorScope(actor) {
  assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
  return text(actor.id);
}

function safeJson(value, code) {
  const active = new WeakSet();
  let bytes = 0;
  const visit = (nested) => {
    if (nested === null || typeof nested === "boolean") return nested;
    if (typeof nested === "string") {
      bytes += Buffer.byteLength(nested, "utf8");
      if (bytes > 65_536) throw adminError(code);
      return nested;
    }
    if (typeof nested === "number") {
      if (!Number.isFinite(nested)) throw adminError(code);
      return nested;
    }
    if (!nested || typeof nested !== "object" || active.has(nested)) throw adminError(code);
    active.add(nested);
    try {
      if (Array.isArray(nested)) return nested.map(visit);
      if (![Object.prototype, null].includes(Object.getPrototypeOf(nested))) throw adminError(code);
      const keys = Reflect.ownKeys(nested);
      const descriptors = Object.getOwnPropertyDescriptors(nested);
      const output = {};
      for (const key of keys) {
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
          || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")) throw adminError(code);
        output[key] = visit(descriptors[key].value);
      }
      return output;
    } finally {
      active.delete(nested);
    }
  };
  return visit(value);
}

function normalizeBaseUrl(value, allowLocalGateway) {
  try {
    return normalizeSub2ApiGatewayBaseUrl(value, { allowLocalGateway });
  } catch {
    throw adminError("AUTO_LISTING_AI_ADMIN_PROFILE_INVALID");
  }
}

function normalizeProfile(raw, { allowLocalGateway, gatewayPolicy }) {
  const code = "AUTO_LISTING_AI_ADMIN_PROFILE_INVALID";
  const value = closedObject(raw, PROFILE_KEYS, code);
  const displayName = text(value.displayName, { max: 160, pattern: null, code });
  const apiKeyEnvName = text(value.apiKeyEnvName, {
    max: 120, pattern: /^SUB2API_[A-Z0-9]+(?:_[A-Z0-9]+)*_KEY$/, code,
  });
  const textProtocol = text(value.textProtocol, { max: 80, code });
  const imageProtocol = text(value.imageProtocol, { max: 80, code });
  if (textProtocol !== "SUB2API_RESPONSES" || !IMAGE_PROTOCOLS.has(imageProtocol)) throw adminError(code);
  const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
  const profile = {
    displayName,
    baseUrl: normalizeBaseUrl(value.baseUrl, allowLocalGateway),
    apiKeyEnvName,
    textProtocol,
    imageProtocol,
    textModel: text(value.textModel, { max: 160, pattern: modelPattern, code }),
    imageModel: text(value.imageModel, { max: 160, pattern: modelPattern, code }),
    configVersion: 1,
  };
  try {
    requireSub2ApiGatewayPolicy(profile, gatewayPolicy);
  } catch {
    throw adminError(code);
  }
  return profile;
}

function maskEnvironmentName(value) {
  const envName = typeof value === "string" ? value.trim() : "";
  return envName.length >= 8 ? `${envName.slice(0, 4)}…${envName.slice(-4)}` : "已配置";
}

function profileDto(row, accountId, { allowLocalGateway }) {
  const rowAccountId = text(row?.accountId ?? row?.account_id);
  if (rowAccountId !== accountId) throw adminError("AUTO_LISTING_AI_ADMIN_DATA_BOUNDARY", 500);
  const capability = row?.capabilityResult ?? row?.capability_result;
  const rawConnectionId = row?.connectionId ?? row?.connection_id ?? null;
  const rawConnectionVersion = row?.connectionVersion ?? row?.connection_version ?? null;
  if ((rawConnectionId === null) !== (rawConnectionVersion === null)) {
    throw adminError("AUTO_LISTING_AI_ADMIN_DATA_BOUNDARY", 500);
  }
  const outcome = ["PASSED", "FAILED"].includes(capability?.outcome) ? capability.outcome : null;
  const dto = {
    id: text(row?.id),
    displayName: text(row?.displayName ?? row?.display_name, { max: 160, pattern: null }),
    configVersion: positiveVersion(Number(row?.configVersion ?? row?.config_version)),
    baseUrl: normalizeBaseUrl(row?.baseUrl ?? row?.base_url, allowLocalGateway),
    apiKeyEnvNameMasked: maskEnvironmentName(row?.apiKeyEnvName ?? row?.api_key_env_name),
    textProtocol: text(row?.textProtocol ?? row?.text_protocol, { max: 80 }),
    imageProtocol: text(row?.imageProtocol ?? row?.image_protocol, { max: 80 }),
    textModel: text(row?.textModel ?? row?.text_model, { max: 160, pattern: null }),
    imageModel: text(row?.imageModel ?? row?.image_model, { max: 160, pattern: null }),
    enabled: row?.enabled === true,
    connectionId: rawConnectionId === null ? null : text(rawConnectionId),
    connectionVersion: rawConnectionVersion === null ? null : positiveVersion(Number(rawConnectionVersion)),
    capabilityOutcome: outcome,
    capabilityCheckedAt: row?.capabilityCheckedAt ?? row?.capability_checked_at ?? null,
    createdAt: row?.createdAt ?? row?.created_at ?? null,
  };
  if (typeof row?.duplicate === "boolean") dto.duplicate = row.duplicate;
  return dto;
}

function normalizeRule(raw) {
  const code = "AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw adminError(code);
  const matchType = raw.matchType;
  if (!MATCH_TYPES.has(matchType)) throw adminError(code);
  const keys = new Set(["ruleId", "ruleOrder", "matchType", "style", "textDensityByRole",
    matchType === "PRODUCT_STYLE" ? "productStyle" : "categoryId"]);
  const value = closedObject(raw, keys, code);
  if (!STYLES.has(value.style) || !Number.isInteger(value.ruleOrder) || value.ruleOrder < 1) throw adminError(code);
  const output = {
    ruleId: text(value.ruleId, { code }),
    ruleOrder: value.ruleOrder,
    matchType,
    style: value.style,
    textDensityByRole: normalizeAutoListingTextDensityByRole(value.textDensityByRole, { errorCode: code }),
  };
  if (matchType === "PRODUCT_STYLE") output.productStyle = text(value.productStyle, { code });
  else output.categoryId = text(value.categoryId, { code });
  return output;
}

function normalizeStrategy(input) {
  const code = "AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID";
  const content = closedObject(input.content, new Set(["schemaVersion"]), code);
  if (content.schemaVersion !== "V1" || !Array.isArray(input.rules) || input.rules.length > 1_000) throw adminError(code);
  const rules = input.rules.map(normalizeRule);
  const ids = new Set();
  const orders = new Set();
  for (const rule of rules) {
    if (ids.has(rule.ruleId) || orders.has(rule.ruleOrder)) throw adminError(code);
    ids.add(rule.ruleId);
    orders.add(rule.ruleOrder);
  }
  return { content: { schemaVersion: "V1" }, rules };
}

function safeCapabilityResult(result) {
  const outcome = result?.outcome;
  const features = Array.isArray(result?.features)
    ? result.features.filter((value) => typeof value === "string" && SAFE_ERROR_CODE.test(value)) : [];
  return {
    profileId: text(result?.profileId),
    configVersion: positiveVersion(Number(result?.configVersion)),
    outcome: ["PASSED", "FAILED"].includes(outcome) ? outcome : "FAILED",
    features,
    latencyMs: Number.isFinite(result?.latencyMs) && result.latencyMs >= 0 ? result.latencyMs : null,
    models: {
      text: typeof result?.models?.text === "string" ? result.models.text.slice(0, 160) : "",
      image: typeof result?.models?.image === "string" ? result.models.image.slice(0, 160) : "",
    },
    checkedAt: typeof result?.checkedAt === "string" ? result.checkedAt : null,
    errorCode: SAFE_CAPABILITY_RESULT_ERROR_CODES.has(result?.errorCode) ? result.errorCode : null,
    publishReady: outcome === "PASSED" && features.includes("STRUCTURED_TEXT") && features.includes("IMAGE_GENERATION"),
  };
}

function strategyDto(row, accountId) {
  if (text(row?.accountId ?? row?.account_id) !== accountId) {
    throw adminError("AUTO_LISTING_AI_ADMIN_DATA_BOUNDARY", 500);
  }
  const dto = {
    id: text(row.id), strategyKey: text(row.strategyKey ?? row.strategy_key),
    version: positiveVersion(Number(row.version)), status: text(row.status),
  };
  if (row.content !== undefined) dto.content = safeJson(row.content, "AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID");
  if (row.rules !== undefined) {
    if (!Array.isArray(row.rules) || row.rules.length > 1_000) throw adminError("AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID");
    dto.rules = row.rules.map(normalizeRule);
  }
  if (typeof row.duplicate === "boolean") dto.duplicate = row.duplicate;
  return dto;
}

function requireDependencies(repository, capabilityService) {
  const methods = [
    "createProfile", "listProfiles", "publishProfile",
    "createStrategyVersion", "listStrategyVersions", "publishStrategyVersion",
  ];
  if (!repository || methods.some((method) => typeof repository[method] !== "function")) {
    throw new TypeError("Auto listing AI admin repository is required");
  }
  if (!capabilityService || typeof capabilityService.testGatewayCapabilities !== "function") {
    throw new TypeError("AI gateway capability service is required");
  }
}

export function createAutoListingAiAdminService({
  repository,
  capabilityService,
  allowLocalGateway = false,
  resolveGatewayHostname,
  allowedSecretEnvNames = [],
  allowedGatewayBaseUrls = [],
  allowedGatewayOrigins = [],
  gatewayDnsTimeoutMs = 5_000,
} = {}) {
  requireDependencies(repository, capabilityService);
  if (typeof allowLocalGateway !== "boolean"
    || !(resolveGatewayHostname === undefined || typeof resolveGatewayHostname === "function")
    || !Number.isInteger(gatewayDnsTimeoutMs) || gatewayDnsTimeoutMs < 1 || gatewayDnsTimeoutMs > 30_000) {
    throw new TypeError("Auto listing AI gateway boundary configuration is invalid");
  }
  let gatewayPolicy;
  try {
    gatewayPolicy = createSub2ApiGatewayPolicy({
      allowedSecretEnvNames, allowedGatewayBaseUrls, allowedGatewayOrigins, allowLocalGateway,
    });
  } catch {
    throw new TypeError("Auto listing AI gateway boundary configuration is invalid");
  }
  const profileOptions = Object.freeze({ allowLocalGateway, gatewayPolicy });
  return Object.freeze({
    async createGatewayProfile(raw = {}) {
      const input = closedObject(raw, new Set(["actor", "idempotencyKey", "correlationId", "profile"]),
        "AUTO_LISTING_AI_ADMIN_PROFILE_INVALID");
      const accountId = actorScope(input.actor);
      const profile = normalizeProfile(input.profile, profileOptions);
      try {
        const hostname = new URL(profile.baseUrl).hostname;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), gatewayDnsTimeoutMs);
        timer.unref?.();
        try {
          await verifySub2ApiGatewayDnsBoundary({
            hostname, allowLocalGateway, signal: controller.signal,
            ...(resolveGatewayHostname ? { resolveHostname: resolveGatewayHostname } : {}),
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (error?.code === "SUB2API_GATEWAY_DNS_FAILED" || error?.name === "TimeoutError") {
          throw adminError("AUTO_LISTING_AI_ADMIN_GATEWAY_DNS_FAILED", 503, true);
        }
        throw adminError("AUTO_LISTING_AI_ADMIN_PROFILE_INVALID");
      }
      const row = await repository.createProfile({
        accountId, actorId: accountId,
        idempotencyKey: text(input.idempotencyKey), correlationId: text(input.correlationId),
        profile,
      });
      return profileDto(row, accountId, profileOptions);
    },

    async listGatewayProfiles(raw = {}) {
      const input = closedObject(raw, new Set(["actor"]), "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
      const accountId = actorScope(input.actor);
      const rows = await repository.listProfiles({ accountId });
      return rows.map((row) => profileDto(row, accountId, profileOptions));
    },

    async testGatewayCapabilities(raw = {}) {
      const input = closedObject(raw, new Set(["actor", "profileId", "configVersion", "correlationId", "costConfirmed"]),
        "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
      const accountId = actorScope(input.actor);
      if (input.costConfirmed !== true) throw adminError("AI_GATEWAY_COST_CONFIRMATION_REQUIRED", 409);
      const profileId = text(input.profileId);
      const configVersion = positiveVersion(input.configVersion);
      const correlationId = text(input.correlationId);
      try {
        const tested = await capabilityService.testGatewayCapabilities({
          actor: input.actor, profileId, configVersion, correlationId, costConfirmed: true,
        });
        const result = safeCapabilityResult(tested);
        return result;
      } catch (error) {
        const code = SAFE_CAPABILITY_ERROR_CODES.has(error?.code)
          ? error.code : "AUTO_LISTING_AI_CAPABILITY_FAILED";
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
          ? error.status : 503;
        throw adminError(code, status, error?.retryable === true);
      }
    },

    async publishGatewayProfile(raw = {}) {
      const input = closedObject(raw,
        new Set(["actor", "profileId", "configVersion", "idempotencyKey", "correlationId"]),
        "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
      const accountId = actorScope(input.actor);
      const row = await repository.publishProfile({
        accountId, actorId: accountId, profileId: text(input.profileId),
        configVersion: positiveVersion(input.configVersion), idempotencyKey: text(input.idempotencyKey),
        correlationId: text(input.correlationId),
      });
      return profileDto(row, accountId, profileOptions);
    },

    async createStrategyVersion(raw = {}) {
      const input = closedObject(raw,
        new Set(["actor", "strategyKey", "version", "idempotencyKey", "correlationId", "content", "rules"]),
        "AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID");
      const accountId = actorScope(input.actor);
      const normalized = normalizeStrategy(input);
      const row = await repository.createStrategyVersion({
        accountId, actorId: accountId, strategyKey: text(input.strategyKey),
        version: positiveVersion(input.version, "AUTO_LISTING_AI_ADMIN_STRATEGY_INVALID"),
        idempotencyKey: text(input.idempotencyKey), correlationId: text(input.correlationId),
        ...normalized,
      });
      return strategyDto(row, accountId);
    },

    async listStrategyVersions(raw = {}) {
      const input = closedObject(raw, new Set(["actor", "strategyKey"]), "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
      const accountId = actorScope(input.actor);
      const strategyKey = text(input.strategyKey);
      const rows = await repository.listStrategyVersions({ accountId, strategyKey });
      return rows.map((row) => strategyDto(row, accountId));
    },

    async publishStrategyVersion(raw = {}) {
      const input = closedObject(raw,
        new Set(["actor", "strategyKey", "strategyVersionId", "version", "idempotencyKey", "correlationId"]),
        "AUTO_LISTING_AI_ADMIN_REQUEST_INVALID");
      const accountId = actorScope(input.actor);
      const row = await repository.publishStrategyVersion({
        accountId, actorId: accountId, strategyKey: text(input.strategyKey),
        strategyVersionId: text(input.strategyVersionId), version: positiveVersion(input.version),
        idempotencyKey: text(input.idempotencyKey), correlationId: text(input.correlationId),
      });
      return strategyDto(row, accountId);
    },
  });
}
