import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  categoryRequestIsCurrent,
  categoryRequestScope,
  categoryTreeLoadFailure,
  categoryTreeLoadStart,
  categoryTreeLoadSuccess,
  loadRealCategoryTrees,
  scopedCategoryTrees,
} from "./category-readiness.js";

export function useCategoryTreeReadiness({ hasStore, currentStoreId, itemId, readTree }) {
  const [categoryTreeZh, setCategoryTreeZh] = useState([]);
  const [categoryTreeRu, setCategoryTreeRu] = useState([]);
  const [categoryTreeLoading, setCategoryTreeLoading] = useState(true);
  const [categoryTreeStoreId, setCategoryTreeStoreId] = useState("");
  const [categoryDataError, setCategoryDataError] = useState("");
  const [categoryAutoLoading, setCategoryAutoLoading] = useState(false);
  const categoryTreeLoadRequestRef = useRef(0);
  const categoryDataErrorRef = useRef("");
  const categoryAutoRequestRef = useRef({ requestId: 0, scope: "" });
  const categoryAutoScope = categoryRequestScope({ storeId: currentStoreId, itemId });

  if (categoryAutoRequestRef.current.scope !== categoryAutoScope) {
    categoryAutoRequestRef.current = {
      requestId: categoryAutoRequestRef.current.requestId + 1,
      scope: categoryAutoScope,
    };
  }

  const scopedTrees = useMemo(() => scopedCategoryTrees({
    treeStoreId: categoryTreeStoreId,
    currentStoreId,
    zhTree: categoryTreeZh,
    ruTree: categoryTreeRu,
  }), [categoryTreeStoreId, currentStoreId, categoryTreeZh, categoryTreeRu]);

  const applyCategoryTreeLoadState = useCallback((nextState) => {
    setCategoryTreeZh(nextState.zhTree);
    setCategoryTreeRu(nextState.ruTree);
    setCategoryTreeStoreId(nextState.treeStoreId);
    categoryDataErrorRef.current = nextState.error;
    setCategoryDataError(nextState.error);
    setCategoryTreeLoading(nextState.loading);
  }, []);

  const loadCategoryTrees = useCallback(async () => {
    const requestId = categoryTreeLoadRequestRef.current + 1;
    categoryTreeLoadRequestRef.current = requestId;
    if (!hasStore || !currentStoreId) {
      applyCategoryTreeLoadState({
        zhTree: [],
        ruTree: [],
        treeStoreId: "",
        loading: false,
        error: "",
      });
      return;
    }
    applyCategoryTreeLoadState(categoryTreeLoadStart(categoryDataErrorRef.current));
    try {
      const { zhTree, ruTree } = await loadRealCategoryTrees({ readTree });
      if (categoryTreeLoadRequestRef.current !== requestId) return;
      applyCategoryTreeLoadState(categoryTreeLoadSuccess({
        zhTree,
        ruTree,
        storeId: currentStoreId,
      }));
    } catch {
      if (categoryTreeLoadRequestRef.current !== requestId) return;
      applyCategoryTreeLoadState(categoryTreeLoadFailure());
    }
  }, [applyCategoryTreeLoadState, currentStoreId, hasStore, readTree]);

  useEffect(() => {
    setCategoryAutoLoading(false);
  }, [categoryAutoScope]);

  useEffect(() => {
    loadCategoryTrees();
    return () => {
      categoryTreeLoadRequestRef.current += 1;
    };
  }, [loadCategoryTrees]);

  const beginCategoryAutoRequest = useCallback(() => {
    const request = {
      requestId: categoryAutoRequestRef.current.requestId + 1,
      scope: categoryAutoScope,
    };
    categoryAutoRequestRef.current = request;
    setCategoryAutoLoading(true);
    return request;
  }, [categoryAutoScope]);

  const categoryAutoRequestIsCurrent = useCallback((request) => categoryRequestIsCurrent({
    ...request,
    currentRequestId: categoryAutoRequestRef.current.requestId,
    currentScope: categoryAutoRequestRef.current.scope,
  }), []);

  const finishCategoryAutoRequest = useCallback((request) => {
    if (!categoryAutoRequestIsCurrent(request)) return false;
    setCategoryAutoLoading(false);
    return true;
  }, [categoryAutoRequestIsCurrent]);

  const categoryTreeReady = Boolean(
    !categoryTreeLoading
    && !categoryDataError
    && String(categoryTreeStoreId) === String(currentStoreId)
    && scopedTrees.zhTree.length
    && scopedTrees.ruTree.length,
  );

  return {
    scopedTrees,
    categoryTreeLoading,
    categoryDataError,
    categoryTreeReady,
    loadCategoryTrees,
    categoryAutoLoading,
    beginCategoryAutoRequest,
    categoryAutoRequestIsCurrent,
    finishCategoryAutoRequest,
  };
}
