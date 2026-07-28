import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const CATEGORY_DICTIONARY_ERROR_MESSAGE =
  "未能从 Ozon 获取真实类目数据，请重试";

export function dictionaryRowsOfResponse(response) {
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.data)) return response.data;
  const error = new Error(CATEGORY_DICTIONARY_ERROR_MESSAGE);
  error.code = "OZON_CATEGORY_UI_UNAVAILABLE";
  throw error;
}

function normalizedTargetsOf(targets) {
  return (Array.isArray(targets) ? targets : [])
    .map((target) => ({
      key: String(target?.key || ""),
      attributeId: Number(target?.attributeId),
    }))
    .filter((target) => target.key && Number.isInteger(target.attributeId) && target.attributeId > 0);
}

function requestScopeOf({ storeId, itemId, descriptionCategoryId, typeId, targets } = {}) {
  return JSON.stringify([
    String(storeId || ""),
    String(itemId || ""),
    Number(descriptionCategoryId) || 0,
    Number(typeId) || 0,
    normalizedTargetsOf(targets).map(({ key, attributeId }) => [key, attributeId]),
  ]);
}

export function categoryDictionaryReadiness(state = {}) {
  const targetKeys = Array.isArray(state.targetKeys) ? state.targetKeys : [];
  const options = state.options && typeof state.options === "object" ? state.options : {};
  const ready = Boolean(
    !state.loading
    && !state.error
    && (targetKeys.length === 0 || (
      state.complete
      && targetKeys.every((key) => Object.prototype.hasOwnProperty.call(options, key))
    )),
  );
  return {
    ready,
    message: ready ? "" : CATEGORY_DICTIONARY_ERROR_MESSAGE,
  };
}

export function createCategoryDictionaryRequestController({
  readValues,
  formatOption,
  onState,
} = {}) {
  let currentRequest = { generation: 0, scope: "" };
  let lastState = { scope: "", error: "" };

  const publish = (state) => {
    lastState = state;
    onState(state);
  };

  const requestIsCurrent = (request) => (
    request.generation === currentRequest.generation
    && request.scope === currentRequest.scope
  );

  const invalidate = (scope = "") => {
    if (scope && currentRequest.scope !== scope) return false;
    currentRequest = {
      generation: currentRequest.generation + 1,
      scope: currentRequest.scope,
    };
    return true;
  };

  const load = async (input = {}) => {
    const targets = normalizedTargetsOf(input.targets);
    const scope = requestScopeOf({ ...input, targets });
    const visibleError = currentRequest.scope === scope ? lastState.error : "";
    const request = {
      generation: currentRequest.generation + 1,
      scope,
    };
    currentRequest = request;
    const targetKeys = targets.map(({ key }) => key);
    publish({
      scope,
      targetKeys,
      options: {},
      loading: targets.length > 0,
      error: visibleError,
      complete: targets.length === 0,
    });
    if (!targets.length) return true;

    try {
      const entries = await Promise.all(targets.map(async ({ key, attributeId }) => {
        const rows = await readValues({
          storeId: input.storeId,
          itemId: input.itemId,
          descriptionCategoryId: Number(input.descriptionCategoryId),
          typeId: Number(input.typeId),
          attributeId,
          generation: request.generation,
        });
        if (!Array.isArray(rows)) throw new Error("invalid dictionary rows");
        return [
          key,
          rows.map(formatOption).filter(Boolean),
        ];
      }));
      if (!requestIsCurrent(request)) return false;
      publish({
        scope,
        targetKeys,
        options: Object.fromEntries(entries),
        loading: false,
        error: "",
        complete: true,
      });
      return true;
    } catch {
      if (!requestIsCurrent(request)) return false;
      publish({
        scope,
        targetKeys,
        options: {},
        loading: false,
        error: CATEGORY_DICTIONARY_ERROR_MESSAGE,
        complete: false,
      });
      return true;
    }
  };

  return { invalidate, load };
}

export function useCategoryDictionaryReadiness({
  storeId,
  itemId,
  descriptionCategoryId,
  typeId,
  targets,
  readValues,
  formatOption,
}) {
  const normalizedTargetsKey = JSON.stringify(normalizedTargetsOf(targets));
  const normalizedTargets = useMemo(
    () => JSON.parse(normalizedTargetsKey),
    [normalizedTargetsKey],
  );
  const scope = requestScopeOf({
    storeId,
    itemId,
    descriptionCategoryId,
    typeId,
    targets: normalizedTargets,
  });
  const [state, setState] = useState({
    scope: "",
    targetKeys: [],
    options: {},
    loading: false,
    error: "",
    complete: false,
  });
  const readValuesRef = useRef(readValues);
  const formatOptionRef = useRef(formatOption);
  readValuesRef.current = readValues;
  formatOptionRef.current = formatOption;
  const controllerRef = useRef(null);
  if (!controllerRef.current) {
    controllerRef.current = createCategoryDictionaryRequestController({
      readValues: (input) => readValuesRef.current(input),
      formatOption: (row) => formatOptionRef.current(row),
      onState: setState,
    });
  }
  const renderScopeRef = useRef("");
  if (renderScopeRef.current !== scope) {
    controllerRef.current.invalidate();
    renderScopeRef.current = scope;
  }
  const requestInput = useMemo(() => ({
    storeId,
    itemId,
    descriptionCategoryId,
    typeId,
    targets: normalizedTargets,
  }), [scope]);

  useEffect(() => {
    controllerRef.current.load(requestInput);
    return () => {
      controllerRef.current.invalidate(scope);
    };
  }, [requestInput, scope]);

  const retryCategoryDictionaryValues = useCallback(
    () => controllerRef.current.load(requestInput),
    [requestInput],
  );
  const scopedState = state.scope === scope
    ? state
    : {
        scope,
        targetKeys: normalizedTargets.map(({ key }) => key),
        options: {},
        loading: normalizedTargets.length > 0,
        error: "",
        complete: normalizedTargets.length === 0,
      };
  const readiness = categoryDictionaryReadiness(scopedState);

  return {
    categoryAttributeOptions: scopedState.options,
    categoryDictionaryLoading: scopedState.loading,
    categoryDictionaryError: scopedState.error,
    categoryDictionaryReady: readiness.ready,
    retryCategoryDictionaryValues,
  };
}
