import { verifyAutoListingFrozenConfig } from "./auto-listing-contract.mjs";
import { normalizeReliableAutoListingProductDimensions } from "./auto-listing-product-dimensions.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
const INPUT_KEYS = new Set(["configSnapshot", "configHash", "sourceCapture"]);
const NON_SPECIFICATION_ATTRIBUTE_IDS = new Set([85, 4180, 4191, 4194, 4195, 4497, 9454, 9455, 9456, 11254]);

function inputError() {
  const error = new Error("AUTO_LISTING_CONFIG_INVALID");
  error.code = "AUTO_LISTING_CONFIG_INVALID";
  return error;
}

function hasSpecificationAttribute(attribute) {
  if (!attribute || typeof attribute !== "object" || Array.isArray(attribute)
    || typeof attribute.name !== "string" || !attribute.name.trim()
    || !Array.isArray(attribute.values) || !attribute.values.length) return false;
  const id = Number(attribute.id);
  if (!Number.isSafeInteger(id) || id < 1 || NON_SPECIFICATION_ATTRIBUTE_IDS.has(id)) return false;
  return attribute.values.every((entry) => {
    const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.value : entry;
    return Boolean((typeof value === "string" && value.trim())
      || (typeof value === "number" && Number.isFinite(value)));
  });
}

export function deriveEffectiveAutoListingImageConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).length !== INPUT_KEYS.size
    || Object.keys(input).some((key) => !INPUT_KEYS.has(key))) throw inputError();
  const { configSnapshot, configHash, sourceCapture } = input;
  const { config } = verifyAutoListingFrozenConfig(configSnapshot, configHash);
  const { snapshot } = verifyAutoListingSourceSnapshot(sourceCapture);
  const hasSpecificationAttributes = snapshot.attributes.some(hasSpecificationAttribute);
  const reliable = normalizeReliableAutoListingProductDimensions(snapshot.productMeasurements) !== null
    || hasSpecificationAttributes;
  const roles = Object.freeze({ ...config.image.roles });
  const reasonCodes = Object.freeze(reliable || config.image.roles.specification === 0
    ? []
    : ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
  return Object.freeze({
    ratio: config.image.ratio,
    resolution: config.image.resolution,
    quality: config.image.quality,
    language: config.image.language,
    roles,
    total: Object.values(roles).reduce((sum, count) => sum + count, 0),
    reasonCodes,
  });
}
