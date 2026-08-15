import { verifyAutoListingFrozenConfig } from "./auto-listing-contract.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";

function hasReliableProductDimensions(productMeasurements) {
  if (!productMeasurements || typeof productMeasurements !== "object" || Array.isArray(productMeasurements)
    || productMeasurements.reliable !== true
    || typeof productMeasurements.unit !== "string" || !productMeasurements.unit.trim()
    || typeof productMeasurements.source !== "string" || !productMeasurements.source.trim()) return false;
  return Object.entries(productMeasurements).some(([key, value]) => (
    PRODUCT_MEASUREMENT_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value) && value > 0
  ));
}

const PRODUCT_MEASUREMENT_FIELDS = new Set([
  "length", "width", "height", "depth", "diameter",
  "lengthMm", "widthMm", "heightMm", "depthMm", "diameterMm",
  "lengthCm", "widthCm", "heightCm", "depthCm", "diameterCm",
  "productLength", "productWidth", "productHeight", "productDepth", "productDiameter",
]);
const INPUT_KEYS = new Set(["configSnapshot", "configHash", "sourceCapture"]);

function inputError() {
  const error = new Error("AUTO_LISTING_CONFIG_INVALID");
  error.code = "AUTO_LISTING_CONFIG_INVALID";
  return error;
}

function productDimensionsError() {
  const error = new Error("AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED");
  error.code = "AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED";
  error.status = 422;
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
  const reliable = hasReliableProductDimensions(snapshot.productMeasurements);
  if (config.image.roles.specification > 0 && !reliable) throw productDimensionsError();
  const roles = Object.freeze({ ...config.image.roles });
  return Object.freeze({
    ratio: config.image.ratio,
    resolution: config.image.resolution,
    quality: config.image.quality,
    language: config.image.language,
    roles,
    total: config.image.total,
    reasonCodes: Object.freeze([]),
  });
}
