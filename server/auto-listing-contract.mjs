import crypto from "node:crypto";

export const AUTO_LISTING_IMAGE_ROLES = [
  "main",
  "sellingPoint",
  "detail",
  "scene",
  "specification",
  "infographic",
];

export const AUTO_LISTING_ITEM_STATUSES = [
  "CREATED",
  "SOURCE_READY",
  "PLANNING",
  "GENERATING",
  "READY_FOR_REVIEW",
  "UPLOAD_QUEUED",
  "UPLOADING",
  "SUCCEEDED",
  "RETRYABLE_ERROR",
  "BLOCKED",
  "CANCELLED",
];

const IMAGE_OPTIONS = {
  ratio: ["16:9", "9:16", "2:3", "3:2", "1:1", "3:4", "4:3"],
  resolution: ["1K", "2K", "4K"],
  quality: ["Low", "Medium", "High", "Ultra"],
  language: ["ru"],
};
const BRAND_MODES = new Set(["PREFER_SOURCE", "FORCE_NO_BRAND"]);

const ROLE_RANGES = {
  main: [1, 1],
  sellingPoint: [2, 5],
  detail: [1, 2],
  scene: [1, 2],
  specification: [0, 1],
  infographic: [1, 2],
};

const DEFAULT_IMAGE = {
  ratio: "3:4",
  resolution: "1K",
  quality: "Medium",
  language: "ru",
  roles: {
    main: 1,
    sellingPoint: 2,
    detail: 1,
    scene: 1,
    specification: 0,
    infographic: 1,
  },
};

const FORBIDDEN_CLIENT_FIELDS = new Set([
  "accountId",
  "account_id",
  "strategyVersionId",
  "strategyVersion",
  "strategy_version",
  "modelCredentials",
  "modelCredential",
  "modelKey",
  "modelApiKey",
  "apiKey",
  "gatewayApiKey",
  "aiGatewayKey",
  "uploadMode",
  "hasReliableProductDimensions",
]);

const CONFIG_KEYS = new Set(["targetStoreId", "targetWarehouseId", "stock", "priceAdjustmentKopecks", "priceMultiplierMicros", "brandMode", "useCategoryStrategy", "image"]);
const IMAGE_KEYS = new Set(["ratio", "resolution", "quality", "language", "roles", "total"]);

const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const contractError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

const sameCanonicalJson = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

const assertNoForbiddenFields = (value, visited = new Set()) => {
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) assertNoForbiddenFields(nested, visited);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CLIENT_FIELDS.has(key)) {
      throw contractError("AUTO_LISTING_CONFIG_FORBIDDEN_FIELD");
    }
    assertNoForbiddenFields(nested, visited);
  }
};

const assertOnlyKeys = (value, allowed) => {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
};

const requiredIdentifier = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  return value.trim();
};

const signedIntegerString = (value, fallback = "0") => {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw contractError("AUTO_LISTING_CONFIG_INVALID");
  const text = String(value).trim();
  if (!/^[+-]?\d{1,19}$/.test(text)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  const parsed = BigInt(text);
  if (parsed < POSTGRES_BIGINT_MIN || parsed > POSTGRES_BIGINT_MAX) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  return String(parsed);
};

const positiveIntegerString = (value) => {
  if (typeof value !== "string" || !/^\+?\d{1,19}$/.test(value.trim())) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  const parsed = BigInt(value.trim());
  if (parsed <= 0n || parsed > POSTGRES_BIGINT_MAX) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  return String(parsed);
};

const normalizedImageOption = (input, key) => {
  const value = input[key] ?? DEFAULT_IMAGE[key];
  if (!IMAGE_OPTIONS[key].includes(value)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  return value;
};

const normalizedRoles = (input) => {
  if (input.roles !== undefined && !isPlainObject(input.roles)) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  const requested = input.roles || {};
  assertOnlyKeys(requested, new Set(AUTO_LISTING_IMAGE_ROLES));
  const roles = {};
  for (const role of AUTO_LISTING_IMAGE_ROLES) {
    const value = requested[role] ?? DEFAULT_IMAGE.roles[role];
    const [minimum, maximum] = ROLE_RANGES[role];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw contractError("AUTO_LISTING_CONFIG_INVALID");
    }
    roles[role] = value;
  }
  return roles;
};

export function normalizeAutoListingConfig(rawConfig = {}) {
  if (!isPlainObject(rawConfig)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  assertNoForbiddenFields(rawConfig);
  assertOnlyKeys(rawConfig, CONFIG_KEYS);

  if (
    !Number.isInteger(rawConfig.stock)
    || rawConfig.stock <= 0
    || rawConfig.stock > POSTGRES_INTEGER_MAX
  ) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  if (rawConfig.image !== undefined && !isPlainObject(rawConfig.image)) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }

  const imageInput = rawConfig.image || {};
  assertOnlyKeys(imageInput, IMAGE_KEYS);
  const roles = normalizedRoles(imageInput);
  const total = Object.values(roles).reduce((sum, count) => sum + count, 0);
  if (total < 6 || total > 13) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  if (imageInput.total !== undefined && (!Number.isInteger(imageInput.total) || imageInput.total !== total)) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }

  const config = {
    targetStoreId: requiredIdentifier(rawConfig.targetStoreId),
    targetWarehouseId: requiredIdentifier(rawConfig.targetWarehouseId),
    stock: rawConfig.stock,
    priceAdjustmentKopecks: signedIntegerString(rawConfig.priceAdjustmentKopecks),
    image: {
      ratio: normalizedImageOption(imageInput, "ratio"),
      resolution: normalizedImageOption(imageInput, "resolution"),
      quality: normalizedImageOption(imageInput, "quality"),
      language: normalizedImageOption(imageInput, "language"),
      roles,
      total,
    },
  };
  if (rawConfig.brandMode !== undefined) {
    if (!BRAND_MODES.has(rawConfig.brandMode)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
    config.brandMode = rawConfig.brandMode;
  }
  if (rawConfig.useCategoryStrategy !== undefined) {
    if (typeof rawConfig.useCategoryStrategy !== "boolean") throw contractError("AUTO_LISTING_CONFIG_INVALID");
    config.useCategoryStrategy = rawConfig.useCategoryStrategy;
  }
  if (rawConfig.priceMultiplierMicros !== undefined) {
    config.priceMultiplierMicros = positiveIntegerString(rawConfig.priceMultiplierMicros);
  }
  return config;
}

const configHashFor = (config) => crypto.createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex");

export function normalizeAndHashAutoListingConfig(rawConfig = {}) {
  const config = normalizeAutoListingConfig(rawConfig);
  return { config, configHash: configHashFor(config) };
}

export function verifyAutoListingFrozenConfig(configSnapshot, requiredConfigHash) {
  const config = normalizeAutoListingConfig(configSnapshot);
  if (!sameCanonicalJson(configSnapshot, config)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  const configHash = configHashFor(config);
  if (typeof requiredConfigHash !== "string" || !/^[a-f0-9]{64}$/.test(requiredConfigHash) || requiredConfigHash !== configHash) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  return { config, configHash };
}
