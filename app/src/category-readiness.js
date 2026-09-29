export const CATEGORY_DATA_ERROR_MESSAGE =
  "未能从 Ozon 获取真实类目数据，请重试";

const itemsOf = (response) => {
  const items = Array.isArray(response?.items)
    ? response.items
    : Array.isArray(response?.data)
      ? response.data
      : [];
  return structuredClone(items);
};

const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const cleanText = (value) => String(value ?? "").trim();

const normalizedSourceCategory = (source = {}) => ({
  descriptionCategoryId: positiveNumber(source.descriptionCategoryId ?? source.description_category_id),
  typeName: cleanText(source.typeName ?? source.type_name),
  typeIdCandidate: positiveNumber(source.typeIdCandidate ?? source.type_id_candidate),
  path: Array.isArray(source.path) ? source.path.map(cleanText).filter(Boolean) : [],
});

export function sourceCategoryEvidenceOf(item = {}) {
  const direct = [
    item?.categoryResolution?.source,
    item?.sourceCategory,
    item?.listingDraft?.categoryResolution?.source,
    item?.listingDraft?.sourceCategory,
  ].filter((value) => value && typeof value === "object")
    .map(normalizedSourceCategory)
    .reduce((merged, candidate) => ({
      descriptionCategoryId: merged.descriptionCategoryId || candidate.descriptionCategoryId,
      typeName: merged.typeName || candidate.typeName,
      typeIdCandidate: merged.typeIdCandidate || candidate.typeIdCandidate,
      path: merged.path.length ? merged.path : candidate.path,
    }), normalizedSourceCategory());
  const variants = [
    item?.variantData,
    item?.variant_data,
    item?._sourceVariant,
    item?.raw?.variantData,
    item?.raw?.variant_data,
    item?.raw,
  ].filter((value) => value && typeof value === "object");
  const variant = variants.find((value) =>
    value.description_category_id || value.descriptionCategoryId
      || Array.isArray(value.attributes) || Array.isArray(value.categories)
  ) || {};
  const typeAttribute = (Array.isArray(variant.attributes) ? variant.attributes : []).find(
    (attribute) => String(attribute?.key ?? attribute?.id ?? attribute?.attribute_id) === "8229",
  ) || {};
  const categories = Array.isArray(variant.categories) ? [...variant.categories] : [];
  const path = categories
    .sort((left, right) => positiveNumber(left?.level) - positiveNumber(right?.level))
    .map((category) => cleanText(category?.title || category?.name))
    .filter((label, index, labels) => label && labels.indexOf(label) === index);
  return normalizedSourceCategory({
    descriptionCategoryId: direct.descriptionCategoryId
      || variant.description_category_id
      || variant.descriptionCategoryId,
    typeName: direct.typeName || typeAttribute.value,
    typeIdCandidate: direct.typeIdCandidate
      || typeAttribute.dictionary_value_id
      || typeAttribute.dictionaryValueId,
    path: Array.isArray(direct.path) && direct.path.length ? direct.path : path,
  });
}

const SHARED_CATEGORY_KEYS = Object.freeze([
  "status", "taxonomyScope", "sourceDescriptionCategoryId", "sourceTypeId",
  "currentDescriptionCategoryId", "currentTypeId", "source", "version",
  "validatedAt", "action", "message",
]);
const SHARED_CATEGORY_SOURCES = new Set(["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"]);
const SHARED_CATEGORY_GUIDANCE = Object.freeze({
  ACTIVE: Object.freeze({ action: "NONE", message: "使用采集类目准备上架" }),
  INVALIDATED: Object.freeze({ action: "WAIT", message: "Ozon 类目已失效，正在自动修复" }),
  NEEDS_REVIEW: Object.freeze({ action: "REVIEW", message: "无法确认商品类目，请人工选择" }),
});

const runtimeIsProxy = (() => {
  try {
    const candidate = globalThis.process?.getBuiltinModule?.("node:util")?.types?.isProxy;
    return typeof candidate === "function" ? candidate : () => false;
  } catch {
    return () => false;
  }
})();

const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;

function plainDataRecord(value, allowedKeys) {
  if (!value || typeof value !== "object" || runtimeIsProxy(value)) return null;
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.length !== allowedKeys.length
      || allowedKeys.some((key) => !Object.hasOwn(descriptors, key))
      || keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)
      || !descriptors[key]?.enumerable || !("value" in descriptors[key]))) return null;
    return Object.fromEntries(allowedKeys.map((key) => [key, descriptors[key].value]));
  } catch {
    return null;
  }
}

