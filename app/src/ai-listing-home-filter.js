export const AI_HOME_STAGE_LABELS = Object.freeze({
  review: '待人工审核', enrichment: '资料待补全', generating: '生图中',
  submitting: '上架提交中', attention: '上架需处理', failed: '失败与错误任务',
});

export function aiListingHomeFilter(search = '') {
  const query = new URLSearchParams(search);
  const requestedStage = query.get('stage');
  const stage = Object.hasOwn(AI_HOME_STAGE_LABELS, requestedStage) ? requestedStage : '';
  if (stage) return { stage, group: ['failed', 'attention'].includes(stage) ? 'all' : 'active' };
  const requestedGroup = query.get('group');
  return { stage: '', group: ['active', 'paused', 'failed', 'errors', 'cancelled', 'deleted'].includes(requestedGroup) ? requestedGroup : 'active' };
}

export function aiListingTaskListPath({ group, stage, page, pageSize }) {
  const query = new URLSearchParams({ view: 'tasks', group });
  if (stage) query.set('stage', stage);
  query.set('limit', String(pageSize));
  query.set('offset', String((page - 1) * pageSize));
  return `/ai-listing/tasks?${query}`;
}
