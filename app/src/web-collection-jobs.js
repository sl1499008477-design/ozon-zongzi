export function webCollectionIntent(previous, { sku, scope }, newId = () => crypto.randomUUID()) {
  return previous?.sku === sku && previous?.scope === scope
    ? previous : { sku, scope, requestId: newId() };
}

export function webCollectionJobView(job) {
  const [label, color] = {
    QUEUED: ['等待扩展领取', 'default'], PROCESSING: ['正在采集', 'processing'],
    WAITING: ['需要处理', 'warning'], COMPLETED: ['资料已回传', 'success'],
    FAILED: ['采集失败', 'error'], CANCELLED: ['已取消', 'default'],
  }[job.status] || ['状态待确认', 'default'];
  return { label: job.status === 'COMPLETED' && job.result?.duplicate ? '已跳过重复采集' : label, color,
    canRetry: ['WAITING', 'FAILED', 'CANCELLED'].includes(job.status),
    retryLabel: job.status === 'WAITING' ? '已处理，继续采集' : '重试',
    canCancel: ['QUEUED', 'PROCESSING', 'WAITING'].includes(job.status),
  };
}
