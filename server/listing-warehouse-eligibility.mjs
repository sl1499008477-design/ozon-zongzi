export const LISTING_WAREHOUSE_ELIGIBILITY_CODES = Object.freeze({
  eligible: "ELIGIBLE_ACTIVE_FBS",
  eligibleRfbs: "ELIGIBLE_ACTIVE_RFBS",
  storeMismatch: "STORE_SCOPE_MISMATCH",
  unsupportedFulfillmentType: "UNSUPPORTED_FULFILLMENT_TYPE",
  missingWarehouseId: "WAREHOUSE_ID_MISSING",
  disabled: "WAREHOUSE_DISABLED",
  noActiveProductAssociation: "NO_ACTIVE_PRODUCT_ASSOCIATION",
  rfbsValidationRequired: "RFBS_VALIDATION_REQUIRED",
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
const upper = (value) => clean(value).toUpperCase();

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

const fulfillmentType = (warehouse = {}) => warehouseType(warehouse).toUpperCase() || "UNKNOWN";

const result = (eligible, code, type, evidenceRequired) => ({
  eligible,
  code,
  fulfillmentType: type,
  evidenceRequired,
});

const warehouseRecordId = (warehouse = {}) => firstText(
  warehouse.id,
  warehouse.warehouseRecordId,
  warehouse.warehouse_record_id,
);

const validRfbsEvidence = ({ evidence, warehouse, accountId, targetStoreId, now } = {}) => {
  if (!evidence || typeof evidence !== "object") return false;
  const expiresAt = Date.parse(evidence.expiresAt);
  const evaluatedAt = Date.parse(now ?? new Date().toISOString());
  return evidence.outcome === "PASSED"
    && clean(evidence.accountId) === accountId
    && clean(evidence.storeId) === targetStoreId
    && clean(evidence.warehouseRecordId) === warehouseRecordId(warehouse)
    && clean(evidence.platformWarehouseId) === platformWarehouseId(warehouse)
    && upper(evidence.fulfillmentType) === "RFBS"
    && Number.isFinite(expiresAt)
    && Number.isFinite(evaluatedAt)
    && expiresAt > evaluatedAt;
};

export function listingWarehouseEligibility({
  warehouse,
  products = [],
  targetStoreId,
  accountId,
  hasActiveProductAssociation,
  validationEvidence,
  now,
} = {}) {
  const scopedTargetStoreId = clean(targetStoreId);
  const scopedAccountId = clean(accountId);
  const record = warehouse && typeof warehouse === "object" ? warehouse : null;
  if (!record || !scopedTargetStoreId || warehouseStoreId(record) !== scopedTargetStoreId) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.storeMismatch, "UNKNOWN", false);
  }
  const recordAccountId = warehouseAccountId(record);
  if (scopedAccountId && recordAccountId && recordAccountId !== scopedAccountId) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.storeMismatch, "UNKNOWN", false);
  }
  const type = fulfillmentType(record);
  const warehouseId = platformWarehouseId(record);
  if (!warehouseId || lower(warehouseId).startsWith("wh_")) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.missingWarehouseId, type, type === "RFBS");
  }
  if (warehouseDisabled(record)) {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.disabled, type, type === "RFBS");
  }
  if (type !== "FBS" && type !== "RFBS") {
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.unsupportedFulfillmentType, type, false);
  }
  if (type === "RFBS") {
    return validRfbsEvidence({
      evidence: validationEvidence,
      warehouse: record,
      accountId: scopedAccountId,
      targetStoreId: scopedTargetStoreId,
      now,
    })
      ? result(true, LISTING_WAREHOUSE_ELIGIBILITY_CODES.eligibleRfbs, "RFBS", true)
      : result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.rfbsValidationRequired, "RFBS", true);
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
    return result(false, LISTING_WAREHOUSE_ELIGIBILITY_CODES.noActiveProductAssociation, "FBS", false);
  }
  return result(true, LISTING_WAREHOUSE_ELIGIBILITY_CODES.eligible, "FBS", false);
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

export function annotateListingWarehouseEligibility({
  warehouses = [],
  products = [],
  accountId,
} = {}) {
  return (Array.isArray(warehouses) ? warehouses : []).map((warehouse) => ({
    ...warehouse,
    listingEligibility: listingWarehouseEligibility({
      warehouse,
      products,
      targetStoreId: warehouseStoreId(warehouse),
      accountId,
    }),
  }));
}

export function listingEligibilityCaches({ products = [], warehouses = [], accountId } = {}) {
  return {
    products,
    warehouses: annotateListingWarehouseEligibility({ warehouses, products, accountId }),
  };
}

export function assertListingStockSelectionEligible({
  warehouses = [],
  products = [],
  stocks = [],
  targetStoreId,
  accountId,
} = {}) {
  const warehouseIds = [...new Set(
    (Array.isArray(stocks) ? stocks : [])
      .map((stock) => firstText(stock?.warehouse_id, stock?.warehouseId))
      .filter(Boolean),
  )];
  for (const warehouseId of warehouseIds) {
    const warehouse = (Array.isArray(warehouses) ? warehouses : []).find((row) =>
      platformWarehouseId(row) === warehouseId) || null;
    assertListingWarehouseEligible({ warehouse, products, targetStoreId, accountId });
  }
  return true;
}
