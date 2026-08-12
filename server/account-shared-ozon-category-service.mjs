import { types } from "node:util";
import { sourceCategoryEvidence } from "./account-shared-ozon-category-contract.mjs";
import { TAXONOMY_SCOPE_OZON_DEFAULT } from "./ozon-taxonomy-category-policy.mjs";

const SOURCE_KEYS = Object.freeze([
  "accountId", "collectItemId", "sourceVersion", "productDraftId",
  "productDraftVersion", "ozonProductId", "sourceSku", "taxonomyScope",
  "sourceDescriptionCategoryId", "sourceTypeId", "normalizedPath",
  "attributeSummary", "capturedAt", "rawResponseRef", "rawResponseHash",
]);
const RESOLVE_KEYS = Object.freeze([...SOURCE_KEYS, "lookupContext"]);

function serviceError(code, status = 400) {
  return Object.assign(new Error("Account-shared Ozon category operation failed"), { code, status });
}
function exactObject(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw serviceError("OZON_CATEGORY_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !Object.hasOwn(descriptors, key)
      || descriptors[key].get || descriptors[key].set || !descriptors[key].enumerable)) {
    throw serviceError("OZON_CATEGORY_INPUT_INVALID");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function text(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 240
    || /[\u0000-\u001f\u007f]/u.test(value)) throw serviceError("OZON_CATEGORY_INPUT_INVALID");
  return value;
}

function idList(value) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 500) {
    throw serviceError("OZON_CATEGORY_INPUT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw serviceError("OZON_CATEGORY_INPUT_INVALID");
    }
    result.push(text(descriptor.value));
  }
  if (new Set(result).size !== result.length) throw serviceError("OZON_CATEGORY_INPUT_INVALID");
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function evidenceInput(input) {
  const values = exactObject(input, SOURCE_KEYS);
  const accountId = text(values.accountId);
  const collectItemId = text(values.collectItemId);
  const capturedAt = text(values.capturedAt);
  const rawResponseRef = text(values.rawResponseRef);
  const rawResponseHash = text(values.rawResponseHash);
  return sourceCategoryEvidence({
    ...values,
    accountId,
    collectItemId,
    taxonomyScope: values.taxonomyScope || TAXONOMY_SCOPE_OZON_DEFAULT,
    provenance: {
      accountId,
      collectItemId,
      sourceKind: "PRODUCT_DRAFT",
      sourceRecordId: text(values.productDraftId),
      rawResponseRef,
      rawResponseHash,
      capturedAt,
    },
  });
}

function lookupEvidenceInput(base, result) {
  const accountId = text(base.accountId);
  const collectItemId = text(base.collectItemId);
  const capturedAt = text(result.capturedAt);
  const rawResponseRef = text(result.rawResponseRef);
  const rawResponseHash = text(result.rawResponseHash);
  return sourceCategoryEvidence({
    ...base,
    sourceVersion: `lookup:${rawResponseHash}`,
    productDraftId: null,
    productDraftVersion: null,
    ozonProductId: result.ozonProductId,
    sourceSku: result.sourceSku,
    taxonomyScope: base.taxonomyScope || TAXONOMY_SCOPE_OZON_DEFAULT,
    sourceDescriptionCategoryId: result.sourceDescriptionCategoryId,
    sourceTypeId: result.sourceTypeId,
    normalizedPath: result.normalizedPath,
    attributeSummary: result.attributeSummary,
    capturedAt,
    rawResponseRef,
    rawResponseHash,
    provenance: {
      accountId,
      collectItemId,
      sourceKind: "OZON_READ_LOOKUP",
      sourceRecordId: rawResponseRef,
      rawResponseRef,
      rawResponseHash,
      capturedAt,
      lookupContractVersion: result.lookupContractVersion,
      requestedOzonProductId: result.requestedOzonProductId,
      requestedSourceSku: result.requestedSourceSku,
      matchedOzonProductId: result.matchedOzonProductId,
      matchedSourceSku: result.matchedSourceSku,
    },
  });
}

