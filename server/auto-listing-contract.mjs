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
    sellingPoint: 3,
    detail: 1,
    scene: 1,
    specification: 1,
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
]);

const contractError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertNoForbiddenFields = (value) => {
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CLIENT_FIELDS.has(key)) {
      throw contractError("AUTO_LISTING_CONFIG_FORBIDDEN_FIELD");
    }
    assertNoForbiddenFields(nested);
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
  if (!/^[+-]?\d+$/.test(text)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  return String(BigInt(text));
};

const normalizedImageOption = (input, key) => {
  const value = input[key] ?? DEFAULT_IMAGE[key];
  if (!IMAGE_OPTIONS[key].includes(value)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  return value;
};

const normalizedRoles = (input, hasReliableProductDimensions) => {
  if (input.roles !== undefined && !isPlainObject(input.roles)) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  const requested = input.roles || {};
  const roles = {};
  for (const role of AUTO_LISTING_IMAGE_ROLES) {
    const value = requested[role] ?? DEFAULT_IMAGE.roles[role];
    const [minimum, maximum] = ROLE_RANGES[role];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw contractError("AUTO_LISTING_CONFIG_INVALID");
    }
    roles[role] = role === "specification" && !hasReliableProductDimensions ? 0 : value;
  }
  return roles;
};

export function normalizeAutoListingConfig(rawConfig = {}) {
  if (!isPlainObject(rawConfig)) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  assertNoForbiddenFields(rawConfig);

  if (!Number.isInteger(rawConfig.stock) || rawConfig.stock <= 0) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  if (rawConfig.image !== undefined && !isPlainObject(rawConfig.image)) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }

  const hasReliableProductDimensions = rawConfig.hasReliableProductDimensions === true;
  const imageInput = rawConfig.image || {};
  const roles = normalizedRoles(imageInput, hasReliableProductDimensions);
  const total = Object.values(roles).reduce((sum, count) => sum + count, 0);
  if (total < 6 || total > 13) throw contractError("AUTO_LISTING_CONFIG_INVALID");

  return {
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
    reasonCodes: hasReliableProductDimensions ? [] : ["PRODUCT_DIMENSIONS_UNAVAILABLE"],
  };
}
