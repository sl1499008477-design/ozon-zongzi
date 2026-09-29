import { getPostgresPool, postgresEnabled } from "./db/connection.mjs";
import {
  getCollectorRunForAccount,
  listCollectorRunItems,
} from "./collector-desktop-service.mjs";
import { ingestCollectRequestV4 } from "./collection-pipeline.mjs";
import { withoutCollectorScope } from "./collector-scope-sanitizer.mjs";
import { collectCaptureSkus } from './collect-enrichment-recovery.mjs';
import { findOzonCollectedSkuSources } from './collection-sku-rules.mjs';

function selectionError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function sourceRow(item = {}) {
  return withoutCollectorScope({
    ...(item.rawPayload && typeof item.rawPayload === "object" ? item.rawPayload : {}),
    ...(item.exportData && typeof item.exportData === "object" ? item.exportData : {}),
  });
}

function collectPayload(item, run) {
  const raw = sourceRow(item);
  // Re-enter V4 with public facts and the saved row identity only. Admission
  // restores the mapped target from that account-scoped server row.
  for(const value of [raw,raw.listingDraft,...(raw.variants||[]),...(raw.listingDraft?.variants||[]),...(raw.variantData?.variants||[])]){
    if(!value||typeof value!=='object')continue;
    delete value.collectionAdmission;delete value.categoryResolution;delete value.enrichment;
  }
  // The public Ozon seller widget is only used to derive sellerNumber/lowerPrice.
  // Its UI metadata and business "credentials" are not collect-box product data.
  delete raw.sellers;
  for (const variants of [raw.variants, raw.variantData?.variants]) {
    for (const variant of Array.isArray(variants) ? variants : []) delete variant.sellers;
  }
  const sku = clean(raw.sku || raw.productId || raw.product_id || item.sourceSku || item.sourceKey, 240);
  if (!sku) throw selectionError("采集结果缺少 SKU", 422, "COLLECTOR_SELECTION_SKU_MISSING");
  const source = clean(item.source || "ozon", 80).toLowerCase();
  const productUrl = clean(raw.productUrl || raw.url || raw.link || raw.href || item.sourceUrl, 2000);
  const image = raw.image || raw.primaryImage || raw.images?.[0] || raw.cover || raw.photo || "";
  return {
    ...raw,
    id: clean(raw.id || raw.sourceExternalId || item.sourceKey || sku, 500),
    sku,
    productUrl,
    name: raw.name || raw.nameLabel || raw.title || raw.productName || sku,
    source,
    image,
    images: Array.isArray(raw.images) && raw.images.length ? raw.images : image ? [image] : [],
    // New desktop results carry the actual storefront currency. Only legacy
    // results without that evidence object used the Seller report's RUB price.
    currencyCode: raw.currencyCode || raw.currency_code || raw.currency
      || (source === "ozon" && !Object.hasOwn(raw, "storefrontPrice") ? "RUB" : ""),
    status: "待处理",
    analytics: withoutCollectorScope(item.analytics || {}),
    sourcing: withoutCollectorScope(item.sourcing || {}),
    pricing: withoutCollectorScope(item.pricing || {}),
    filterResult: withoutCollectorScope(item.filterResult || {}),
    collectorTaskId: item.taskId,
    collectorRunId: run.id,
    collectorItemId: item.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function listAllQualified(service, accountId, runId, selection = {}) {
  const rows = [];
  let offset = 0;
  while (true) {
    const page = await service.listCollectorRunItems({
      ...selection,
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

/** Frozen run results are the authority for automatic AI scope, not client SKU lists. */
export async function getCollectorRunProductGroups({ accountId, runId, collectItemIds = [] } = {}) {
  const ids = [...new Set(collectItemIds.map(id => clean(id, 240)).filter(Boolean))];
  if (!ids.length || ids.length > 1000) throw selectionError('请选择 1–1000 件已回传商品', 422, 'COLLECTOR_SELECTION_EMPTY');
  const qualified = await listAllQualified({ listCollectorRunItems }, accountId, runId, { collectItemIds: ids });
  const groups = ids.map(collectItemId => {
    const items = qualified.filter(item => item.collectItemId === collectItemId);
    if (!items.length) throw selectionError('商品不属于本次采集运行或尚未完整回传', 403, 'COLLECTOR_SELECTION_SCOPE_MISMATCH');
    if (items.some(item => String(item.source).toLowerCase() !== 'ozon'))
      throw selectionError('自动 AI 上架仅接受本次采集的 Ozon 商品', 422, 'COLLECTOR_SELECTION_SOURCE_MISMATCH');
    const skus = [...new Set(items.flatMap(item => collectCaptureSkus({ ...sourceRow(item), sku: item.sourceSku })))];
    return { groupId: sourceRow(items[0]).collectorGroupId || collectItemId, source: 'ozon', collectItemId,
      skus, legacyCollectItemIds: [collectItemId] };
  });
  const pool = await getPostgresPool();
  const bySku = await findOzonCollectedSkuSources(pool, accountId, groups.flatMap(group => group.skus));
  return groups.map(group => {
    const sources = new Map();
    for (const sku of group.skus) {
      const id = bySku.get(sku) || group.collectItemId;
      if (!sources.has(id)) sources.set(id, []);
      sources.get(id).push(sku);
    }
    return { ...group, sources: [...sources].map(([collectItemId, skus]) => ({ collectItemId, skus })),
      legacyCollectItemIds: [...sources.keys()] };
  });
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
  const qualified = await listAllQualified(service, accountId, runId, { itemIds: [...selectedIds], sourceKeys: [...selectedKeys] });
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
        authenticatedAccount: { id: accountId },
        input: {
          source: payload.source,
          sourceSku: payload.sku,
          sourceUrl: payload.productUrl,
          requestId: `collector-select:${runId}:${item.id}`,
          capturedAt: payload.createdAt,
          payload,
        },
      });
      const ingestedId = ingested.collectItemId || ingested.item?.id || '';
      const alreadyListed = ingestedId.startsWith('listed:')
        || (ingested.item?.previouslyDeleted === true && ingested.item?.collectionState === 'LISTED');
      const collectItemId = alreadyListed ? '' : ingestedId;
      if (collectItemId) await service.linkCollectorItem(accountId, runId, item.id, collectItemId);
      results.push({
        collectorItemId: item.id,
        sourceKey: item.sourceKey,
        collectItemId,
        ...(alreadyListed ? { skipped: true, code: 'COLLECTOR_GROUP_ALREADY_LISTED', message: '商品已上架，无需重复发送 AI 上架' } : {}),
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
