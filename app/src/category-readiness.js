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

export function categoryResolutionForStore(resolution, targetStoreId) {
  if (!resolution || typeof resolution !== "object") return null;
  const resolutionStoreId = resolution.status === "MATCHED"
    ? resolution.target?.storeId
    : resolution.targetStoreId;
  if (String(resolutionStoreId || "") !== String(targetStoreId || "")) return null;
  if (resolution.status === "PENDING") return structuredClone(resolution);
  if (resolution.status !== "MATCHED") return null;
  if (!positiveNumber(resolution.target?.descriptionCategoryId) || !positiveNumber(resolution.target?.typeId)) return null;
  return structuredClone(resolution);
}

export function manualCategoryResolution({
  source,
  targetStoreId,
  descriptionCategoryId,
  typeId,
  resolvedAt,
} = {}) {
  return {
    status: "MATCHED",
    method: "MANUAL",
    source: normalizedSourceCategory(source),
    target: {
      storeId: String(targetStoreId || ""),
      descriptionCategoryId: positiveNumber(descriptionCategoryId),
      typeId: positiveNumber(typeId),
    },
    resolvedAt: String(resolvedAt || new Date().toISOString()),
  };
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
    error.code = "OZON_CATEGORY_UI_UNAVAILABLE";
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
    error.code = "OZON_CATEGORY_UI_UNAVAILABLE";
    throw error;
  }
  return true;
}
