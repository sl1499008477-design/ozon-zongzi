export const stockEntries = (item = {}) =>
  Array.isArray(item.stocks?.stocks) ? item.stocks.stocks : [];

export const productStatus = (item = {}) =>
  item.statuses?.status_name ||
  item.statuses?.status ||
  item.visibility ||
  item.status ||
  item.state ||
  "—";

export const PRODUCT_STATUS_BUCKETS = [
  { label: "销售中", tone: "success" },
  { label: "准备销售", tone: "processing" },
  { label: "错误", tone: "danger" },
  { label: "待修改", tone: "edit" },
  { label: "商品已下架", tone: "offline" },
  { label: "档案", tone: "archive" },
];

export const productStatusMeta = (item = {}) => {
  const raw = String(productStatus(item) || "").trim();
  const rawSource = raw.toLowerCase();
  const rawHas = (tokens) => tokens.some((token) => rawSource.includes(token));
  const truthyFlag = (value) => value === true || String(value || "").toLowerCase() === "true";
  const visibilitySource = [
    item.visibility,
    item.visibilityFilter,
    item._visibility,
    item.product_visibility,
    item.productVisibility,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const isArchived =
    truthyFlag(item.is_archived) ||
    truthyFlag(item.archived) ||
    ["archived", "archive", "архив"].some((token) => visibilitySource.includes(token));
  const statusSource = [
    raw,
    item.statuses?.status,
    item.statuses?.status_name,
    item.statuses?.status_failed,
    item.statuses?.moderate_status,
    item.statuses?.validation_status,
    item.statuses?.status_description,
    item.statuses?.status_tooltip,
    item.visibility,
    item.visibilityFilter,
    item.status,
    item.state,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const has = (tokens) => tokens.some((token) => statusSource.includes(token));

  if (isArchived) return { label: "档案", tone: "archive", raw: raw || "档案" };
  if (!raw || raw === "—") return { label: "—", tone: "muted", raw };
  if (rawHas(["ошибка", "error", "failed", "rejected", "declined"])) return { label: "错误", tone: "danger", raw };
  if (rawHas(["не продается", "not for sale", "hidden", "inactive"])) return { label: "商品已下架", tone: "offline", raw };
  if (rawHas(["архив", "archived", "archive"])) return { label: "档案", tone: "archive", raw };
  if (rawHas(["продается", "for_sale", "for sale", "selling", "visible", "active", "on sale"])) {
    return { label: "销售中", tone: "success", raw };
  }
  if (rawHas(["готов", "ready", "pending", "moderation", "created"])) return { label: "准备销售", tone: "processing", raw };
  if (has(["ошибка", "error", "validation_error", "moderation_failed"])) {
    return { label: "错误", tone: "danger", raw };
  }
  if (has(["failed", "rejected", "declined", "invalid", "need", "edit", "исправ", "отклон"])) {
    return { label: "待修改", tone: "edit", raw };
  }
  if (has(["не продается", "not for sale", "hidden", "inactive", "stopped", "disabled", "blocked", "quarantine"])) {
    return { label: "商品已下架", tone: "offline", raw };
  }
  if (has(["архив", "archived", "archive"])) {
    return { label: "档案", tone: "archive", raw };
  }
  if (has(["готов", "ready", "price_sent", "pending", "moderation", "created"])) {
    return { label: "准备销售", tone: "processing", raw };
  }
  if (has(["продается", "for_sale", "for sale", "selling", "visible", "active", "on sale"])) {
    return { label: "销售中", tone: "success", raw };
  }
  return { label: raw, tone: "default", raw };
};

export const productStatusFilterOptions = (products = []) => {
  const statusMap = new Map(PRODUCT_STATUS_BUCKETS.map((item) => [item.label, { ...item, count: 0 }]));
  for (const product of products) {
    const meta = productStatusMeta(product);
    const current = statusMap.get(meta.label);
    if (!current) continue;
    current.count += 1;
  }
  return PRODUCT_STATUS_BUCKETS.map((item) => statusMap.get(item.label) || { ...item, count: 0 });
};

export const productSearchText = (item = {}) =>
  [
    item.name,
    item.offer_id,
    item.product_id,
    item.id,
    item.barcode,
    item.sku,
    ...(Array.isArray(item.barcodes) ? item.barcodes : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export const productMatchesQuery = (item, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || productSearchText(item).includes(normalized);
};

export const stockNumber = (item = {}) => {
  const nested = stockEntries(item);
  if (nested.length) {
    return nested.reduce((sum, row) => sum + (Number(row.present) || 0), 0);
  }
  return Number(item.stocks?.present ?? item.stocks?.available ?? item.stock ?? 0) || 0;
};

// Unknown inventory must not appear as an out-of-stock alert.
export function productKnownStockValue(item = {}) {
  const numeric = value => !['number','string'].includes(typeof value) || String(value).trim() === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const saved = numeric(item.stock_total);
  if (saved !== null) return saved;
  const nested = stockEntries(item);
  if (nested.length) {
    const values = nested.map(row => numeric(row.present));
    return values.includes(null) ? null : values.reduce((sum, value) => sum + value, 0);
  }
  return numeric(item.stocks?.present ?? item.stocks?.available ?? item.stock);
}

export const productMatchesStockFilter = (item, filter) => {
  if (!['缺货','低库存','attention'].includes(filter)) return true;
  const stock = productKnownStockValue(item);
  if (stock === null) return false;
  if (filter === "attention") return stock <= 10;
  if (filter === "缺货") return stock <= 0;
  if (filter === "低库存") return stock > 0 && stock <= 10;
  return true;
};

export function productCatalogPage(products, {page=1, pageSize=5, status='销售中', stock='全部', q=''}={}) {
  const statusOptions = productStatusFilterOptions(products);
  const statusProducts = products.filter(item => productStatusMeta(item).label === status);
  const stockCounts = Object.fromEntries(['全部', '缺货', '低库存'].map(filter => [filter, statusProducts.filter(item => productMatchesStockFilter(item, filter)).length]));
  const matched = statusProducts.filter(item => productMatchesQuery(item, q) && productMatchesStockFilter(item, stock));
  const current = Math.min(page, Math.max(1, Math.ceil(matched.length / pageSize)));
  return {items: matched.slice((current-1)*pageSize, current*pageSize), total: matched.length, page: current, pageSize, statusOptions, stockCounts};
}
