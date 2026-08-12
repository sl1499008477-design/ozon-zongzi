import { types as utilTypes } from "node:util";
import {
  normalizeAndHashAutoListingConfig,
  verifyAutoListingFrozenConfig,
} from "./auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "./auto-listing-item-image-config.mjs";
import { calculateAutoListingPrice } from "./auto-listing-pricing.mjs";
import { normalizeAutoListingCurrency } from "./auto-listing-currency.mjs";
import { resolveAiContentStrategy } from "./ai-content-strategy.mjs";
import {
  buildAutoListingBlockedSourceEvidence,
  buildAutoListingSourceSnapshot,
} from "./auto-listing-source-snapshot.mjs";
import { validateTargetStoreRecord } from "./listing-submission-policy.mjs";
import {
  assertListingWarehouseEligible,
  listingWarehouseEligibility,
} from "./listing-warehouse-eligibility.mjs";
import { selectAutoListingUploadPolicyForNewJob } from "./auto-listing-upload-policy.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const REQUEST_KEYS = new Set(["actor", "collectItemIds", "idempotencyKey", "config", "correlationId"]);
const PRICE_STRING_FIELDS = ["blackKopecks", "greenKopecks", "realPriceKopecks", "adjustmentKopecks", "finalPriceKopecks"];
const BLOCKED_SOURCE_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
  "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
  "AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED",
  "AUTO_LISTING_SOURCE_CURRENCY_MISMATCH",
]);

function error(code, status = 422) {
  const result = new Error(code);
  result.code = code;
  result.status = status;
  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validSharedCategorySource(accountId, source) {
  const evidence = source?.categoryEvidence;
  const shared = source?.sharedCategory;
  const positiveId = (value) => /^[1-9][0-9]*$/u.test(String(value ?? ""));
  const fingerprint = shared?.taxonomyFingerprint;
  return Boolean(evidence && shared && text(evidence.id) && text(shared.id)
    && evidence.accountId === accountId && shared.accountId === accountId
    && shared.status === "ACTIVE"
    && shared.taxonomyScope === "OZON:DEFAULT" && evidence.taxonomyScope === "OZON:DEFAULT"
    && String(shared.sourceDescriptionCategoryId) === String(evidence.sourceDescriptionCategoryId)
    && String(shared.sourceTypeId) === String(evidence.sourceTypeId)
    && [evidence.sourceDescriptionCategoryId, evidence.sourceTypeId,
      shared.currentDescriptionCategoryId, shared.currentTypeId].every(positiveId)
    && ["SOURCE_DIRECT", "OZON_REFRESH", "MANUAL"].includes(shared.source)
    && (fingerprint === null || fingerprint === "" || (typeof fingerprint === "string" && /^[0-9a-f]{64}$/u.test(fingerprint)))
    && Number.isSafeInteger(shared.version) && shared.version > 0);
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

function buildJobItems({ accountId, sourceType, sources, targetStore, config, configHash, published }) {
  return sources.map((source, sourceOrder) => {
    const sourceRecordId = text(source.id);
    const collectItemId = text(source.collectItemId || source.id);
    let captured;
    try {
      captured = buildAutoListingSourceSnapshot({
        accountId,
        sourceType,
        sourceRecordId,
        collectItemId,
        sourceVersion: source.sourceVersion,
        collectItem: source.collectItem,
        productDraft: source.productDraft,
        rawResponseRef: source.rawResponseRef,
        rawResponseHash: source.rawResponseHash,
        rawCollectedAt: source.rawCollectedAt,
        categoryEvidence: source.categoryEvidence,
        sharedCategory: source.sharedCategory,
        targetStoreId: targetStore.id,
        targetStoreCurrency: targetStore.currencyCode,
      });
    } catch (caught) {
      const failureCode = text(caught?.code);
      if (!BLOCKED_SOURCE_FAILURE_CODES.has(failureCode)) throw caught;
      const blocked = buildAutoListingBlockedSourceEvidence({
        accountId,
        sourceType,
        sourceRecordId,
        sourceVersion: source.sourceVersion,
        productDraft: source.productDraft,
        rawResponseRef: source.rawResponseRef,
        rawResponseHash: source.rawResponseHash,
        rawCollectedAt: source.rawCollectedAt,
        failureCode,
      });
      return {
        sourceType, sourceRecordId, collectItemId, sourceVersion: source.sourceVersion,
        blockedEvidence: blocked.blockedEvidence, snapshotHash: blocked.snapshotHash,
        rawResponseRef: blocked.rawResponseRef, targetStoreId: targetStore.id,
        targetWarehouseId: config.targetWarehouseId, sourceOrder, status: "BLOCKED", failureCode,
      };
    }
    const base = {
      sourceType, sourceRecordId, collectItemId, sourceVersion: source.sourceVersion,
      snapshot: captured.snapshot, snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef, targetStoreId: targetStore.id,
      targetWarehouseId: config.targetWarehouseId, sourceOrder,
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
        configSnapshot: config, configHash, sourceCapture: captured,
      }),
    };
    const strategy = strategyFor(captured.snapshot, source, published);
    try {
      return {
        ...base, strategyId: strategy.strategyId, strategyVersionId: strategy.strategyVersionId,
        ruleId: strategy.ruleId, style: strategy.style, matchedBy: strategy.matchedBy,
        status: "SOURCE_READY",
        price: calculateAutoListingPrice(priceInput(captured.snapshot, config.priceAdjustmentKopecks)),
      };
    } catch (caught) {
      return {
        ...base, strategyId: strategy.strategyId, strategyVersionId: strategy.strategyVersionId,
        ruleId: strategy.ruleId, style: strategy.style, matchedBy: strategy.matchedBy,
        status: "BLOCKED", failureCode: text(caught?.code) || "AUTO_LISTING_ITEM_BLOCKED",
      };
    }
  });
}

