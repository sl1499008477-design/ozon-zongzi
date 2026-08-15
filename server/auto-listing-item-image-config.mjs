import { verifyAutoListingFrozenConfig } from "./auto-listing-contract.mjs";
import { normalizeReliableAutoListingProductDimensions } from "./auto-listing-product-dimensions.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
const INPUT_KEYS = new Set(["configSnapshot", "configHash", "sourceCapture"]);

function inputError() {
  const error = new Error("AUTO_LISTING_CONFIG_INVALID");
  error.code = "AUTO_LISTING_CONFIG_INVALID";
  return error;
}

export function deriveEffectiveAutoListingImageConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).length !== INPUT_KEYS.size
    || Object.keys(input).some((key) => !INPUT_KEYS.has(key))) throw inputError();
  const { configSnapshot, configHash, sourceCapture } = input;
  const { config } = verifyAutoListingFrozenConfig(configSnapshot, configHash);
  const { snapshot } = verifyAutoListingSourceSnapshot(sourceCapture);
  const reliable = normalizeReliableAutoListingProductDimensions(snapshot.productMeasurements) !== null;
  const roles = Object.freeze({
    ...config.image.roles,
    specification: reliable ? config.image.roles.specification : 0,
  });
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
