export const taskControlActions = ['pause', 'cancel', 'delete', 'retry', 'resume'];
export const taskControlGroups = ['active', 'paused', 'failed', 'errors', 'cancelled', 'deleted'];
const failures = new Set(['COLLECTION_FAILED', 'GENERATION_FAILED', 'UPLOAD_FAILED', 'SUBMISSION_FAILED', 'SUBMISSION_UNCERTAIN']);
const active = new Set(['QUEUED', 'COLLECTING', 'GENERATING', 'AWAITING_REVIEW', 'READY_TO_SUBMIT']);
export const submissionPreparing = task => ['preparing_media','prepared'].includes(task.submissionStage) && task.submissionExternalWriteStarted !== true;

// Shared by single actions, batch previews and list DTOs. All writes still check the account and version.
export function taskActionReason(task, action) {
  const recoverSkipped=task.status==='COMPLETED'&&action==='retry'&&task.config?.salePricingId
    && (task.source?.skuPricing||task.skuProgress||[]).some(row=>row.status==='SKIPPED');
  if (task.permanentlyDeletedAt) return '该任务已永久删除';
  if (task.purge && (action !== 'permanentDelete' || task.purge.state !== 'FAILED')) return '永久清理已开始，不能恢复或修改';
  if (action === 'permanentDelete') {
    if (!task.deletedAt || task.controlAction) return '仅已删除且已停止的任务可以永久删除';
    return '';
  }
  if (['COMPLETED','MERGED'].includes(task.status)&&!recoverSkipped) return '该任务已结束或已删除';
  if (task.controlAction) return '正在保存当前结果，请等待操作完成';
  const preparing = submissionPreparing(task);
  const submitted = !preparing && (task.submissionStarted || task.submissionId || ['SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNCERTAIN', 'SUBMISSION_FAILED'].includes(task.status));
  if (task.deletedAt) {
    if (action !== 'resume') return '该任务已删除，请先恢复原任务';
    // Restoring an error only makes its retained record visible; it does not requeue work.
    if (failures.has(task.stoppedFrom)) return '';
    if (task.stoppedFrom === 'SUBMISSION_UNCERTAIN' || (submitted && task.stoppedFrom !== 'SUBMISSION_FAILED')) {
      return '上架请求已发出或结果待核实，不能通过恢复重放';
    }
    return '';
  }
  const partialFailure=task.status==='SUBMITTED' && ((task.submissionResults||[]).some(row=>row.importStatus==='FAILED'||row.stockStatus==='FAILED'||row.publicationStatus==='IMAGE_FAILED')
    || task.failedSubmissionSkuCount>0 || task.imageFailedSkuCount>0);
  if (action === 'retry') return failures.has(task.status)||recoverSkipped||partialFailure ? '' : '仅失败任务可以重试';
  if (action === 'resume') return ['PAUSED', 'CANCELLED'].includes(task.status) && (!submitted || task.status==='PAUSED'&&task.stoppedFrom==='SUBMITTED'&&task.submissionId) ? '' : '仅暂停或取消且可安全继续的任务可以恢复';
  // Recovered images may await review while earlier SKUs retain their submission identity.
  if (action === 'approve') return task.status === 'AWAITING_REVIEW' ? '' : '当前任务不在待审核状态';
  if (action === 'delete') {
    // Error tasks may be archived without deleting their images or submission journal.
    if (failures.has(task.status)) return '';
    if ((!preparing && ['SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNCERTAIN'].includes(task.status))
      || (submitted && task.status !== 'SUBMISSION_FAILED')) return '上架请求已发出或结果待核实，暂不能删除';
    return '';
  }
  // This stops local polling and future writes, not requests Ozon already received.
  if (action === 'pause' && task.status==='SUBMITTED' && task.submissionId) return '';
  if (submitted) return '上架提交已开始，不能中断已发送的请求';
  if (action === 'pause') return active.has(task.status) || preparing && ['SUBMITTING','SUBMITTED'].includes(task.status) ? '' : '仅执行中的任务可以暂停';
  if (action === 'cancel') return task.status !== 'CANCELLED' ? '' : '任务已取消';
  return '不支持的任务操作';
}

export function taskActions(task) {
  return Object.fromEntries([...taskControlActions, 'approve', 'permanentDelete'].map(action => [action, !taskActionReason(task, action)]));
}

export function finishTaskControl(task, action, now) {
  // Keep the original stage when a paused task is subsequently cancelled.
  if (!['PAUSED', 'CANCELLED'].includes(task.status)) task.stoppedFrom = task.status;
  task.status = action === 'pause' ? 'PAUSED' : 'CANCELLED';
  if (action === 'delete') task.deletedAt = now;
  task.controlAction = null;
  task.updatedAt = now;
  return task;
}

export function resumedTaskStatus(task) {
  if (task.stoppedFrom==='SUBMITTED'&&task.submissionId) return 'SUBMITTED';
  // Resuming never authorizes a second paid request after a known/uncertain failure.
  if (failures.has(task.stoppedFrom)) return task.stoppedFrom;
  return !task.source ? 'QUEUED' : task.images.some(image => !image.generatedUrl) ? 'GENERATING'
    : task.config.manualReview && !task.approved ? 'AWAITING_REVIEW' : 'READY_TO_SUBMIT';
}
