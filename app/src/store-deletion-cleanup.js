export function createStoreDeletionCleanup({
  clearStoreStorage,
  readToken,
  setCurrentStoreId,
  syncAuthToExtension,
  logoutExtension,
}) {
  return async function onStoreDeleted({ deletedStore, state }) {
    const nextStoreId = state?.currentStoreId || "";
    if (nextStoreId) {
      setCurrentStoreId(nextStoreId);
      const synchronized = await syncAuthToExtension({
        token: readToken(),
        storeId: nextStoreId,
      });
      if (!synchronized) throw new Error("扩展认证同步失败");
      return;
    }
    clearStoreStorage(deletedStore);
    const loggedOut = await logoutExtension();
    if (!loggedOut) throw new Error("扩展登出失败");
  };
}
