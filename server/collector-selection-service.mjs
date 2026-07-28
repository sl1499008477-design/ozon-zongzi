import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import {
  getCollectorRunForAccount,
  listCollectorRunItems,
} from "./collector-desktop-service.mjs";
import { ingestCollectRequestV4 } from "./collection-pipeline.mjs";

function selectionError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function sourceRow(item = {}) {
  return {
    ...(item.rawPayload && typeof item.rawPayload === "object" ? item.rawPayload : {}),
    ...(item.exportData && typeof item.exportData === "object" ? item.exportData : {}),
  };
}

function collectPayload(item, run) {
  const raw = sourceRow(item);
  const sku = clean(raw.sku || raw.productId || raw.product_id || item.sourceSku || item.sourceKey, 240);
  if (!sku) throw selectionError("采集结果缺少 SKU", 422, "COLLECTOR_SELECTION_SKU_MISSING");
  const productUrl = clean(raw.productUrl || raw.url || raw.link || item.sourceUrl, 2000);
  return {
    ...raw,
    id: clean(raw.id || raw.sourceExternalId || item.sourceKey || sku, 500),
    sku,
    productUrl,
    name: raw.name || raw.nameLabel || raw.title || raw.productName || sku,
    source: clean(item.source || "ozon", 80).toLowerCase(),
    status: "待处理",
    analytics: item.analytics || {},
    sourcing: item.sourcing || {},
    pricing: item.pricing || {},
    filterResult: item.filterResult || {},
    collectorTaskId: item.taskId,
    collectorRunId: run.id,
    collectorItemId: item.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function listAllQualified(service, accountId, runId) {
  const rows = [];
  let offset = 0;
  while (true) {
    const page = await service.listCollectorRunItems({
      accountId,
      runId,
      status: "QUALIFIED",
      limit: 5000,
      offset,
    });
    rows.push(...page);
    if (page.length < 5000) return rows;
    offset += page.length;
  }
}

async function linkCollectorItem(accountId, runId, itemId, collectItemId) {
  if (!collectItemId || !postgresEnabled()) return;
  const pool = await getPostgresPool();
  await pool.query(
    `UPDATE collector_task_items SET collect_item_id=$4,updated_at=NOW()
     WHERE id=$1 AND run_id=$2 AND account_id=$3`,
    [itemId, runId, accountId, collectItemId],
  );
}

/** Adds only explicitly selected QUALIFIED results to the Sonli collect box. */
export async function addSelectedCollectorItemsToCollectBox({
  accountId,
  runId,
  itemIds = [],
  sourceKeys = [],
} = {}, dependencies = {}) {
  const service = {
    getCollectorRunForAccount,
    listCollectorRunItems,
    ingestCollectRequestV4,
    linkCollectorItem,
    ...dependencies,
  };
  const selectedIds = new Set((Array.isArray(itemIds) ? itemIds : [itemIds]).map((value) => clean(value, 500)).filter(Boolean));
  const selectedKeys = new Set((Array.isArray(sourceKeys) ? sourceKeys : [sourceKeys]).map((value) => clean(value, 500)).filter(Boolean));
  if (!selectedIds.size && !selectedKeys.size) {
    throw selectionError("请至少选择一个采集结果", 422, "COLLECTOR_SELECTION_EMPTY");
  }
  if (selectedIds.size + selectedKeys.size > 1000) {
    throw selectionError("单次最多选择 1000 个采集结果", 422, "COLLECTOR_SELECTION_TOO_LARGE");
  }

  const run = await service.getCollectorRunForAccount(accountId, runId);
  if (!run) throw selectionError("采集运行不存在", 404, "COLLECTOR_RUN_NOT_FOUND");
  const qualified = await listAllQualified(service, accountId, runId);
  const selected = qualified.filter((item) => selectedIds.has(item.id) || selectedKeys.has(item.sourceKey));
  const matchedIds = new Set(selected.map((item) => item.id));
  const matchedKeys = new Set(selected.map((item) => item.sourceKey));
  const missing = [
    ...[...selectedIds].filter((id) => !matchedIds.has(id)),
    ...[...selectedKeys].filter((key) => !matchedKeys.has(key)),
  ];

  const results = [];
  const errors = [];
  for (const item of selected) {
    try {
      const payload = collectPayload(item, run);
      const ingested = await service.ingestCollectRequestV4({
        accountId,
        storeId: run.operatingStoreId,
        dataCollectionStoreId: run.dataCollectionStoreId,
        source: payload.source,
        item: payload,
        idempotencyKey: `collector-select:${runId}:${item.id}`,
      });
      await service.linkCollectorItem(accountId, runId, item.id, ingested.collectItemId || ingested.item?.id || "");
      results.push({
        collectorItemId: item.id,
        sourceKey: item.sourceKey,
        collectItemId: ingested.collectItemId || ingested.item?.id || "",
        collectRequestId: ingested.requestId || "",
        duplicate: Boolean(ingested.duplicate),
      });
    } catch (error) {
      errors.push({
        collectorItemId: item.id,
        sourceKey: item.sourceKey,
        code: error?.code || "COLLECTOR_SELECTION_FAILED",
        message: String(error?.message || error).slice(0, 500),
      });
    }
  }
  return {
    ok: errors.length === 0 && missing.length === 0,
    selected: selected.length,
    added: results.length,
    results,
    errors,
    missing,
  };
}
