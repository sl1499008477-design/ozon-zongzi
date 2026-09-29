import crypto from "node:crypto";
import { types } from "node:util";
import { callOzonSellerApi } from "./ozon-client.mjs";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 10_000;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UNRESOLVED = Object.freeze({
  status: "UNRESOLVED",
  reasonCode: "ZONGZI_SOURCE_LOOKUP_UNRESOLVED",
});

function positiveInteger(value) {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
      ? Number(value)
      : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeText(value, maximum = 240) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(text) ? text : "";
}

function safeClone(value) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (nested, depth) => {
    if (nested === null || typeof nested === "boolean" || typeof nested === "string") return nested;
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
    if (!nested || typeof nested !== "object" || types.isProxy(nested)
      || seen.has(nested) || depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new TypeError("invalid response");
    seen.add(nested);
    const descriptors = Object.getOwnPropertyDescriptors(nested);
    if (Array.isArray(nested)) {
      const output = [];
      const length = descriptors.length?.value;
      if (length !== nested.length || nested.length > MAX_NODES) throw new TypeError("invalid response");
      for (let index = 0; index < nested.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set || descriptor.enumerable !== true) {
          throw new TypeError("invalid response");
        }
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(nested))) throw new TypeError("invalid response");
    const output = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || DANGEROUS_KEYS.has(key)
        || descriptor.get || descriptor.set || descriptor.enumerable !== true) throw new TypeError("invalid response");
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESPONSE_BYTES) {
    throw new TypeError("oversized response");
  }
  return result;
}

function safeStoreCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("invalid lookup input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || descriptor.get || descriptor.set || descriptor.enumerable !== true) {
      throw new TypeError("invalid lookup input");
    }
  }
  const read = (key) => Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;
  const ownerAccountId = safeText(read("ownerAccountId") ?? read("accountId"));
  return {
    id: safeText(read("id")),
    ownerAccountId,
    clientId: safeText(read("clientId"), 500),
    apiKey: safeText(read("apiKey"), 4000),
  };
}

function exactLookupInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError("invalid lookup input");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ["accountId", "store", "ozonProductId", "sourceSku"];
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || descriptors[key].get || descriptors[key].set || !descriptors[key].enumerable)) {
    throw new TypeError("invalid lookup input");
  }
  const accountId = safeText(descriptors.accountId.value);
  const store = safeStoreCredential(descriptors.store.value);
  if (!accountId || store.ownerAccountId !== accountId) {
    throw new TypeError("invalid lookup input");
  }
  return {
    accountId,
    store,
    ozonProductId: descriptors.ozonProductId.value === null
      ? null : positiveInteger(descriptors.ozonProductId.value),
    sourceSku: descriptors.sourceSku.value === null ? null : safeText(descriptors.sourceSku.value),
  };
}

function responseItem(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)
    || !Object.hasOwn(response, "result")) return { kind: "INVALID" };
  if (response.result === null) return { kind: "ABSENT" };
  if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
    return { kind: "INVALID" };
  }
  return { kind: "ITEM", item: response.result };
}

function attributesItem(response) {
  const raw = Array.isArray(response?.result)
    ? response.result
    : Array.isArray(response?.result?.items)
      ? response.result.items
      : null;
  if (!raw || raw.length !== 1 || !raw[0] || typeof raw[0] !== "object" || Array.isArray(raw[0])) {
    return null;
  }
  return raw[0];
}

function productIdOf(item) {
  return positiveInteger(item?.id ?? item?.product_id ?? item?.productId);
}

function offerIdOf(item) {
  return safeText(item?.offer_id ?? item?.offerId ?? item?.sku);
}