function canonicalInstant(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function accountSharedCategoryResolution(
  resolution,
  { taxonomyScope = "OZON:DEFAULT" } = {},
) {
  const safe = plainDataRecord(resolution, SHARED_CATEGORY_KEYS);
  const guidance = safe ? SHARED_CATEGORY_GUIDANCE[safe.status] : null;
  if (!safe || !guidance || safe.taxonomyScope !== taxonomyScope
    || safe.action !== guidance.action || safe.message !== guidance.message) return null;
  const ids = [
    safe.sourceDescriptionCategoryId, safe.sourceTypeId,
    safe.currentDescriptionCategoryId, safe.currentTypeId,
  ];
  const unresolved = ids.every((value) => value === null)
    && safe.status === "NEEDS_REVIEW" && safe.source === null
    && safe.version === null && safe.validatedAt === null;
  const resolved = ids.every((value) => Number.isSafeInteger(value) && value > 0)
    && SHARED_CATEGORY_SOURCES.has(safe.source)
    && Number.isSafeInteger(safe.version) && safe.version > 0
    && (safe.source === "SOURCE_DIRECT"
      ? safe.validatedAt === null : canonicalInstant(safe.validatedAt));
  return unresolved || resolved ? Object.freeze(safe) : null;
}

export function listingCategoryFields(
  resolution,
  { taxonomyScope = "OZON:DEFAULT" } = {},
) {
  const shared = accountSharedCategoryResolution(resolution, { taxonomyScope });
  if (!shared || shared.status !== "ACTIVE") return {};
  const descriptionCategoryId = positiveSafeInteger(shared.currentDescriptionCategoryId);
  const typeId = positiveSafeInteger(shared.currentTypeId);
  return descriptionCategoryId && typeId ? { descriptionCategoryId, typeId } : {};
}

function confirmationError() {
  const error = new Error("ZONGZI_CATEGORY_CONFIRMATION_INVALID");
  error.code = "ZONGZI_CATEGORY_CONFIRMATION_INVALID";
  return error;
}

function confirmationText(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 240
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

export function categoryConfirmationRequest(input = {}) {
  const request = {
    collectItemId: confirmationText(input.collectItemId),
    expectedSourceVersion: confirmationText(input.expectedSourceVersion),
    descriptionCategoryId: positiveSafeInteger(input.descriptionCategoryId),
    typeId: positiveSafeInteger(input.typeId),
    taxonomyScope: confirmationText(input.taxonomyScope),
    idempotencyKey: confirmationText(input.idempotencyKey),
    correlationId: confirmationText(input.correlationId),
  };
  if (!request.collectItemId || !request.expectedSourceVersion
    || !request.descriptionCategoryId || !request.typeId
    || request.taxonomyScope !== "OZON:DEFAULT"
    || !request.idempotencyKey || !request.correlationId) throw confirmationError();
  return Object.freeze(request);
}

export function categoryConfirmationResponse(input, request) {
  const result = plainDataRecord(input, ["collectItemId", "categoryResolution"]);
  const resolution = result
    ? accountSharedCategoryResolution(result.categoryResolution, { taxonomyScope: request?.taxonomyScope })
    : null;
  if (!resolution || result.collectItemId !== request?.collectItemId
    || resolution.status !== "ACTIVE" || resolution.source !== "MANUAL"
    || resolution.currentDescriptionCategoryId !== request?.descriptionCategoryId
    || resolution.currentTypeId !== request?.typeId) return null;
  return Object.freeze({ collectItemId: result.collectItemId, categoryResolution: resolution });
}

export function categoryRequestScope({ storeId, itemId } = {}) {
  return JSON.stringify([String(storeId || ""), String(itemId || "")]);
}

export function categoryRequestIsCurrent({ requestId, scope, currentRequestId, currentScope } = {}) {
  return Number(requestId) === Number(currentRequestId) && scope === currentScope;
}

export function categoryItemScopeIsCurrent({ currentStoreId, localStateStoreId, itemStoreId } = {}) {
  const current = String(currentStoreId || "");
  const local = String(localStateStoreId || "");
  const item = String(itemStoreId || "");
  return Boolean(current && local && item && current === local && local === item);
}

export function scopedCategoryTrees({ treeStoreId, currentStoreId, zhTree, ruTree } = {}) {
  if (String(treeStoreId || "") !== String(currentStoreId || "")) {
    return { zhTree: [], ruTree: [] };
  }
  return {
    zhTree: structuredClone(Array.isArray(zhTree) ? zhTree : []),
    ruTree: structuredClone(Array.isArray(ruTree) ? ruTree : []),
  };
}

export function categoryTreeLoadStart(error = "") {
  return {
    zhTree: [],
    ruTree: [],
    treeStoreId: "",
    loading: true,
    error,
  };
}

export function categoryTreeLoadSuccess({ zhTree, ruTree, storeId } = {}) {
  return {
    zhTree: structuredClone(Array.isArray(zhTree) ? zhTree : []),
    ruTree: structuredClone(Array.isArray(ruTree) ? ruTree : []),
    treeStoreId: String(storeId || ""),
    loading: false,
    error: "",
  };
}

export function categoryTreeLoadFailure() {
  return {
    zhTree: [],
    ruTree: [],
    treeStoreId: "",
    loading: false,
    error: CATEGORY_DATA_ERROR_MESSAGE,
  };
}

export async function loadRealCategoryTrees({ readTree }) {
  try {
    const [zhResponse, ruResponse] = await Promise.all([
      readTree("ZH_HANS"),
      readTree("RU"),
    ]);
    const zhTree = itemsOf(zhResponse);
    const ruTree = itemsOf(ruResponse);
    if (!zhTree.length || !ruTree.length) throw new Error("empty category tree");
    return { zhTree, ruTree };
  } catch {
    const error = new Error(CATEGORY_DATA_ERROR_MESSAGE);
    error.code = "ZONGZI_CATEGORY_UI_UNAVAILABLE";
    throw error;
  }
}

export function categoryReadiness(input = {}) {
  const ready = Boolean(
    input.descriptionCategoryId
    && input.typeId
    && !input.loading
    && !input.error
    && !input.dictionaryLoading
    && !input.dictionaryError
    && Number(input.treeCount) > 0,
  );
  return { ready, message: ready ? "" : CATEGORY_DATA_ERROR_MESSAGE };
}

export function requireCategoryReadiness(input) {
  const result = categoryReadiness(input);
  if (!result.ready) {
    const error = new Error(result.message);
    error.code = "ZONGZI_CATEGORY_UI_UNAVAILABLE";
    throw error;
  }
  return true;
}