function safePrice(value) {
  const currency = normalizeAutoListingCurrency(value?.currency);
  if (!value || typeof value !== "object" || Array.isArray(value) || !currency
    || !["BLACK_GTE_80", "BLACK_LT_80"].includes(value.branch)) return undefined;
  const price = { currency, branch: value.branch };
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

function safeItemActions(source) {
  const status = safeString(source.status) || "";
  const hasReview = Boolean(safeString(source.activeContentPlanId) || safeString(source.active_content_plan_id));
  const recoveryPoint = safeString(source.recoveryPoint) || safeString(source.recovery_point) || "";
  const cancellable = ["CREATED", "SOURCE_READY", "PLANNING", "GENERATING", "READY_FOR_REVIEW", "UPLOAD_QUEUED", "RETRYABLE_ERROR"].includes(status);
  return Object.freeze({
    review: hasReview && ["READY_FOR_REVIEW", "SUCCEEDED"].includes(status),
    approve: hasReview && status === "READY_FOR_REVIEW",
    retry: status === "RETRYABLE_ERROR" && ["PLANNING", "GENERATION"].includes(recoveryPoint),
    regenerate: hasReview && status === "READY_FOR_REVIEW",
    cancel: cancellable,
  });
}

function safeItem(item = {}) {
  const source = item.source || item;
  return {
    itemId: safeString(source.id) || safeString(source.itemId),
    status: safeString(source.status),
    ...(Number.isSafeInteger(source.statusVersion ?? source.status_version)
      && Number(source.statusVersion ?? source.status_version) > 0
      ? { statusVersion: Number(source.statusVersion ?? source.status_version) } : {}),
    createdAt: safeTimestamp(source.createdAt) || safeTimestamp(source.created_at),
    updatedAt: safeTimestamp(source.updatedAt) || safeTimestamp(source.updated_at),
    targetStoreId: safeString(source.targetStoreId) || safeString(source.target_store_id),
    targetWarehouseId: safeString(source.targetWarehouseId) || safeString(source.target_warehouse_id),
    sourceRecordId: safeString(source.sourceRecordId) || safeString(source.source_record_id),
    sourceVersion: safeString(source.sourceVersion) || safeString(source.source_version),
    sourceHash: safeString(source.sourceHash) || safeString(source.source_hash) || safeString(source.snapshotHash) || safeString(source.snapshot_hash),
    ...(safePrice(source.price) ? { price: safePrice(source.price) } : {}),
    ...(safeString(source.failureCode) || safeString(source.failure_code) ? { failureCode: safeString(source.failureCode) || safeString(source.failure_code) } : {}),
    actions: safeItemActions(source),
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
  const required = ["loadCollectSources", "loadTargetStore", "loadTargetWarehouse", "loadPublishedStrategy",
    "loadPublishedUploadPolicies", "getJobByIdempotencyKey", "createJobGraph", "getJob", "listJobs"];
  if (!repository || required.some((name) => typeof repository[name] !== "function")) {
    throw new TypeError("Auto listing repository dependencies are required");
  }
  return repository;
}

function requireRfbsWarehouseVerifier(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.length !== 1 || keys[0] !== "verifyRfbsWarehouse"
      || descriptors.verifyRfbsWarehouse?.enumerable !== true
      || !Object.hasOwn(descriptors.verifyRfbsWarehouse, "value")
      || typeof descriptors.verifyRfbsWarehouse.value !== "function"
      || utilTypes.isProxy(descriptors.verifyRfbsWarehouse.value)) throw new TypeError();
    return Object.freeze({ verifyRfbsWarehouse: descriptors.verifyRfbsWarehouse.value });
  } catch {
    throw new TypeError("Auto listing RFBS warehouse verifier dependency is required");
  }
}