function guidance(status) {
  if (status === "ACTIVE") return { action: "NONE", message: "使用采集类目准备上架" };
  if (status === "INVALIDATED") return { action: "WAIT", message: "Ozon 类目已失效，正在自动修复" };
  return { action: "REVIEW", message: "无法确认商品类目，请人工选择" };
}

export function publicAccountSharedCategorySelection(shared = null) {
  const status = shared?.status || "NEEDS_REVIEW";
  const projected = {
    status,
    taxonomyScope: shared?.taxonomyScope || TAXONOMY_SCOPE_OZON_DEFAULT,
    sourceDescriptionCategoryId: shared?.sourceDescriptionCategoryId ?? null,
    sourceTypeId: shared?.sourceTypeId ?? null,
    currentDescriptionCategoryId: shared?.currentDescriptionCategoryId ?? null,
    currentTypeId: shared?.currentTypeId ?? null,
    source: shared?.source ?? null,
    version: shared?.version ?? null,
    validatedAt: shared?.validatedAt ?? null,
    ...guidance(status),
  };
  return deepFreeze(projected);
}

export function createAccountSharedOzonCategoryService({
  repository,
  sourceLookup = null,
  now = () => new Date(),
} = {}) {
  const methods = ["recordSourceEvidence", "readCurrentEvidence", "readSharedForEvidence"];
  if (!repository || methods.some((method) => typeof repository[method] !== "function")
    || (sourceLookup !== null && typeof sourceLookup?.lookup !== "function")
    || typeof now !== "function") throw new TypeError("Account-shared category service dependencies required");

  async function recordCollectionSource(rawInput) {
    const input = evidenceInput(rawInput);
    const recorded = await repository.recordSourceEvidence(input);
    return deepFreeze({
      collectItemId: input.collectItemId,
      categoryResolution: publicAccountSharedCategorySelection(recorded.shared),
    });
  }

  async function readForItems(input = {}) {
    const values = exactObject(input, ["accountId", "collectItemIds"]);
    const accountId = text(values.accountId);
    const collectItemIds = idList(values.collectItemIds);
    const evidence = await repository.readCurrentEvidence({ accountId, collectItemIds });
    if (!evidence.length) return Object.freeze([]);
    const shared = await repository.readSharedForEvidence({
      accountId,
      evidenceIds: evidence.map((row) => row.id),
    });
    const bySignature = new Map(shared.map((row) => [[
      row.sourceDescriptionCategoryId, row.sourceTypeId, row.taxonomyScope,
    ].join(":"), row]));
    return deepFreeze(evidence.map((row) => ({
      collectItemId: row.collectItemId,
      categoryResolution: publicAccountSharedCategorySelection(bySignature.get([
        row.sourceDescriptionCategoryId, row.sourceTypeId, row.taxonomyScope,
      ].join(":")) || null),
    })));
  }

  async function resolveCollectionSource(rawInput) {
    const values = exactObject(rawInput, RESOLVE_KEYS);
    if (Number.isSafeInteger(values.sourceDescriptionCategoryId)
      && values.sourceDescriptionCategoryId > 0
      && Number.isSafeInteger(values.sourceTypeId) && values.sourceTypeId > 0) {
      const { lookupContext: _lookupContext, ...direct } = values;
      return recordCollectionSource(direct);
    }
    if (sourceLookup) {
      const result = await sourceLookup.lookup(values.lookupContext);
      if (result?.status === "RESOLVED") {
        const { lookupContext: _lookupContext, ...base } = values;
        const input = lookupEvidenceInput(base, result);
        const recorded = await repository.recordSourceEvidence(input);
        return deepFreeze({
          collectItemId: input.collectItemId,
          categoryResolution: publicAccountSharedCategorySelection(recorded.shared),
        });
      }
    }
    return deepFreeze({
      collectItemId: text(values.collectItemId),
      categoryResolution: publicAccountSharedCategorySelection(null),
    });
  }

  return Object.freeze({ recordCollectionSource, resolveCollectionSource, readForItems });
}
