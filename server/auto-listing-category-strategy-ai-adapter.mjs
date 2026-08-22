import { types } from "node:util";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ROLES = Object.freeze([
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
]);
const MAX_BILINGUAL_TEXT_LENGTH = 500;
const MAX_PATTERN_ITEMS = 10;

function failure(code, status = 503, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function invalid() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_ADAPTER_INVALID", 400);
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
    if (error?.code) throw error;
    throw invalid();
  }
}

function id(value) {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_ID.test(value)) throw invalid();
  return value;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function execution(raw) {
  const value = closed(raw, new Set([
    "accountId", "analyzerVersion", "promptVersion", "profileId", "profileVersion", "model",
  ]));
  return Object.freeze({
    accountId: id(value.accountId), analyzerVersion: id(value.analyzerVersion),
    promptVersion: id(value.promptVersion), profileId: id(value.profileId),
    profileVersion: positive(value.profileVersion), model: id(value.model),
  });
}

function profile(row, expected) {
  const result = Object.freeze({
    id: row?.id,
    accountId: row?.account_id,
    configVersion: Number(row?.config_version),
    baseUrl: row?.base_url,
    apiKeyEnvName: row?.api_key_env_name,
    textProtocol: row?.text_protocol,
    imageProtocol: row?.image_protocol,
    textModel: row?.text_model,
    imageModel: row?.image_model,
    enabled: row?.enabled === true,
    connectionId: row?.connection_id,
    connectionVersion: row?.connection_version == null ? null : Number(row.connection_version),
  });
  if (result.accountId !== expected.accountId || result.id !== expected.profileId
    || result.configVersion !== expected.profileVersion || result.textModel !== expected.model
    || result.enabled !== true) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_CONFIGURATION_CHANGED", 409);
  }
  return result;
}

function bilingualTextSchema() {
  return {
    type: "object",
    properties: {
      ru: { type: "string", minLength: 1, maxLength: MAX_BILINGUAL_TEXT_LENGTH },
      zh: { type: "string", minLength: 1, maxLength: MAX_BILINGUAL_TEXT_LENGTH },
    },
    required: ["ru", "zh"],
    additionalProperties: false,
  };
}

