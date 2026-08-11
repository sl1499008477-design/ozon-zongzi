const normalizedStoreId = (value) => {
  if (value === null || value === undefined) return "";
  return String(value);
};

export function createStoreSwitchGate() {
  let currentStoreId = "";
  return {
    begin(storeId) {
      const targetStoreId = normalizedStoreId(storeId);
      if (!targetStoreId || currentStoreId) return false;
      currentStoreId = targetStoreId;
      return true;
    },
    finish(storeId) {
      const targetStoreId = normalizedStoreId(storeId);
      if (!targetStoreId || currentStoreId !== targetStoreId) return false;
      currentStoreId = "";
      return true;
    },
    activeStoreId() {
      return currentStoreId;
    },
  };
}

export function storeSwitchActionState({ storeId, switchingStoreId } = {}) {
  const targetStoreId = normalizedStoreId(storeId);
  const activeStoreId = normalizedStoreId(switchingStoreId);
  const loading = Boolean(activeStoreId) && activeStoreId === targetStoreId;
  return {
    disabled: Boolean(activeStoreId),
    loading,
    label: loading ? "切换中…" : "切换",
  };
}
