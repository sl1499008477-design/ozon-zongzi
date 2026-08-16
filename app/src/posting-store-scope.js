const postingStoreId = (posting = {}) => String(
  posting.storeId
  || posting.store_id
  || posting.ozonStoreId
  || posting.currentOzonStoreId
  || posting.localStoreId
  || "",
).trim();

export const scopedPostingsForCurrentStore = (postings = [], binding = {}, localData = {}) => {
  const currentStoreId = String(localData?.currentStoreId || binding?.id || "").trim();
  if (!currentStoreId) return [];
  return (Array.isArray(postings) ? postings : [])
    .filter((posting) => postingStoreId(posting) === currentStoreId);
};