function roleSchema(evidenceIds) {
  return {
    type: "object",
    properties: {
      composition: bilingualTextSchema(),
      background: bilingualTextSchema(),
      textDensity: { type: "string", enum: ["NONE", "LIGHT", "MEDIUM", "HEAVY"] },
      layout: bilingualTextSchema(),
      evidenceIds: { type: "array", minItems: 1, maxItems: 20,
        items: { type: "string", enum: evidenceIds } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["composition", "background", "textDensity", "layout", "evidenceIds", "confidence"],
    additionalProperties: false,
  };
}

function analysisSchema(evidenceIds) {
  return {
    type: "object",
    properties: {
      schemaVersion: { type: "integer", const: 3 },
      style: bilingualTextSchema(),
      roleGuidance: {
        type: "object",
        properties: Object.fromEntries(ROLES.map((role) => [role, roleSchema(evidenceIds)])),
        required: [...ROLES],
        additionalProperties: false,
      },
      commonPatterns: {
        type: "array", maxItems: MAX_PATTERN_ITEMS,
        items: {
          type: "object",
          properties: {
            pattern: bilingualTextSchema(),
            evidenceIds: { type: "array", minItems: 1, maxItems: 20,
              items: { type: "string", enum: evidenceIds } },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["pattern", "evidenceIds", "confidence"],
          additionalProperties: false,
        },
      },
      differences: {
        type: "array", maxItems: MAX_PATTERN_ITEMS,
        items: {
          type: "object",
          properties: {
            pattern: bilingualTextSchema(),
            evidenceIds: { type: "array", minItems: 1, maxItems: 20,
              items: { type: "string", enum: evidenceIds } },
          },
          required: ["pattern", "evidenceIds"],
          additionalProperties: false,
        },
      },
      cautions: { type: "array", maxItems: MAX_PATTERN_ITEMS,
        items: bilingualTextSchema() },
    },
    required: ["schemaVersion", "style", "roleGuidance", "commonPatterns", "differences", "cautions"],
    additionalProperties: false,
  };
}

function promptFor(request) {
  const evidence = request.images.map((image) => ({
    evidenceId: image.evidenceId, sku: image.sku, role: image.role, ordinal: image.ordinal,
  }));
  return [
    "Analyze only the supplied product images for one exact Ozon category.",
    `Category scope: ${JSON.stringify(request.scope)}.`,
    `Evidence manifest: ${JSON.stringify(evidence)}.`,
    "Return each concise, actionable recommendation as one paired object: Russian in ru and Simplified Chinese in zh.",
    "The ru and zh values must express the same recommendation; do not create separate conclusions by language.",
    "Russian is the marketplace execution language. Simplified Chinese is a read-only management explanation.",
    "Every role and every common pattern must cite evidenceIds belonging to at least two distinct SKUs.",
    "Use only declared evidenceIds. Describe patterns, not individual brands or copied claims.",
    "Do not recommend image counts, role counts, future generation steps, or copying competitor branding.",
  ].join("\n");
}

export function createCategoryStrategyAnalysisAiAdapter({ pool, getGateway } = {}) {
  if (!pool || typeof pool.query !== "function" || typeof getGateway !== "function") {
    throw new TypeError("Category strategy analysis AI adapter dependencies are required");
  }

  async function loadProfile(expected) {
    const result = await pool.query(
      `SELECT id,account_id,config_version,base_url,api_key_env_name,text_protocol,image_protocol,
              text_model,image_model,enabled,connection_id,connection_version
         FROM ai_gateway_profiles
        WHERE account_id=$1 AND id=$2 AND config_version=$3 AND text_model=$4 AND enabled IS TRUE
        LIMIT 2`,
      [expected.accountId, expected.profileId, expected.profileVersion, expected.model],
    );
    if (!Array.isArray(result?.rows) || result.rows.length !== 1) {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_CONFIGURATION_CHANGED", 409);
    }
    return profile(result.rows[0], expected);
  }

  return Object.freeze({
    async assertReady(raw = {}) {
      const input = closed(raw, new Set(["accountId", "configuration"]));
      const config = closed(input.configuration, new Set([
        "analyzerVersion", "promptVersion", "profileId", "profileVersion", "model",
      ]));
      const expected = execution({ accountId: id(input.accountId),
        analyzerVersion: config.analyzerVersion, promptVersion: config.promptVersion,
        profileId: config.profileId, profileVersion: config.profileVersion, model: config.model });
      await loadProfile(expected);
    },

    async analyze(raw = {}) {
      const request = closed(raw, new Set([
        "attemptId", "requestKey", "execution", "scope", "productFacts", "images", "contract",
      ]));
      const expected = execution(request.execution);
      const attemptId = id(request.attemptId);
      if (typeof request.requestKey !== "string" || !HASH.test(request.requestKey)
        || !Array.isArray(request.images) || request.images.length < 1) throw invalid();
      const activeProfile = await loadProfile(expected);
      const gateway = await getGateway();
      if (!gateway || typeof gateway.createTextResponse !== "function") {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY", 503, true);
      }
      const evidenceIds = request.images.map((image) => id(image.evidenceId));
      const sourceImages = request.images.map((image) => ({
        bytes: Buffer.from(image.bytesBase64, "base64"),
        contentType: image.contentType,
      }));
      const response = await gateway.createTextResponse({
        profile: activeProfile,
        model: expected.model,
        prompt: promptFor(request),
        sourceImages,
        jsonSchema: analysisSchema(evidenceIds),
        correlationId: attemptId,
        requestKey: request.requestKey,
        timeoutMs: 300_000,
      });
      if (!response || typeof response !== "object" || !Object.hasOwn(response, "value")) {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_AI_OUTPUT_INVALID", 502, true);
      }
      return response.value;
    },

    async recover(raw = {}) {
      const request = closed(raw, new Set(["attemptId", "requestKey", "execution"]));
      id(request.attemptId);
      execution(request.execution);
      if (typeof request.requestKey !== "string" || !HASH.test(request.requestKey)) throw invalid();
      throw Object.assign(new Error("AI response state is unknown"), {
        code: "AI_RESPONSE_UNKNOWN", retryable: true,
      });
    },
  });
}
