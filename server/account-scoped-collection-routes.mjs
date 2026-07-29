import { prepareCollectRequestV4 } from "./collection-pipeline.mjs";

function routeError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export function createJsonAccountScopedCollectionHandler({
  authenticate,
  readJson,
  normalizeItem,
  saveState,
  sendJson,
  sendError,
  countAccountItems,
} = {}) {
  if (
    typeof authenticate !== "function"
    || typeof readJson !== "function"
    || typeof normalizeItem !== "function"
    || typeof saveState !== "function"
    || typeof sendJson !== "function"
    || typeof sendError !== "function"
    || typeof countAccountItems !== "function"
  ) {
    throw new TypeError("account-scoped collection route dependencies are required");
  }

  return async function handleJsonAccountScopedCollection(req, res, url, state) {
    const requestMatch = url.pathname.match(/^\/local\/collect-requests\/([^/]+)$/);
    const sourceMatch = url.pathname.match(/^\/sources\/([^/]+)\/collect(?:\/batch)?$/);
    if (!(req.method === "GET" && requestMatch) && !(req.method === "POST" && sourceMatch)) {
      return false;
    }

    try {
      if (requestMatch) {
        const account = await authenticate(req, "collector.job.read");
        const key = decodeURIComponent(requestMatch[1]);
        const request = (Array.isArray(state.collectRequests) ? state.collectRequests : [])
          .find((row) =>
            String(row.accountId || "") === String(account.id)
            && [row.id, row.idempotencyKey, row.sourceRequestId].includes(key));
        if (!request) sendError(res, 404, "采集请求不存在", "COLLECT_REQUEST_NOT_FOUND");
        else sendJson(res, 200, { ok: true, request });
        return true;
      }

      const account = await authenticate(req, "collector.upload");
      const pathSource = decodeURIComponent(sourceMatch[1]);
      const body = await readJson(req);
      const isBatch = url.pathname.endsWith("/batch");
      const inputs = isBatch ? (Array.isArray(body.items) ? body.items : []) : [body];
      if (!inputs.length) throw routeError("采集请求没有商品数据", 422, "COLLECT_ITEMS_EMPTY");

      const imported = [];
      state.collectRequests = Array.isArray(state.collectRequests) ? state.collectRequests : [];
      state.caches.collectBox = Array.isArray(state.caches.collectBox) ? state.caches.collectBox : [];
      for (const value of inputs) {
        const input = value && typeof value === "object" ? value : {};
        const prepared = prepareCollectRequestV4({
          authenticatedAccount: account,
          input: { ...input, source: input.source || pathSource },
        });
        const existing = state.collectRequests.find((request) =>
          request.accountId === prepared.identity.accountId
          && request.source === prepared.identity.source
          && request.sourceSku === prepared.identity.sourceSku
          && request.idempotencyKey === prepared.idempotencyKey);
        if (existing && existing.contentHash !== prepared.contentHash) {
          throw routeError(
            "相同采集请求标识已用于不同内容",
            409,
            "COLLECT_REQUEST_CONFLICT",
          );
        }
        if (existing?.status === "SUCCEEDED") {
          imported.push({
            ...existing.response.item,
            collectRequestId: existing.id,
            duplicate: true,
          });
          continue;
        }

        const normalized = normalizeItem({
          ...prepared.normalizedItem,
          id: prepared.collectId,
          raw: input.payload,
          sourceId: prepared.identity.source,
        }, prepared.identity.source);
        const item = {
          ...normalized,
          id: prepared.collectId,
          accountId: account.id,
          createdBy: account.id,
          source: prepared.identity.source,
          sourceSku: prepared.identity.sourceSku,
          sourceUrl: prepared.normalizedItem.sourceUrl,
          deviceFingerprint: prepared.normalizedItem.deviceFingerprint,
          capturedAt: prepared.normalizedItem.capturedAt,
        };
        for (const field of [
          "storeId",
          "localStoreId",
          "operatingStoreId",
          "dataCollectionStoreId",
          "sellerCompanyId",
        ]) delete item[field];
        state.caches.collectBox = state.caches.collectBox.filter((row) =>
          !(String(row.id) === item.id && String(row.accountId || "") === account.id));
        state.caches.collectBox.unshift(item);
        const response = { item, collectItemId: item.id };
        state.collectRequests.push({
          id: prepared.persistedRequestId,
          idempotencyKey: prepared.idempotencyKey,
          accountId: account.id,
          createdBy: account.id,
          storeId: null,
          dataCollectionStoreId: null,
          source: prepared.identity.source,
          sourceSku: prepared.identity.sourceSku,
          sourceRequestId: prepared.identity.requestId,
          contentHash: prepared.contentHash,
          status: "SUCCEEDED",
          response,
          createdAt: new Date().toISOString(),
        });
        imported.push({ ...item, collectRequestId: prepared.persistedRequestId, duplicate: false });
      }
      await saveState(state);
      sendJson(res, 200, isBatch
        ? {
            ok: true,
            imported: imported.length,
            data: imported,
            total: countAccountItems(state, account).length,
          }
        : {
            ok: true,
            data: imported[0] || null,
            requestId: imported[0]?.collectRequestId || "",
          });
    } catch (error) {
      sendError(
        res,
        error?.status || 500,
        error?.message || "采集请求处理失败",
        error?.code || "COLLECT_REQUEST_FAILED",
      );
    }
    return true;
  };
}
