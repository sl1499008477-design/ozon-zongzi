const ROLE_ALIASES = Object.freeze({
  MAIN: "MAIN",
  main: "MAIN",
  SELLING_POINT: "SELLING_POINT",
  sellingPoint: "SELLING_POINT",
  DETAIL: "DETAIL",
  detail: "DETAIL",
  SCENE: "SCENE",
  scene: "SCENE",
  SPECIFICATION: "SPECIFICATION",
  specification: "SPECIFICATION",
  INFOGRAPHIC: "INFOGRAPHIC",
  infographic: "INFOGRAPHIC",
});
const DENSITIES = new Set(["NONE", "LIGHT", "MEDIUM", "HEAVY"]);

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 422;
  error.retryable = false;
  return error;
}
export function normalizeAutoListingTextDensityByRole(value, {
  errorCode = "AUTO_LISTING_TEXT_DENSITY_INVALID",
} = {}) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw contractError(errorCode);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.length > 6) throw contractError(errorCode);
    const output = {};
    for (const key of keys) {
      if (typeof key !== "string" || !Object.hasOwn(ROLE_ALIASES, key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")) {
        throw contractError(errorCode);
      }
      const role = ROLE_ALIASES[key];
      const density = descriptors[key].value;
      if (Object.hasOwn(output, role) || !DENSITIES.has(density)) throw contractError(errorCode);
      output[role] = density;
    }
    return output;
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw contractError(errorCode);
  }
}