function categoryFacts(item) {
  const sourceDescriptionCategoryId = positiveInteger(
    item?.description_category_id ?? item?.descriptionCategoryId,
  );
  const sourceTypeId = positiveInteger(item?.type_id ?? item?.typeId);
  if (!sourceDescriptionCategoryId || !sourceTypeId) return null;
  const categories = Array.isArray(item?.categories) ? item.categories : [];
  const normalizedPath = categories.slice(0, 32)
    .map((category) => safeText(category?.title ?? category?.name, 160)).filter(Boolean);
  const sourceAttributes = Array.isArray(item?.attributes) ? item.attributes : [];
  const attributeSummary = sourceAttributes.slice(0, 100).flatMap((attribute) => {
    const key = safeText(String(attribute?.id ?? attribute?.key ?? ""), 80);
    const rawValue = attribute?.value ?? attribute?.values?.[0]?.value ?? null;
    const value = rawValue === null || typeof rawValue === "boolean"
      || (typeof rawValue === "number" && Number.isFinite(rawValue))
      || (typeof rawValue === "string" && rawValue.length <= 500)
      ? rawValue : null;
    if (!key) return [];
    const dictionaryValueId = positiveInteger(
      attribute?.dictionary_value_id ?? attribute?.dictionaryValueId ?? attribute?.values?.[0]?.dictionary_value_id,
    );
    return [{ key, value, ...(dictionaryValueId ? { dictionaryValueId } : {}) }];
  });
  return { sourceDescriptionCategoryId, sourceTypeId, normalizedPath, attributeSummary };
}

function identityMatches(item, input) {
  const productId = productIdOf(item);
  const offerId = offerIdOf(item);
  return (!input.ozonProductId || productId === input.ozonProductId)
    && (!input.sourceSku || offerId === input.sourceSku)
    && productId !== null && offerId !== "";
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function createOzonSourceCategoryLookup({
  transport = callOzonSellerApi,
  now = () => new Date(),
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof transport !== "function" || typeof now !== "function"
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
    || maxResponseBytes > MAX_RESPONSE_BYTES) throw new TypeError("Ozon source lookup dependencies required");

  async function request(store, path, body) {
    return safeClone(await transport(store, path, body, 60_000, { maxResponseBytes }));
  }

  async function exact(input, identity) {
    const response = await request(input.store, "/v2/product/info", identity.kind === "PRODUCT"
      ? { product_id: identity.value }
      : { offer_id: identity.value });
    const normalized = responseItem(response);
    if (normalized.kind !== "ITEM") return normalized;
    if (!identityMatches(normalized.item, input)) return { kind: "MISMATCH" };
    let facts = categoryFacts(normalized.item);
    let evidenceResponse = response;
    let evidenceItem = normalized.item;
    if (!facts) {
      const productId = productIdOf(normalized.item);
      if (!productId) return { kind: "INVALID" };
      const attributesResponse = await request(input.store, "/v4/product/info/attributes", {
        filter: { product_id: [String(productId)] }, limit: 1,
      });
      const detailed = attributesItem(attributesResponse);
      if (!detailed || !identityMatches(detailed, input)
        || productIdOf(detailed) !== productId
        || offerIdOf(detailed) !== offerIdOf(normalized.item)) {
        return { kind: "MISMATCH" };
      }
      facts = categoryFacts(detailed);
      if (!facts) return { kind: "INVALID" };
      evidenceResponse = attributesResponse;
      evidenceItem = detailed;
    }
    const capturedAt = new Date(now());
    if (Number.isNaN(capturedAt.getTime())) return { kind: "INVALID" };
    const productId = productIdOf(evidenceItem);
    const sourceSku = offerIdOf(evidenceItem);
    const rawResponseHash = crypto.createHash("sha256")
      .update(JSON.stringify(evidenceResponse)).digest("hex");
    return {
      kind: "RESOLVED",
      result: freeze({
        status: "RESOLVED",
        ozonProductId: productId,
        sourceSku,
        lookupContractVersion: "account-shared-ozon-category-lookup.v1",
        requestedOzonProductId: input.ozonProductId,
        requestedSourceSku: input.sourceSku,
        matchedOzonProductId: productId,
        matchedSourceSku: sourceSku,
        ...facts,
        rawResponseHash,
        capturedAt: capturedAt.toISOString(),
      }),
    };
  }

  return Object.freeze({
    async lookup(rawInput) {
      let input;
      try { input = exactLookupInput(rawInput); } catch { return UNRESOLVED; }
      const identities = [
        ...(input.ozonProductId ? [{ kind: "PRODUCT", value: input.ozonProductId }] : []),
        ...(input.sourceSku ? [{ kind: "OFFER", value: input.sourceSku }] : []),
      ];
      for (const identity of identities) {
        try {
          const outcome = await exact(input, identity);
          if (outcome.kind === "RESOLVED") return outcome.result;
          if (!["ABSENT"].includes(outcome.kind)) return UNRESOLVED;
        } catch {
          return UNRESOLVED;
        }
      }
      return UNRESOLVED;
    },
  });
}
