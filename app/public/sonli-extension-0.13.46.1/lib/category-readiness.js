(() => {
  const MESSAGE = "未能从 Ozon 获取真实类目数据，请重试";

  function storeIdOf(state) {
    return String(state?.storeId ?? state?.opts?.storeId ?? "").trim();
  }

  function categoryIds(category) {
    return {
      typeId: String(category?.typeId ?? "").trim(),
      descCatId: String(category?.descCatId ?? "").trim(),
    };
  }

  function failTree(state) {
    state.catTree = null;
    state.catTreeLoading = false;
    state.catTreeError = MESSAGE;
    state.categoryDataError = MESSAGE;
    state.categoryDataReady = false;
    state.catPath = [];
    state.category = null;
    state.attrsSchema = [];
    state.reqAttrs = [];
    state.ratingAttrs = [];
  }

  function failAttributes(state) {
    state.categoryDataError = MESSAGE;
    state.categoryDataReady = false;
    state.attrsSchema = [];
    state.reqAttrs = [];
    state.ratingAttrs = [];
  }

  function markReady(state) {
    state.categoryDataError = "";
    state.categoryDataReady = true;
  }

  function requireReady(state) {
    if (state.categoryDataError || !state.categoryDataReady || !state.category) {
      throw new Error(MESSAGE);
    }
    return true;
  }

  function captureReadyScope(state) {
    requireReady(state);
    const storeId = storeIdOf(state);
    const ids = categoryIds(state.category);
    if (!storeId || !ids.typeId) throw new Error(MESSAGE);
    return Object.freeze({
      storeId,
      category: state.category,
      ...ids,
    });
  }

  function requireReadyScope(state, scope) {
    requireReady(state);
    const ids = categoryIds(state.category);
    if (!scope
      || state.category !== scope.category
      || storeIdOf(state) !== scope.storeId
      || ids.typeId !== scope.typeId
      || ids.descCatId !== scope.descCatId) {
      throw new Error(MESSAGE);
    }
    return true;
  }

  function invalidateRestored(state) {
    state.catTree = null;
    state.catTreeLoading = false;
    state.categoryDataError = MESSAGE;
    state.categoryDataReady = false;
    state.attrsSchema = [];
    state.reqAttrs = [];
    state.ratingAttrs = [];
  }

  function asyncCategoryScopeIsCurrent({
    expectedStoreId,
    currentStoreId,
    expectedTree,
    currentTree,
    requestId,
    currentRequestId,
  } = {}) {
    return !!String(expectedStoreId || '').trim()
      && expectedStoreId === currentStoreId
      && !!expectedTree
      && expectedTree === currentTree
      && Number.isFinite(Number(requestId))
      && requestId === currentRequestId;
  }

  globalThis.SonliCategoryReadiness = {
    failTree,
    failAttributes,
    markReady,
    requireReady,
    captureReadyScope,
    requireReadyScope,
    invalidateRestored,
    asyncCategoryScopeIsCurrent,
  };
})();
