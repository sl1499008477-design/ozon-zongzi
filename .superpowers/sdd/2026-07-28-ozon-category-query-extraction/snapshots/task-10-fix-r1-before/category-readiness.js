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