export function createAutoListingService({
  repository,
  prepareListingBase,
  rfbsWarehouseVerifier,
  uploadPolicyGates = {},
} = {}) {
  const storage = requireRepository(repository);
  if (typeof prepareListingBase !== "function") {
    throw new TypeError("Auto listing base preparer dependency is required");
  }
  const verifier = requireRfbsWarehouseVerifier(rfbsWarehouseVerifier);
  async function createFromSources({
    accountId, sourceType, sources, idempotencyKey, correlationId, config, configHash, targetStore: suppliedStore = null,
  }) {
    const store = suppliedStore || await storage.loadTargetStore({ accountId, targetStoreId: config.targetStoreId });
    const targetStore = suppliedStore || validateTargetStoreRecord({ accountId, targetStoreId: config.targetStoreId, store });
    const targetStoreCurrency = normalizeAutoListingCurrency(targetStore.currencyCode);
    if (!targetStoreCurrency || targetStoreCurrency !== targetStore.currencyCode) {
      throw error("AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED", 422);
    }
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 100) {
      throw error("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
    }
    for (const source of sources) {
      if (!validSharedCategorySource(accountId, source)) {
        throw error("AUTO_LISTING_SOURCE_CATEGORY_REQUIRED", 409);
      }
    }
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
    const eligibilityInput = {
      warehouse,
      products: warehouseEvidence?.products || [],
      targetStoreId: config.targetStoreId,
      accountId,
    };
    const eligibility = listingWarehouseEligibility(eligibilityInput);
    const selectable = eligibility.eligible === true
      || (eligibility.fulfillmentType === "RFBS"
        && eligibility.code === "RFBS_VALIDATION_REQUIRED"
        && eligibility.evidenceRequired === true);
    if (!selectable) assertListingWarehouseEligible(eligibilityInput);
    const published = await storage.loadPublishedStrategy({ accountId });
    if (!published?.strategyVersion || !Array.isArray(published.rules)) {
      throw error("AUTO_LISTING_STRATEGY_NOT_PUBLISHED", 409);
    }
    const uploadPolicy = selectAutoListingUploadPolicyForNewJob({
      accountId,
      policies: await storage.loadPublishedUploadPolicies({ accountId }),
      directUploadAllowed: uploadPolicyGates.directUploadAllowed === true,
      uploadEnabled: uploadPolicyGates.uploadEnabled === true,
      listingPipelineEnabled: uploadPolicyGates.listingPipelineEnabled === true,
    });
    const items = buildJobItems({
      accountId, sourceType, sources, targetStore, config, configHash, published,
    });
    const preparedItems = await Promise.all(items.map(async (item) => {
      if (item.status !== "SOURCE_READY") return item;
      const source = sources[item.sourceOrder];
      const listingBaseTemplate = await prepareListingBase({
        accountId,
        source,
        targetStore,
        pricingEvidence: {
          currency: item.snapshot.priceEvidence.currency,
          currencySource: item.snapshot.priceEvidence.currencySource,
          blackKopecks: item.snapshot.priceEvidence.blackKopecks,
          greenKopecks: item.snapshot.priceEvidence.greenKopecks || null,
        },
      });
      return { ...item, listingBaseTemplate };
    }));
    const warehouseValidation = eligibility.fulfillmentType === "RFBS"
      ? await verifier.verifyRfbsWarehouse({
        accountId,
        actorAccountId: accountId,
        targetStoreId: config.targetStoreId,
        targetWarehouseId: config.targetWarehouseId,
        correlationId,
      })
      : null;
    const created = await storage.createJobGraph({
      accountId,
      actorAccountId: accountId,
      sourceType,
      idempotencyKey,
      correlationId,
      configSnapshot: config,
      configHash,
      strategyVersionId: published.strategyVersion.strategyVersionId,
      uploadPolicyVersionId: uploadPolicy.id,
      warehouseValidation,
      items: preparedItems,
    });
    return safeJob(created);
  }

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
      const targetStoreCurrency = normalizeAutoListingCurrency(targetStore.currencyCode);
      if (!targetStoreCurrency || targetStoreCurrency !== targetStore.currencyCode) {
        throw error("AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED", 422);
      }
      const sources = await storage.loadCollectSources({ accountId, collectItemIds });
      if (!Array.isArray(sources) || sources.length !== collectItemIds.length) {
        throw error("AUTO_LISTING_SOURCE_NOT_FOUND", 404);
      }
      return createFromSources({
        accountId, sourceType: "COLLECT_BOX", sources, idempotencyKey, correlationId, config, configHash, targetStore,
      });
    },
    async createExcelAutoListingJob(input = {}) {
      assertPermission(input.actor, PERMISSIONS.TENANT_OPERATE);
      const accountId = text(input.actor?.id);
      const importFileId = text(input.importFileId);
      if (!accountId || !importFileId || importFileId.length > 240
        || typeof storage.loadExcelImportSources !== "function") {
        throw error("AUTO_LISTING_REQUEST_INVALID");
      }
      const context = await storage.loadExcelImportSources({ accountId, importFileId });
      const file = context?.importFile;
      const sources = context?.sources;
      if (!file || file.accountId !== accountId || file.id !== importFileId || file.status !== "COLLECTING"
        || !Number.isInteger(file.statusVersion) || file.statusVersion < 1
        || !Number.isInteger(file.acceptedRows) || !Number.isInteger(file.readyRows) || !Number.isInteger(file.failedRows)
        || file.readyRows + file.failedRows !== file.acceptedRows || file.readyRows < 1
        || !Array.isArray(sources) || sources.length !== file.readyRows
        || !text(file.idempotencyKey) || !text(file.correlationId)) {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      let frozen;
      try { frozen = verifyAutoListingFrozenConfig(file.configSnapshot, file.configHash); } catch {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      if (sources.some((source) => !text(source?.id) || !text(source?.collectItemId))) {
        throw error("AUTO_LISTING_IMPORT_NOT_FINALIZABLE", 409);
      }
      const replay = await storage.getJobByIdempotencyKey({ accountId, idempotencyKey: file.idempotencyKey });
      if (replay) return safeJob(replay);
      return createFromSources({
        accountId, sourceType: "EXCEL_SKU", sources,
        idempotencyKey: file.idempotencyKey, correlationId: file.correlationId,
        config: frozen.config, configHash: frozen.configHash,
      });
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
export const createExcelAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).createExcelAutoListingJob(input);
export const getAutoListingJob = (dependencies, input) => createAutoListingService(dependencies).getAutoListingJob(input);
export const listAutoListingJobs = (dependencies, input) => createAutoListingService(dependencies).listAutoListingJobs(input);
