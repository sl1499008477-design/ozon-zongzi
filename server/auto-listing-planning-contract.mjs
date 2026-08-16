import { types as utilTypes } from "node:util";

export const AUTO_LISTING_PLANNING_CONTRACTS = Object.freeze({
  LEGACY: "LEGACY_FULL_PLAN_V3",
  FIXED: "FIXED_SKELETON_V1",
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SELECTOR_KEYS = Object.freeze(["accountId", "sourceType", "collectItemId"]);

function exactDataObject(value, keys) {
  try {
    if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Object.keys(descriptors);
    if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return null;
    if (keys.some((key) => descriptors[key]?.enumerable !== true
      || !Object.hasOwn(descriptors[key], "value"))) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch {
    return null;
  }
}

export function selectAutoListingPlanningContract(raw = {}) {
  const input = exactDataObject(raw, SELECTOR_KEYS);
  if (!input) return AUTO_LISTING_PLANNING_CONTRACTS.LEGACY;
  const { accountId, sourceType, collectItemId } = input;
  if (!SAFE_ID.test(accountId) || !SAFE_ID.test(collectItemId)) {
    return AUTO_LISTING_PLANNING_CONTRACTS.LEGACY;
  }
  return sourceType === "COLLECT_BOX"
    ? AUTO_LISTING_PLANNING_CONTRACTS.FIXED
    : AUTO_LISTING_PLANNING_CONTRACTS.LEGACY;
}
