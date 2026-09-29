import {collectCaptureSkus} from './collect-enrichment-recovery.mjs';
import {admitCollectedItem} from './collection-admission.mjs';
import {
  assertCollectorScopeFieldsAbsentV4,
  preflightCollectRequestsV4,
} from "./collection-pipeline.mjs";
import {
  buildOzonEnrichmentSummary,
  mergeOzonEnrichmentResult,
  normalizeOzonCollectedSourceEvidence,
  reconcileOzonEnrichmentSummary,
} from "./collect-enrichment-policy.mjs";
import { mergeCollectedItemPublicEvidence } from "./collect-item-identity-policy.mjs";

function routeError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export function createJsonAccountScopedCollectionHandler({
  authenticate,
  readJson,
  normalizeItem,
  loadState,
  saveState,
  stateTransaction,
  enqueueForCollect,
  completeLinkedJobsFromCollectEvidence,
  sendJson,
  sendError,
  countAccountItems,
  categoryEvidencePort = null,
  logger = null,
  now = () => new Date(),
  checkAdmission = admitCollectedItem,
} = {}) {
  if (
    typeof authenticate !== "function"
    || typeof readJson !== "function"
    || typeof normalizeItem !== "function"
    || typeof loadState !== "function"
    || typeof saveState !== "function"
    || typeof stateTransaction?.run !== "function"
    || typeof enqueueForCollect !== "function"
    || typeof completeLinkedJobsFromCollectEvidence !== "function"
    || typeof sendJson !== "function"
    || typeof sendError !== "function"
    || typeof countAccountItems !== "function"
    || typeof now !== "function"
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
      const processedAt = new Date(now());
      if (Number.isNaN(processedAt.getTime())) {
        throw new TypeError("collection route clock must return a valid instant");
      }
      const isBatch = url.pathname.endsWith("/batch");
      if (isBatch) assertCollectorScopeFieldsAbsentV4(body);
      const inputs = isBatch ? (Array.isArray(body.items) ? body.items : []) : [body];
      if (!inputs.length) throw routeError("采集请求没有商品数据", 422, "COLLECT_ITEMS_EMPTY");

      const preparedInputs = preflightCollectRequestsV4({
        authenticatedAccount: account,
        inputs,
        source: pathSource,
      });
      const admissionState=await loadState();
      const admissions=[];
      const savedBefore=[];
      for(const {prepared} of preparedInputs){
        const saved=(admissionState.caches?.collectBox||[]).find(item=>item.id===prepared.collectId&&item.accountId===account.id);
        const replay=(admissionState.collectRequests||[]).some(request=>request.accountId===account.id
          && request.idempotencyKey===prepared.idempotencyKey&&request.status==='SUCCEEDED');
        savedBefore.push(JSON.stringify(saved||null));
        const candidate=saved ? mergeCollectedItemPublicEvidence(saved,prepared.normalizedItem) : prepared.normalizedItem;
        if(saved)candidate.listingDraft=mergeOzonEnrichmentResult(candidate.listingDraft||{},candidate);
        admissions.push(replay?null:await checkAdmission({accountId:account.id,item:candidate,
          trustedAdmission:saved?.collectionAdmission||saved?.listingDraft?.collectionAdmission},{state:admissionState}));
      }
      const responseBody = await stateTransaction.run(async () => {
        const latestState = await loadState();
        const workingState = latestState;
        const imported = [];
        const results = [];
        const collectRequests = Array.isArray(workingState.collectRequests)
          ? workingState.collectRequests
          : [];
        let collectBox = Array.isArray(workingState.caches?.collectBox)
          ? workingState.caches.collectBox
          : [];

        for (let index = 0; index < preparedInputs.length; index += 1) {
          const { input, prepared } = preparedInputs[index];
          const existing = collectRequests.find((request) =>
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
            const storedItem = existing.response?.item || {};
            const existingItem = prepared.identity.source === "ozon"
              ? normalizeOzonCollectedSourceEvidence(storedItem)
              : storedItem;
            const existingEnrichment = prepared.identity.source === "ozon"
              ? existing.response?.enrichment
                || existingItem.enrichment
                || buildOzonEnrichmentSummary(existingItem)
              : null;
            const responseItem = existingEnrichment
              ? { ...existingItem, enrichment: existingEnrichment }
              : existingItem;
            imported.push({
              ...responseItem,
              collectRequestId: existing.id,
              duplicate: true,
            });
            results.push({
              index,
              sku: prepared.identity.sourceSku,
              action: "updated",
              collectItemId: existing.response?.collectItemId || existingItem.id || "",
              collectRequestId: existing.id,
              ...(existingEnrichment ? { enrichment: existingEnrichment } : {}),
            });
            continue;
          }

          const currentSaved=collectBox.find(item=>item.id===prepared.collectId&&item.accountId===account.id);
          if(!admissions[index] || JSON.stringify(currentSaved||null)!==savedBefore[index])
            throw routeError('已有采集记录已变化，请重试保存',409,'COLLECT_ADMISSION_RETRY');

          const enrichment = prepared.identity.source === "ozon"
            ? buildOzonEnrichmentSummary(admissions[index])
            : null;
          const normalized = normalizeItem({
            ...admissions[index],
            ...(enrichment ? { enrichment } : {}),
            id: prepared.collectId,
            raw: input.payload,
            sourceId: prepared.identity.source,
          }, prepared.identity.source);
          const incomingItem = {
            ...normalized,
            id: prepared.collectId,
            accountId: account.id,
            createdBy: account.id,
            source: prepared.identity.source,
            sourceSku: prepared.identity.sourceSku,
            sourceUrl: prepared.normalizedItem.sourceUrl,
            deviceFingerprint: prepared.normalizedItem.deviceFingerprint,
            capturedAt: prepared.normalizedItem.capturedAt,
            ...(enrichment ? { enrichment } : {}),
          };
          for (const field of [
            "storeId",
            "localStoreId",
            "operatingStoreId",
            "dataCollectionStoreId",
            "sellerCompanyId",
          ]) delete incomingItem[field];
          const canonicalItem = collectBox.find((row) =>
            String(row.id || "") === prepared.collectId
            && String(row.accountId || "") === account.id);
          const mergedItem = canonicalItem
            ? mergeCollectedItemPublicEvidence(canonicalItem, incomingItem)
            : incomingItem;
          const item = prepared.identity.source === "ozon"
            ? normalizeOzonCollectedSourceEvidence(mergedItem)
            : mergedItem;
          const effectiveEnrichment = enrichment
            ? reconcileOzonEnrichmentSummary(item, canonicalItem?.enrichment)
            : null;
          const captureSkus = collectCaptureSkus(item);
          if (effectiveEnrichment && captureSkus.length > 1) {
            effectiveEnrichment.status = 'PENDING_ENRICHMENT';
            effectiveEnrichment.missingSkus = captureSkus;
          }
          if (effectiveEnrichment) item.enrichment = effectiveEnrichment;
          if (effectiveEnrichment?.status === "COMPLETE") {
            const previousDraft = item.listingDraft && typeof item.listingDraft === "object"
              ? item.listingDraft
              : {};
            const mergedDraft = mergeOzonEnrichmentResult(previousDraft, item);
            if (JSON.stringify(mergedDraft) !== JSON.stringify(previousDraft)) {
              item.listingDraft = mergedDraft;
              item.draftVersion = Number(item.draftVersion || 0) + 1;
            }
            item.status = "COMPLETE";
          }
          collectBox = collectBox.filter((row) =>
            !(String(row.id) === item.id && String(row.accountId || "") === account.id));
          collectBox.unshift(item);
          workingState.caches = workingState.caches && typeof workingState.caches === "object"
            ? workingState.caches
            : {};
          workingState.caches.collectBox = collectBox;
          if (effectiveEnrichment?.status === "PENDING_ENRICHMENT") {
            for (const captureSku of captureSkus) await enqueueForCollect({
              state: workingState,
              accountId: account.id,
              collectItemId: item.id,
              requestId: prepared.identity.requestId,
              sku: captureSku,
              refreshBundle: {},
              now: processedAt,
            });
          } else if (effectiveEnrichment?.status === "COMPLETE") {
            await completeLinkedJobsFromCollectEvidence({
              state: workingState,
              accountId: account.id,
              collectItemId: item.id,
              sku: prepared.identity.sourceSku,
              now: processedAt,
            });
          }
          if (prepared.identity.source === "ozon" && categoryEvidencePort) {
            const draftVersion = Math.max(1, Number(item.draftVersion || 1));
            await categoryEvidencePort.recordCollectionResult({
              state: workingState,
              accountId: account.id,
              collectItemId: item.id,
              item,
              productDraftId: `draft:${item.id}`,
              productDraftVersion: draftVersion,
              sourceVersion: `draft:${draftVersion}`,
              capturedAt: prepared.normalizedItem.capturedAt || processedAt.toISOString(),
              rawResponseRef: `collect-request:${prepared.persistedRequestId}`,
              rawResponseHash: prepared.contentHash,
            });
          }
          const response = {
            item,
            collectItemId: item.id,
            ...(effectiveEnrichment ? { enrichment: effectiveEnrichment } : {}),
          };
          collectRequests.push({
            id: prepared.persistedRequestId,
            idempotencyKey: prepared.idempotencyKey,
            accountId: account.id,
            createdBy: account.id,
            storeId: null,
            source: prepared.identity.source,
            sourceSku: prepared.identity.sourceSku,
            sourceRequestId: prepared.identity.requestId,
            contentHash: prepared.contentHash,
            status: "SUCCEEDED",
            response,
            rawEvidence: {
              collectItemId: item.id,
              sourceRequestId: prepared.identity.requestId,
              contentHash: prepared.contentHash,
              capturedAt: prepared.normalizedItem.capturedAt || "",
              payload: structuredClone(input.payload),
            },
            createdAt: processedAt.toISOString(),
          });
          imported.push({ ...item, collectRequestId: prepared.persistedRequestId, duplicate: false });
          results.push({
            index,
            sku: prepared.identity.sourceSku,
            action: canonicalItem ? "updated" : "created",
            collectItemId: item.id,
            collectRequestId: prepared.persistedRequestId,
            ...(effectiveEnrichment ? { enrichment: effectiveEnrichment } : {}),
          });
        }
        workingState.collectRequests = collectRequests;
        workingState.caches.collectBox = collectBox;
        await saveState(workingState);
        return isBatch
          ? {
              ok: true,
              imported: imported.length,
              data: imported,
              results,
              total: countAccountItems(workingState, account).length,
            }
          : {
              ok: true,
              data: imported[0] || null,
              requestId: imported[0]?.collectRequestId || "",
              ...(imported[0]?.enrichment ? { enrichment: imported[0].enrichment } : {}),
            };
      });
      sendJson(res, 200, responseBody);
    } catch (error) {
      sendError(
        res,
        error?.status || 500,
        error?.message || "采集请求处理失败",
        error?.code || "COLLECT_REQUEST_FAILED",
        error?.missingFields?.length ? { missingFields: error.missingFields } : undefined,
      );
    }
    return true;
  };
}
