import { types } from "node:util";

const MAX_TEXT = 2_000_000;
const MAX_OFFERS = 100;
const UNKNOWN_INVALID = Object.freeze({ status: "UNKNOWN", code: "ZONGZI_OFFER_RECONCILIATION_INVALID" });
const UNKNOWN_RESULT = Object.freeze({ status: "UNKNOWN", code: "ZONGZI_OFFER_RECONCILIATION_UNKNOWN" });
const PRESENT = Object.freeze({ status: "PRESENT", code: "OZON_OFFER_PRESENT" });
const ABSENT = Object.freeze({ status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT" });

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !types.isProxy(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch { return false; }
}

function exact(value, keys) {
  if (!plain(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string"
      || !keys.includes(key) || !("value" in descriptors[key]) || !descriptors[key].enumerable)) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch { return null; }
}

function arrayValues(value) {
  try {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > MAX_OFFERS) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
  } catch { return null; }
}

function safeText(value, { required = true } = {}) {
  return typeof value === "string" && value.length <= 240 && (!required || value.length > 0)
    ? value : null;
}

function projectInput(raw) {
  const input = exact(raw, ["offers", "credential"]);
  const offers = arrayValues(input?.offers);
  const credential = exact(input?.credential, ["clientId", "apiKey"]);
  if (!offers || !credential || !safeText(credential.clientId) || !safeText(credential.apiKey)) return null;
  const projected = [];
  const ids = new Set();
  for (const rawOffer of offers) {
    const offer = exact(rawOffer, ["offerId", "sku"]);
    if (!offer || !safeText(offer.offerId) || !safeText(offer.sku) || ids.has(offer.offerId)) return null;
    ids.add(offer.offerId);
    projected.push(Object.freeze({ offerId: offer.offerId, sku: offer.sku }));
  }
  if (projected.reduce((count, offer) => count + offer.offerId.length + offer.sku.length, 0) > MAX_TEXT) return null;
  return Object.freeze({
    offers: Object.freeze(projected),
    credential: Object.freeze({ clientId: credential.clientId, apiKey: credential.apiKey }),
  });
}

function projectResponse(raw) {
  const root = exact(raw, ["result"]);
  if (!root) return null;
  const result = exact(root.result, ["items", "total", "last_id"]);
  const items = arrayValuesAllowEmpty(result?.items);
  if (!result || !items || !Number.isSafeInteger(result.total) || result.total < 0
    || typeof result.last_id !== "string" || result.last_id.length > 240) return null;
  const output = [];
  for (const rawItem of items) {
    if (!plain(rawItem)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(rawItem);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !["offer_id", "sku", "product_id", "id"].includes(key)
      || !("value" in descriptors[key]))) return null;
    const item = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
    for (const key of ["offer_id", "sku"]) {
      if (Object.hasOwn(item, key) && item[key] !== null && safeText(item[key], { required: false }) === null) return null;
    }
    for (const key of ["product_id", "id"]) {
      if (Object.hasOwn(item, key) && item[key] !== null && item[key] !== ""
        && !(Number.isSafeInteger(item[key]) && item[key] > 0)
        && !(typeof item[key] === "string" && /^[1-9][0-9]{0,15}$/u.test(item[key]))) return null;
    }
    output.push(item);
  }
  return { items: output, total: result.total, lastId: result.last_id };
}

function arrayValuesAllowEmpty(value) {
  try {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > MAX_OFFERS) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch { return null; }
}

export function createOzonOfferReconciliation({ callOzon } = {}) {
  if (typeof callOzon !== "function") throw new TypeError("callOzon is required");
  return Object.freeze({
    async confirmOfferAbsent(rawInput) {
      const input = projectInput(rawInput);
      if (!input) return UNKNOWN_INVALID;
      let raw;
      try {
        raw = await callOzon(input.credential, "/v3/product/list", {
          filter: { offer_id: input.offers.map((offer) => offer.offerId) },
          limit: input.offers.length,
        }, 30_000, { maxResponseBytes: 262_144 });
      } catch {
        return UNKNOWN_RESULT;
      }
      const response = projectResponse(raw);
      if (!response) return UNKNOWN_RESULT;
      const offerIds = new Set(input.offers.map((offer) => offer.offerId));
      const skus = new Set(input.offers.map((offer) => offer.sku));
      if (response.items.some((item) => offerIds.has(item.offer_id) || skus.has(String(item.sku ?? "")))) return PRESENT;
      if (response.items.length || response.total !== 0 || response.lastId) return UNKNOWN_RESULT;
      return ABSENT;
    },
  });
}
