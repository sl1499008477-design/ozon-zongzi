import {
  normalizeAndHashAutoListingConfig,
} from "./auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "./auto-listing-item-image-config.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import { buildAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import { assertListingStockSelectionEligible } from "./listing-warehouse-eligibility.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const REQUEST_KEYS = new Set(["actor", "collectItemIds", "idempotencyKey", "config", "correlationId"]);
const PRICE_STRING_FIELDS = ["blackKopecks", "greenKopecks", "realPriceKopecks", "adjustmentKopecks", "finalPriceKopecks"];

function error(code, status = 422) {
  const result = new Error(code);
  result.code = code;
  result.status = status;
  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    throw error("AUTO_LISTING_REQUEST_INVALID");
  }
  const ids = input.collectItemIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000 || ids.some((id) => !text(id))) throw error("AUTO_LISTING_REQUEST_INVALID");
  const collectItemIds = [...new Set(ids.map(text))];
  if (collectItemIds.length < 1 || collectItemIds.length > 100) throw error("AUTO_LISTING_REQUEST_INVALID");
  const idempotencyKey = text(input.idempotencyKey);
  const correlationId = text(input.correlationId);
  if (!idempotencyKey || idempotencyKey.length > 240 || !correlationId || correlationId.length > 240) {
    throw error("AUTO_LISTING_REQUEST_INVALID");
  }
  return { collectItemIds, idempotencyKey, correlationId };
}

function priceInput(snapshot, adjustmentKopecks) {
  return {
    blackKopecks: snapshot.priceEvidence.blackKopecks,
    greenKopecks: snapshot.priceEvidence.greenKopecks,
    currency: snapshot.priceEvidence.currency,
    adjustmentKopecks,
  };
}

function categoryAncestors(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((categoryId, index) => ({ categoryId: String(categoryId), distance: index + 1 }))
    .filter((entry) => entry.categoryId);
}

function strategyFor(snapshot, source, published) {
  return resolveAiContentStrategy({
    strategyVersion: published.strategyVersion,
    rules: published.rules,
    product: {
      descriptionCategoryId: snapshot.targetCategory.descriptionCategoryId,
      categoryAncestors: categoryAncestors(snapshot.targetCategory.ancestorCategoryIds),
      productStyle: snapshot.source.productStyle,
    },
  });
}

function safePrice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.currency !== "RUB"
    || !["BLACK_GTE_80", "BLACK_LT_80"].includes(value.branch)) return undefined;
  const price = { currency: "RUB", branch: value.branch };
  for (const field of PRICE_STRING_FIELDS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "string" || !/^[+-]?\d+$/.test(value[field])) return undefined;
    price[field] = value[field];
  }
  return price;
}

function safeString(value, max = 512) {
  return typeof value === "string" && value.length <= max ? value : null;
}

