export function createStoreDeletionController({ deleteStore, refresh, onStoreDeleted }) {
  return {
    async delete(store) {
      const storeId = store?.id || store?.storeId;
      const response = await deleteStore(storeId);
      const state = await refresh?.({ silent: true }) || response?.state || {};
      try {
        await onStoreDeleted?.({ deletedStore: store, state });
        return { state, cleanupError: null };
      } catch (cleanupError) {
        return { state, cleanupError };
      }
    },
  };
}
