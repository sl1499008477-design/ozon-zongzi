const RETIRED_COLLECTOR_SCOPE_KEYS = new Set([
  "accountid",
  "createdby",
  "clientid",
  "storeid",
  "localstoreid",
  "operatingstoreid",
  "datacollectionstoreid",
  "datacollectionstore",
  "datacollectionstores",
  "sellercompanyid",
  "sellercompany",
  "legacyscope",
]);

function canonicalKey(key) {
  return String(key || "").replace(/[_-]/g, "").toLowerCase();
}

export function isRetiredCollectorScopeKey(key) {
  return RETIRED_COLLECTOR_SCOPE_KEYS.has(canonicalKey(key));
}

export function withoutCollectorScope(value) {
  if (Array.isArray(value)) return value.map(withoutCollectorScope);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isRetiredCollectorScopeKey(key)) result[key] = withoutCollectorScope(nested);
  }
  return result;
}
