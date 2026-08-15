const PRODUCT_MEASUREMENT_FIELDS = new Set([
  "length", "width", "height", "depth", "diameter",
  "lengthMm", "widthMm", "heightMm", "depthMm", "diameterMm",
  "lengthCm", "widthCm", "heightCm", "depthCm", "diameterCm",
  "productLength", "productWidth", "productHeight", "productDepth", "productDiameter",
]);
const PRODUCT_MEASUREMENT_META_FIELDS = new Set(["reliable", "unit", "source"]);
const PRODUCT_MEASUREMENT_KEYS = new Set([
  ...PRODUCT_MEASUREMENT_META_FIELDS,
  ...PRODUCT_MEASUREMENT_FIELDS,
]);

const compareText = (left, right) => Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeReliableAutoListingProductDimensions(productMeasurements) {
  if (!plainObject(productMeasurements)
    || Object.keys(productMeasurements).some((key) => !PRODUCT_MEASUREMENT_KEYS.has(key))
    || productMeasurements.reliable !== true
    || typeof productMeasurements.unit !== "string" || !productMeasurements.unit.trim()
    || typeof productMeasurements.source !== "string" || !productMeasurements.source.trim()) return null;
  const entries = Object.entries(productMeasurements)
    .filter(([key, value]) => PRODUCT_MEASUREMENT_FIELDS.has(key)
      && typeof value === "number" && Number.isFinite(value) && value > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map((entry) => Object.freeze(entry));
  if (!entries.length) return null;
  return Object.freeze({
    unit: productMeasurements.unit.trim(),
    source: productMeasurements.source.trim(),
    entries: Object.freeze(entries),
  });
}
