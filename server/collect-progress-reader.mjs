// Reuse the Web collection projection, scoped to the IDs on the current page.
// Returning its draft and category fields also keeps completed items actionable.
export async function readCollectProgressForAccount({accountId, ids, readItems}) {
  if (!accountId) {
    throw Object.assign(new Error('请先登录'), {status:401, code:'COLLECT_ACCOUNT_REQUIRED'});
  }
  if (!Array.isArray(ids) || !ids.length || ids.length > 100
    || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 240)) {
    throw Object.assign(new Error('请指定 1 至 100 个采集条目 ID'), {status:400, code:'COLLECT_IDS_INVALID'});
  }
  const scopedIds = [...new Set(ids.map(id => id.trim()))];
  return {ok:true, data:await readItems({accountId, ids:scopedIds})};
}