function safeTimestamp(value) {
  if (typeof value === "string" && value.length <= 80) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

function safeItem(item = {}) {
  const source = item.source || item;
  return {
    itemId: safeString(source.id) || safeString(source.itemId),
    status: safeString(source.status),
    createdAt: safeTimestamp(source.createdAt) || safeTimestamp(source.created_at),
    updatedAt: safeTimestamp(source.updatedAt) || safeTimestamp(source.updated_at),
    targetStoreId: safeString(source.targetStoreId) || safeString(source.target_store_id),
    targetWarehouseId: safeString(source.targetWarehouseId) || safeString(source.target_warehouse_id),
    sourceRecordId: safeString(source.sourceRecordId) || safeString(source.source_record_id),
    sourceVersion: safeString(source.sourceVersion) || safeString(source.source_version),
    sourceHash: safeString(source.sourceHash) || safeString(source.source_hash) || safeString(source.snapshotHash) || safeString(source.snapshot_hash),
    strategyId: safeString(source.strategyId) || safeString(source.strategy_id),
    strategyVersionId: safeString(source.strategyVersionId) || safeString(source.strategy_version_id),
    style: safeString(source.style),
    matchedBy: safeString(source.matchedBy) || safeString(source.matched_by),
    ...(safePrice(source.price) ? { price: safePrice(source.price) } : {}),
    ...(safeString(source.failureCode) || safeString(source.failure_code) ? { failureCode: safeString(source.failureCode) || safeString(source.failure_code) } : {}),
  };
}

function safeJob(row = {}) {
  if (!row) return null;
  return {
    jobId: safeString(row.id) || safeString(row.jobId),
    sourceType: safeString(row.sourceType) || safeString(row.source_type) || "COLLECT_BOX",
    status: safeString(row.status) || "CREATED",
    correlationId: safeString(row.correlationId) || safeString(row.correlation_id),
    createdAt: safeTimestamp(row.createdAt) || safeTimestamp(row.created_at),
    updatedAt: safeTimestamp(row.updatedAt) || safeTimestamp(row.updated_at),
    items: (Array.isArray(row.items) ? row.items : []).map(safeItem),
  };
}

function requireRepository(repository) {
  const required = ["loadCollectSources", "loadTargetStore", "loadTargetWarehouse", "loadPublishedStrategy", "getJobByIdempotencyKey", "createJobGraph", "getJob", "listJobs"];
  if (!repository || required.some((name) => typeof repository[name] !== "function")) {
    throw new TypeError("Auto listing repository dependencies are required");
  }
  return repository;
}

export function createAutoListingService({ repository } = {}) {
  const storage = requireRepository(repository);
  return {
    async createAutoListingJob(input = {}) {
      assertPermission(input.actor, PERMISSIONS.TENANT_OPERATE);
      const { collectItemIds, idempotencyKey, correlationId } = assertRequest(input);
      const accountId = text(input.actor.id);
      if (!accountId) throw error("AUTO_LISTING_REQUEST_INVALID");
      const { config, configHash } = normalizeAndHashAutoListingConfig(input.config);
      const replay = await storage.getJobByIdempotencyKey({ accountId, idempotencyKey });
      if (replay) return safeJob(replay);
      const store = await storage.loadTargetStore({ accountId, targetStoreId: config.targetStoreId });
      const targetStore = validateTargetStoreRecord({ accountId, targetStoreId: config.targetStoreId, store });
      const warehouseEvidence = await storage.loadTargetWarehouse({
        accountId,
        targetStoreId: config.targetStoreId,
        targetWarehouseId: config.targetWarehouseId,
      });
      const warehouse = warehouseEvidence?.warehouse;
      if (!warehouse
        || text(warehouse.id) !== config.targetWarehouseId
        || text(warehouse.storeId || warehouse.store_id) !== config.targetStoreId
        || text(warehouse.accountId || warehouse.account_id || warehouse.ownerAccountId) !== accountId
        || !text(warehouse.warehouse_id || warehouse.warehouseId)) {
        throw error("AUTO_LISTING_WAREHOUSE_NOT_FOUND", 404);
      }
      assertListingStockSelectionEligible({
        warehouses: [warehouse],
        products: warehouseEvidence?.products || [],
        stocks: [{ warehouse_id: warehouse?.warehouse_id || warehouse?.warehouseId }],
        targetStoreId: config.targetStoreId,
        accountId,
      });
      const sources = await storage.loadCollectSources({ accountId, collectItemIds });
      if (!Array.isArray(sources) || sources.length !== collectItemIds.length) {
        throw error("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
      }
      const published = await storage.loadPublishedStrategy({ accountId });
      if (!published?.strategyVersion || !Array.isArray(published.rules)) {
        throw error("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
      }
      const items = sources.map((source, sourceOrder) => {
        const captured = buildAutoListingSourceSnapshot({
          accountId,
          sourceType: "COLLECT_BOX",
          sourceRecordId: source.id,
          sourceVersion: source.sourceVersion,
          collectItem: source.collectItem,
          productDraft: source.productDraft,
          rawResponseRef: source.rawResponseRef,
          rawResponseHash: source.rawResponseHash,
          rawCollectedAt: source.rawCollectedAt,
        });
        const base = {
          sourceType: "COLLECT_BOX",
          sourceRecordId: source.id,
          sourceVersion: source.sourceVersion,
          snapshot: captured.snapshot,
          snapshotHash: captured.snapshotHash,
          rawResponseRef: captured.rawResponseRef,
          targetStoreId: targetStore.id,
          targetWarehouseId: config.targetWarehouseId,
          sourceOrder,
          effectiveImageConfig: deriveEffectiveAutoListingImageConfig({ configSnapshot: config, configHash, sourceCapture: captured }),
        };
        if (captured.snapshot.targetCategory.targetStoreId !== config.targetStoreId) {
          return { ...base, status: "BLOCKED", failureCode: "AUTO_LISTING_CATEGORY_TARGET_STORE_MISMATCH" };
        }
        const strategy = strategyFor(captured.snapshot, source, published);
        try {
          return { ...base, strategyId: strategy.strategyId, strategyVersionId: strategy.strategyVersionId, ruleId: strategy.ruleId, style: strategy.style, matchedBy: strategy.matchedBy,
            status: "SOURCE_READY", price: calculateAutoListingPrice(priceInput(captured.snapshot, config.priceAdjustmentKopecks)) };
        } catch (caught) {
          return { ...base, strategyId: strategy.strategyId, strategyVersionId: strategy.strategyVersionId, ruleId: strategy.ruleId, style: strategy.style, matchedBy: strategy.matchedBy,
            status: "BLOCKED", failureCode: text(caught?.code) || "AUTO_LISTING_ITEM_BLOCKED" };
        }
      });
      const created = await storage.createJobGraph({
        accountId,
        actorAccountId: accountId,
        sourceType: "COLLECT_BOX",
        idempotencyKey,
        correlationId,
        configSnapshot: config,
        configHash,
        strategyVersionId: published.strategyVersion.strategyVersionId,
        items,
      });
      return safeJob(created);
    },
    async getAutoListingJob({ actor, jobId } = {}) {
      assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
      const accountId = text(actor?.id);
      const row = await storage.getJob({ accountId, jobId: text(jobId) });
      if (!row) throw error("AUTO_LISTING_JOB_NOT_FOUND", 404);
      return safeJob(row);
    },
    async listAutoListingJobs({ actor, limit = 20 } = {}) {
      assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
      const accountId = text(actor?.id);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error("AUTO_LISTING_REQUEST_INVALID");
      const rows = await storage.listJobs({ accountId, limit });
      return (Array.isArray(rows) ? rows : []).map(safeJob);
    },
  };
}

export const createAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).createAutoListingJob(input);
export const getAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).getAutoListingJob(input);
export const listAutoListingJobs = (dependencies, input) => createAutoListingService(dependencies).listAutoListingJobs(input);
