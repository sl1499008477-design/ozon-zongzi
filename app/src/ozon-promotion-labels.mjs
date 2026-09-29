const TITLES = new Map([
  ['максимальный бустинг: усиление', '最大提升（加强版）'],
  ['максимальный бустинг', '最大提升'],
  ['учебные скидки', '学校用品折扣'],
  ['эластичный бустинг. без ограничения срока действия', '弹性提升（不限期）'],
]);

const TYPES = new Map([
  ['ELASTIC_BOOSTING', '弹性提升'],
  ['STOCK_DISCOUNT', '库存折扣'],
]);

export function ozonPromotionTypeLabel(type) {
  const value = String(type ?? '').trim().toUpperCase();
  return value ? TYPES.get(value) || '其他平台活动' : '类型未提供';
}

// Display only: preserve source titles and IDs for matching, pricing and API writes.
export function ozonPromotionTitle(action = {}) {
  const raw = String(action.title ?? '').trim();
  const normalized = raw.replace(/\s+/g, ' ').replace(/[.。]+$/, '').toLowerCase();
  const type = TYPES.get(String(action.type ?? action.action_type ?? '').trim().toUpperCase());
  const chineseTitle = /[\u3400-\u9fff]/.test(raw) && !/\p{Script=Cyrillic}/u.test(raw);
  const label = TITLES.get(normalized) || (chineseTitle ? raw : type ? `${type}活动` : '平台活动');
  const id = String(action.id ?? action.action_id ?? '').trim();
  return id ? `${label}（ID ${id}）` : label;
}
