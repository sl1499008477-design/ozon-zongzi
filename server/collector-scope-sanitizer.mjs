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
  "datacollectionstoreids",
  "currentdatacollectionstoreid",
  "currentdatacollectionstoreidsbyaccount",
  "sellercompanyid",
  "sellercompany",
  "legacyscope",
]);

const SERVER_OWNED_CATEGORY_RESOLUTION_KEYS = new Set([
  "taxonomyscope",
  "categoryresolution",
  "targetdescriptioncategoryid",
  "targettypeid",
  "targetcategoryid",
  "taxonomyfingerprint",
  "credentialstoreid",
  "failurecode",
  "failuredetailsafe",
  "attemptcount",
  "nextattemptat",
  "leasetoken",
  "leaseexpiresat",
  "matchedat",
  "validatedat",
  "resolutionmethod",
  "resolutionstatus",
  "categoryresolutionmethod",
  "categoryresolutionstatus",
]);

function canonicalKey(key) {
  return String(key || "").replace(/[_-]/g, "").toLowerCase();
}

export function isRetiredCollectorScopeKey(key) {
  return RETIRED_COLLECTOR_SCOPE_KEYS.has(canonicalKey(key));
}

export function isServerOwnedCategoryResolutionKey(key) {
  return SERVER_OWNED_CATEGORY_RESOLUTION_KEYS.has(canonicalKey(key));
}

export function findServerOwnedCategoryResolutionPath(value, path = "$", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findServerOwnedCategoryResolutionPath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return "";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "";
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isServerOwnedCategoryResolutionKey(key)) return childPath;
    const found = findServerOwnedCategoryResolutionPath(nested, childPath, seen);
    if (found) return found;
  }
  return "";
}

export function findRetiredCollectorScopePath(value, path = "$", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRetiredCollectorScopePath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return "";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "";
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isRetiredCollectorScopeKey(key)) return childPath;
    const found = findRetiredCollectorScopePath(nested, childPath, seen);
    if (found) return found;
  }
  return "";
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
