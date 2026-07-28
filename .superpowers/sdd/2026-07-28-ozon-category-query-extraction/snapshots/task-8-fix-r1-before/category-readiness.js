(() => {
  const MESSAGE = "未能从 Ozon 获取真实类目数据，请重试";

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

  globalThis.SonliCategoryReadiness = {
    failTree,
    failAttributes,
    markReady,
    requireReady,
  };
})();
