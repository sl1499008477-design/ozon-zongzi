import crypto from "node:crypto";
import { normalizeAutoListingConfig } from "./auto-listing-contract.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import { buildAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import { assertListingStockSelectionEligible } from "./listing-warehouse-eligibility.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const REQUEST_KEYS = new Set(["actor", "collectItemIds", "idempotencyKey", "config", "correlationId"]);

function error(code, status = 422) {
  const result = new Error(code);
  result.code = code;
  result.status = status;
  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function assertRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) {
    throw error("AUTO_LISTING_REQUEST_INVALID");
  }
  const ids = input.collectItemIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) throw error("AUTO_LISTING_REQUEST_INVALID");
  const collectItemIds = [...new Set(ids.map((id) => text(id)))];
  if (collectItemIds.some((id) => !id) || collectItemIds.length > 100) throw error("AUTO_LISTING_REQUEST_INVALID");
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

function categoryAncestors(path, descriptionCategoryId) {
  if (!Array.isArray(path)) return [];
  return path
    .map((categoryId, index) => ({ categoryId: String(categoryId), distance: path.length - index }))
    .filter((entry) => entry.categoryId && entry.categoryId !== String(descriptionCategoryId));
}

function strategyFor(snapshot, source, published) {
  return resolveAiContentStrategy({
    strategyVersion: published.strategyVersion,
    rules: published.rules,
    product: {
      descriptionCategoryId: snapshot.targetCategory.descriptionCategoryId,
      categoryAncestors: categoryAncestors(snapshot.targetCategory.categoryPath, snapshot.targetCategory.descriptionCategoryId),
      productStyle: text(source.productStyle || source.collectItem?.productStyle) || "UNKNOWN",
    },
  });
}

function safeItem(item = {}) {
  const source = item.source || item;
  return {
    itemId: source.id || source.itemId || null,
    status: source.status || null,
    createdAt: source.createdAt || source.created_at || null,
    updatedAt: source.updatedAt || source.updated_at || null,
    targetStoreId: source.targetStoreId || source.target_store_id || null,
    targetWarehouseId: source.targetWarehouseId || source.target_warehouse_id || null,
    sourceRecordId: source.sourceRecordId || source.source_record_id || null,
    sourceVersion: source.sourceVersion || source.source_version || null,
    sourceHash: source.sourceHash || source.source_hash || source.snapshotHash || source.snapshot_hash || null,
    strategyId: source.strategyId || source.strategy_id || null,
    strategyVersionId: source.strategyVersionId || source.strategy_version_id || null,
    style: source.style || null,
    matchedBy: source.matchedBy || source.matched_by || null,
    ...(source.price ? { price: canonical(source.price) } : {}),
    ...(source.failureCode || source.failure_code ? { failureCode: source.failureCode || source.failure_code } : {}),
  };
}

function safeJob(row = {}) {
  if (!row) return null;
  return {
    jobId: row.id || row.jobId || null,
    sourceType: row.sourceType || row.source_type || "COLLECT_BOX",
    status: row.status || "CREATED",
    correlationId: row.correlationId || row.correlation_id || null,
    createdAt: row.createdAt || row.created_at || null,
    updatedAt: row.updatedAt || row.updated_at || null,
    items: (Array.isArray(row.items) ? row.items : []).map(safeItem),
  };
}

function requireRepository(repository) {
  const required = ["loadCollectSources", "loadTargetStore", "loadTargetWarehouse", "loadPublishedStrategy", "createJobGraph", "getJob", "listJobs"];
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
      const config = normalizeAutoListingConfig(input.config);
      const store = await storage.loadTargetStore({ accountId, targetStoreId: config.targetStoreId });
      const targetStore = validateTargetStoreRecord({ accountId, targetStoreId: config.targetStoreId, store });
      const warehouseEvidence = await storage.loadTargetWarehouse({
        accountId,
        targetStoreId: config.targetStoreId,
        targetWarehouseId: config.targetWarehouseId,
      });
      const warehouse = warehouseEvidence?.warehouse;
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
      const items = sources.map((source) => {
        const captured = buildAutoListingSourceSnapshot({
          accountId,
          sourceType: "COLLECT_BOX",
          sourceRecordId: source.id,
          sourceVersion: source.sourceVersion,
          collectItem: source.collectItem,
          productDraft: source.productDraft,
          rawResponseRef: source.rawResponseRef,
        });
        const strategy = strategyFor(captured.snapshot, source, published);
        const base = {
          sourceType: "COLLECT_BOX",
          sourceRecordId: source.id,
          sourceVersion: source.sourceVersion,
          snapshot: captured.snapshot,
          snapshotHash: captured.snapshotHash,
          rawResponseRef: captured.rawResponseRef,
          targetStoreId: targetStore.id,
          targetWarehouseId: config.targetWarehouseId,
          strategyId: strategy.strategyId,
          strategyVersionId: strategy.strategyVersionId,
          style: strategy.style,
          matchedBy: strategy.matchedBy,
        };
        try {
          return { ...base, status: "SOURCE_READY", price: calculateAutoListingPrice(priceInput(captured.snapshot, config.priceAdjustmentKopecks)) };
        } catch (caught) {
          return { ...base, status: "BLOCKED", failureCode: text(caught?.code) || "AUTO_LISTING_ITEM_BLOCKED" };
        }
      });
      const created = await storage.createJobGraph({
        accountId,
        actorAccountId: accountId,
        sourceType: "COLLECT_BOX",
        idempotencyKey,
        correlationId,
        configSnapshot: config,
        configHash: hash(config),
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
