export const LISTING_WAREHOUSE_ELIGIBILITY_CODES = Object.freeze({
  eligible: "ELIGIBLE_ACTIVE_FBS",
  storeMismatch: "STORE_SCOPE_MISMATCH",
  typeMismatch: "TYPE_NOT_FBS",
  missingWarehouseId: "WAREHOUSE_ID_MISSING",
  disabled: "WAREHOUSE_DISABLED",
  noActiveProductAssociation: "NO_ACTIVE_PRODUCT_ASSOCIATION",
});

const DISABLED_STATUSES = new Set([
  "disabled",
  "archived",
  "archive",
  "inactive",
  "deleted",
  "blocked",
]);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

const firstText = (...values) => {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
};

const explicitTrue = (value) => value === true || lower(value) === "true" || Number(value) === 1;
const explicitFalse = (value) => value === false || lower(value) === "false" || clean(value) === "0";

const warehouseStoreId = (warehouse = {}) => firstText(
  warehouse.storeId,
  warehouse.store_id,
  warehouse.localStoreId,
  warehouse.local_store_id,
);

const warehouseAccountId = (warehouse = {}) => firstText(
  warehouse.accountId,
  warehouse.account_id,
  warehouse.ownerAccountId,
  warehouse.owner_account_id,
);

const platformWarehouseId = (warehouse = {}) => firstText(
  warehouse.warehouse_id,
  warehouse.warehouseId,
);

const warehouseType = (warehouse = {}) => lower(
  warehouse.warehouse_type ?? warehouse.warehouseType ?? warehouse.type,
);

const warehouseDisabled = (warehouse = {}) => {
  const status = lower(
    warehouse.status
    ?? warehouse.state
    ?? warehouse.warehouse_status
    ?? warehouse.warehouseStatus,
  );
  return DISABLED_STATUSES.has(status)
    || explicitTrue(warehouse.archived)
    || explicitTrue(warehouse.disabled)
    || explicitTrue(warehouse.isArchived)
    || explicitTrue(warehouse.is_archived)
    || explicitFalse(warehouse.isActive)
    || explicitFalse(warehouse.is_active)
    || explicitFalse(warehouse.active);
};

const productStoreId = (product = {}) => firstText(
  product.storeId,
  product.store_id,
  product.localStoreId,
  product.local_store_id,
);

const productAccountId = (product = {}) => firstText(product.accountId, product.account_id);

const productArchived = (product = {}) => {
  const status = lower(product.status);
  const visibility = lower(product.visibilityFilter ?? product.visibility_filter ?? product.visibility);
  return explicitTrue(product.is_archived)
    || explicitTrue(product.isArchived)
    || explicitTrue(product.archived)
    || status === "archived"
    || visibility === "archived";
};

const rows = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.stocks)) return value.stocks;
  if (Array.isArray(value.result)) return value.result;
  if (Array.isArray(value.result?.items)) return value.result.items;
  if (Array.isArray(value.result?.stocks)) return value.result.stocks;
  return [];
};

const productStockRows = (product = {}) => [
  ...rows(product.warehouse_stocks).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.warehouseStocks).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.stock_by_warehouse).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.stockByWarehouse).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.stocks_by_warehouse).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.stocksByWarehouse).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.fbs_warehouse_stocks).map((row) => ({ row, fallbackSource: "fbs" })),
  ...rows(product.fbsWarehouseStocks).map((row) => ({ row, fallbackSource: "fbs" })),
  ...rows(product.stocks?.warehouse_stocks).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.stocks?.warehouseStocks).map((row) => ({ row, fallbackSource: "" })),
  ...rows(product.stocks?.stocks).map((row) => ({ row, fallbackSource: "" })),
];

const stockWarehouseId = (stock = {}) => firstText(
  stock.warehouse_id,
  stock.warehouseId,
  stock.warehouse?.warehouse_id,
  stock.warehouse?.warehouseId,
);

const stockSource = (stock = {}, fallbackSource = "") => lower(
  stock.source ?? stock.warehouse_type ?? stock.warehouseType ?? stock.type ?? fallbackSource,
);

const productProvesAssociation = ({
  product,
  targetStoreId,
  accountId,
  warehouseId,
} = {}) => {
  if (!product || productArchived(product)) return false;
  if (!targetStoreId || productStoreId(product) !== targetStoreId) return false;
  const scopedProductAccountId = productAccountId(product);
  if (accountId && scopedProductAccountId && scopedProductAccountId !== accountId) return false;
  return productStockRows(product).some(({ row, fallbackSource }) =>
    stockWarehouseId(row) === warehouseId && stockSource(row, fallbackSource) === "fbs");
};

const result = (eligible, code) => ({ eligible, code });

export function listingWarehouseEligibility({
  warehouse,
  products = [],
  targetStoreId,
  accountId,
  hasActiveProductAssociation,
} = {}) {
  const scopedTargetStoreId = clean(targetStoreId);
  const scopedAccountId = clean(accountId);
  const record = warehouse && typeof warehouse === "object" ? warehouse : null;
  if (!record || !scopedTargetStoreId || warehouseStoreId(record) !== scopedTargetStoreId) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.storeMismatch);
  }
  const recordAccountId = warehouseAccountId(record);
  if (scopedAccountId && recordAccountId && recordAccountId !== scopedAccountId) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.storeMismatch);
  }
  if (warehouseType(record) !== "fbs") {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.typeMismatch);
  }
  const warehouseId = platformWarehouseId(record);
  if (!warehouseId || lower(warehouseId).startsWith("wh_")) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.missingWarehouseId);
  }
  if (warehouseDisabled(record)) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.disabled);
  }
  const associated = typeof hasActiveProductAssociation === "boolean"
    ? hasActiveProductAssociation
    : (Array.isArray(products) ? products : []).some((product) => productProvesAssociation({
        product,
        targetStoreId: scopedTargetStoreId,
        accountId: scopedAccountId,
        warehouseId,
      }));
  if (!associated) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.noActiveProductAssociation);
  }
  return result(true, LISTING_WAREHOUSE_ELIGIBILITY_CODES.eligible);
}

export function assertListingWarehouseEligible(input = {}) {
  const eligibility = listingWarehouseEligibility(input);
  if (eligibility.eligible) return eligibility;
  throw Object.assign(new Error("请选择当前店铺的活跃 FBS 仓库"), {
    status: 422,
    code: "LISTING_WAREHOUSE_NOT_ELIGIBLE",
    body: { reason: eligibility.code },
  });
}
