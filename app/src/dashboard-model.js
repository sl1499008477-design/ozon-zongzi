export function dashboardCount(summary, section, field) {
  if (summary?.errors?.[section]) return null;
  const value = summary?.[section]?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function dashboardMoney(cents, currency = 'CNY') {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(String(cents))) return '—';
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  const units = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency === 'CNY' ? '¥' : currency} ${value < 0n ? '-' : ''}${units}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function dashboardTodos(summary, hasStore) {
  const rows = [];
  const review = dashboardCount(summary, 'ai', 'review');
  const failed = dashboardCount(summary, 'ai', 'failed');
  const unread = dashboardCount(summary, 'inspection', 'unreadCount');
  const out = hasStore ? dashboardCount(summary, 'products', 'outOfStock') : null;
  const low = hasStore ? dashboardCount(summary, 'products', 'lowStock') : null;
  if (review > 0) rows.push({ id: 'review', count: review, title: `${review} 个任务等待图片审核`, description: '审核后可继续上架', action: '去审核', path: '/ozon/tools/ai-listing?tab=tasks&group=active&stage=review' });
  if (failed > 0) rows.push({ id: 'failed', count: failed, title: `${failed} 个上架任务需要处理`, description: '查看失败原因与平台回执', action: '查看任务', path: '/ozon/tools/ai-listing?tab=tasks&group=all&stage=failed' });
  if (unread > 0) rows.push({ id: 'inspection', count: unread, title: `${unread} 单质检提醒尚未读`, description: '来自账号全部店铺', action: '查看质检', path: '/ozon/orders/quality?unread=1' });
  if (out > 0 || low > 0) rows.push({ id: 'stock', count: out > 0 ? out : low,
    title: out > 0 ? `${out} 个在售 SKU 缺货` : `${low} 个在售 SKU 低库存`,
    description: out > 0 && low !== null ? `另有 ${low} 个 SKU 库存为 1–10 件` : '当前店铺 · 库存为 1–10 件',
    action: '查看商品', path: `/ozon/products/list?stock=${encodeURIComponent(out > 0 ? '缺货' : '低库存')}` });
  return rows;
}
