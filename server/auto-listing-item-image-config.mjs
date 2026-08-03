import { verifyAutoListingFrozenConfig } from "./auto-listing-contract.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";

function hasReliableProductDimensions(productMeasurements) {
  if (!productMeasurements || typeof productMeasurements !== "object" || Array.isArray(productMeasurements)
    || productMeasurements.reliable !== true
    || typeof productMeasurements.unit !== "string" || !productMeasurements.unit.trim()
    || typeof productMeasurements.source !== "string" || !productMeasurements.source.trim()) return false;
  return Object.entries(productMeasurements).some(([key, value]) => (
    !["reliable", "unit", "source"].includes(key) && typeof value === "number" && Number.isFinite(value) && value > 0
  ));
}

export function deriveEffectiveAutoListingImageConfig(configSnapshot, verifiedSourceSnapshot) {
  const { config } = verifyAutoListingFrozenConfig(configSnapshot);
  const { snapshot } = verifyAutoListingSourceSnapshot(verifiedSourceSnapshot);
  const reliable = hasReliableProductDimensions(snapshot.productMeasurements);
  const roles = {
    ...config.image.roles,
    specification: reliable ? config.image.roles.specification : 0,
  };
  return {
    ratio: config.image.ratio,
    resolution: config.image.resolution,
    quality: config.image.quality,
    language: config.image.language,
    roles,
    total: Object.values(roles).reduce((sum, count) => sum + count, 0),
    reasonCodes: reliable ? [] : ["PRODUCT_DIMENSIONS_UNAVAILABLE"],
  };
}
