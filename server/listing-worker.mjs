import "./env.mjs";
import { assertProductionConfiguration } from "./runtime-config.mjs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { callOzonSellerApi } from "./ozon-client.mjs";
import { getPostgresPool } from "./db/connection.mjs";
import { resolveSubmissionStockResponseV3, readResolvedStockResponseV3, reprepareResolvedStockWriteV3 } from "./listing-stock-response.mjs";
import { reserveOzonWriteCapacity } from "./ozon-write-rate-limit.mjs";
import { deriveOzonImportStatus } from "./ozon-import-status.mjs";
import { resolveSubmissionFailureDisposition } from "./listing-submission-policy.mjs";
import { authorizeListingRfbsWritePhase } from "./listing-rfbs-write-authorization-runtime.mjs";
import { dispatchListingOutboxOnce, getListingBoss, stopListingBoss } from "./listing-queue.mjs";
import {
  LISTING_QUEUE,
  beginSubmissionCategoryRecoveryV3,
  beginSubmissionStockWriteV3,
  claimSubmissionJobV3,
  completeSubmissionCategoryRecoveryV3,
  enqueueSubmissionActionV3,
  incrementSubmissionStatusCheckV3,
  listingPipelineEnabled,
  loadSubmissionWorkV3,
  markSubmissionStockWriteAmbiguousV3,
  markSubmissionCategoryRetryAcceptedV3,
  patchLegacyCollectStatusV3,
  persistSubmissionCategoryRetryResultsV3,
  prepareSubmissionStockWriteV3,
  readStoreCredentialV3,
  recoverStaleSubmissionJobsV3,
  releaseSubmissionLockV3,
  requireSubmissionCategoryRecoveryReviewV3,
  requireSubmissionCategoryRetryUncertainReviewV3,
  transitionSubmissionJobV3,
  updateSubmissionItemsV3,
  submissionStockRequestHashV3,
} from "./listing-pipeline.mjs";

const workerId = `${process.env.HOSTNAME || "local"}_${process.pid}_${crypto.randomUUID()}`;
assertProductionConfiguration("worker");
const maxStatusChecks = Number(process.env.LISTING_MAX_STATUS_CHECKS || 240);
let relayTimer = null;
let watchdogTimer = null;
let stopping = false;

function categoryRecoveryIdentity(work) {
  const recovery = work?.categoryRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return null;
  const values = {
    accountId: work.account_id, jobId: work.id, snapshotId: work.snapshot_id,
    evidenceId: recovery.evidenceId, attemptId: recovery.attemptId,
    sourceEvidenceId: recovery.sourceEvidenceId,
    oldSharedCategoryId: recovery.oldSharedCategoryId,
    oldSharedCategoryVersion: recovery.oldSharedCategoryVersion,
    originalOzonTaskId: recovery.originalOzonTaskId,
    correlationId: recovery.correlationId,
  };
  if (Object.entries(values).some(([key, value]) => key === "oldSharedCategoryVersion"
    ? !Number.isSafeInteger(value) || value < 1 : typeof value !== "string" || !value)) return null;
  return values;
}

function sameCategoryRecoveryIdentity(leftWork, rightWork) {
  const left = categoryRecoveryIdentity(leftWork);
  const right = categoryRecoveryIdentity(rightWork);
  return left && right && Object.keys(left).every((key) => left[key] === right[key]);
}

function explicitCategoryTerminal(statusInfo) {
  return statusInfo?.done === true && statusInfo.status === "FAILED"
    && statusInfo.success === 0 && statusInfo.skipped === 0
    && Number.isSafeInteger(statusInfo.failed) && statusInfo.failed > 0
    && Array.isArray(statusInfo.items) && statusInfo.items.length === statusInfo.failed
    && statusInfo.items.every((item) => item?.status === "FAILED"
      && (item.productId === null || item.productId === "")
      && item.classification === "EXPLICIT_CATEGORY_FAILURE"
      && item.errorEvidence?.classification === "EXPLICIT_CATEGORY_FAILURE"
      && item.errorEvidence.productId === null && item.errorEvidence.offerId === item.offerId);
}

function retryTerminalItems(statusInfo) {
  if (!statusInfo || typeof statusInfo !== "object" || utilTypes.isProxy(statusInfo)
    || statusInfo.done !== true || !["SUCCEEDED", "FAILED", "PARTIAL_SUCCESS"].includes(statusInfo.status)
    || !Array.isArray(statusInfo.items) || utilTypes.isProxy(statusInfo.items)
    || statusInfo.items.length < 1 || statusInfo.items.length > 100) return null;
  const items = [];
  const offers = new Set();
  for (const item of statusInfo.items) {
    if (!item || typeof item !== "object" || utilTypes.isProxy(item) || Array.isArray(item)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (!["offerId", "status", "productId"].every((key) => descriptors[key]?.enumerable === true
      && Object.hasOwn(descriptors[key], "value"))) return null;
    const offerId = descriptors.offerId.value;
    const status = descriptors.status.value;
    const rawProductId = descriptors.productId.value;
    const productId = rawProductId === null || rawProductId === "" ? null : rawProductId;
    if (typeof offerId !== "string" || !offerId || offerId.length > 240 || offers.has(offerId)
      || !["SUCCEEDED", "FAILED", "SKIPPED"].includes(status)
      || (status === "SUCCEEDED" && (typeof productId !== "string"
        || !/^[1-9][0-9]{0,15}$/u.test(productId) || !Number.isSafeInteger(Number(productId))))
      || (status !== "SUCCEEDED" && productId !== null)) return null;
    offers.add(offerId);
    items.push(Object.freeze({ offerId, status, productId }));
  }
  return Object.freeze(items);
}

export function createListingWorkerCategoryRecoveryController({
  beginCategoryRecovery,
  recoverCategory,
  persistRetryResults,
  markRetryAccepted,
  completeRecovery,
  requireRecoveryReview,
  reviewUncertainRetry,
} = {}) {
  if ([beginCategoryRecovery, recoverCategory, persistRetryResults, markRetryAccepted,
    completeRecovery, requireRecoveryReview, reviewUncertainRetry]
    .some((port) => typeof port !== "function")) {
    throw new TypeError("listing category recovery ports are required");
  }
  async function persistRetryTerminal({ work, statusInfo } = {}) {
    const identity = categoryRecoveryIdentity(work);
    const retryOzonTaskId = work?.categoryRecovery?.retryOzonTaskId;
    const items = retryTerminalItems(statusInfo);
    if (!identity || work.categoryRecovery.status !== "RETRY_ACCEPTED"
      || typeof retryOzonTaskId !== "string" || !retryOzonTaskId
      || work.ozon_task_id !== retryOzonTaskId || !items) {
      throw Object.assign(new Error("类目恢复子结果身份无效"), {
        code: "LISTING_CATEGORY_RECOVERY_RESULT_INVALID",
      });
    }
    return persistRetryResults({
      accountId: identity.accountId, jobId: identity.jobId, snapshotId: identity.snapshotId,
      attemptId: identity.attemptId, retryOzonTaskId, items,
    });
  }
  return Object.freeze({
    async handleTerminal({ work, statusInfo } = {}) {
      const existing = categoryRecoveryIdentity(work);
      if (existing) {
        if (work.categoryRecovery.status !== "RETRY_ACCEPTED" || statusInfo?.done !== true
          || statusInfo.status === "SUCCEEDED") return Object.freeze({ handled: false });
        await persistRetryTerminal({ work, statusInfo });
        const reviewed = await this.reviewRetry({ work });
        return Object.freeze({ handled: true, attemptId: reviewed.attemptId, status: "NEEDS_REVIEW" });
      }
      if (!explicitCategoryTerminal(statusInfo)) return Object.freeze({ handled: false });
      const command = {
        accountId: work?.account_id, jobId: work?.id, snapshotId: work?.snapshot_id,
        originalOzonTaskId: work?.ozon_task_id, statusVersion: Number(work?.status_version),
        correlationId: work?.correlation_id, items: statusInfo.items,
      };
      const begun = await beginCategoryRecovery(command);
      if (begun?.status !== "FAILED" || typeof begun.evidenceId !== "string" || !begun.evidenceId) {
        return Object.freeze({ handled: false });
      }
      const recovered = await recoverCategory({
        accountId: command.accountId, jobId: command.jobId, evidenceId: begun.evidenceId,
        correlationId: command.correlationId,
      });
      if (recovered?.status !== "RETRY_PENDING" || typeof recovered.attemptId !== "string"
        || !recovered.attemptId) return Object.freeze({ handled: true,
        attemptId: recovered?.attemptId || null, status: recovered?.status || "NEEDS_REVIEW" });
      return Object.freeze({ handled: true, attemptId: recovered.attemptId, status: "RETRY_PENDING" });
    },
    async acceptRetry({ work, retryOzonTaskId } = {}) {
      const identity = categoryRecoveryIdentity(work);
      if (!identity || work.categoryRecovery.status !== "RETRY_PENDING"
        || typeof retryOzonTaskId !== "string" || !retryOzonTaskId) {
        throw Object.assign(new Error("类目恢复重试身份无效"), {
          code: "LISTING_CATEGORY_RECOVERY_IDENTITY_INVALID",
        });
      }
      return markRetryAccepted({ ...identity, retryOzonTaskId });
    },
    async completeRetry({ work } = {}) {
      const identity = categoryRecoveryIdentity(work);
      const retryOzonTaskId = work?.categoryRecovery?.retryOzonTaskId;
      if (!identity || work.categoryRecovery.status !== "RETRY_ACCEPTED"
        || typeof retryOzonTaskId !== "string" || !retryOzonTaskId
        || work.ozon_task_id !== retryOzonTaskId) {
        throw Object.assign(new Error("类目恢复重试身份无效"), {
          code: "LISTING_CATEGORY_RECOVERY_IDENTITY_INVALID",
        });
      }
      return completeRecovery({ ...identity, retryOzonTaskId });
    },
    async reviewRetry({ work } = {}) {
      const identity = categoryRecoveryIdentity(work);
      if (!identity || work.categoryRecovery.status !== "RETRY_ACCEPTED") {
        throw Object.assign(new Error("类目恢复复核身份无效"), {
          code: "LISTING_CATEGORY_RECOVERY_IDENTITY_INVALID",
        });
      }
      return requireRecoveryReview({
        ...identity, safeReviewCode: "AUTO_LISTING_CATEGORY_RECOVERY_RETRY_FAILED",
      });
    },
    async handleSubmitFailure({ work, latestWork, error } = {}) {
      const identity = categoryRecoveryIdentity(work);
      if (!identity || work.categoryRecovery.status !== "RETRY_PENDING") {
        return Object.freeze({ handled: false });
      }
      const latestRecovery = latestWork?.categoryRecovery;
      if (sameCategoryRecoveryIdentity(work, latestWork)
        && latestRecovery?.status === "RETRY_ACCEPTED"
        && typeof latestRecovery.retryOzonTaskId === "string" && latestRecovery.retryOzonTaskId
        && latestWork.ozon_task_id === latestRecovery.retryOzonTaskId) {
        return Object.freeze({ handled: true, status: "RETRY_ACCEPTED",
          retryOzonTaskId: latestRecovery.retryOzonTaskId });
      }
      const safeReviewCode = resolveSubmissionFailureDisposition(error) === "RECONCILING"
        ? "AUTO_LISTING_CATEGORY_RETRY_TASK_UNKNOWN"
        : "AUTO_LISTING_CATEGORY_RETRY_SUBMIT_FAILED";
      const reviewed = await reviewUncertainRetry({ ...identity, safeReviewCode });
      return Object.freeze({ handled: true, attemptId: reviewed.attemptId, status: "NEEDS_REVIEW" });
    },
    persistRetryTerminal,
  });
}

const productionCategoryRecoveryController = createListingWorkerCategoryRecoveryController({
  beginCategoryRecovery: beginSubmissionCategoryRecoveryV3,
  recoverCategory: async () => {
    throw Object.assign(new Error("生产类目错误策略尚未启用"), {
      code: "AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED", status: 409, retryable: false,
    });
  },
  persistRetryResults: persistSubmissionCategoryRetryResultsV3,
  markRetryAccepted: markSubmissionCategoryRetryAcceptedV3,
  completeRecovery: completeSubmissionCategoryRecoveryV3,
  requireRecoveryReview: requireSubmissionCategoryRecoveryReviewV3,
  reviewUncertainRetry: requireSubmissionCategoryRetryUncertainReviewV3,
});

export async function completeListingCategoryRetryAndContinue({
  work,
  statusInfo,
  controller,
  continueImport,
} = {}) {
  if (statusInfo?.done !== true || statusInfo.status !== "SUCCEEDED"
    || typeof controller?.completeRetry !== "function" || typeof continueImport !== "function") {
    throw Object.assign(new Error("类目恢复成功续接参数无效"), {
      code: "LISTING_CATEGORY_RECOVERY_CONTINUATION_INVALID",
    });
  }
  await controller.persistRetryTerminal({ work, statusInfo });
  await controller.completeRetry({ work });
  return continueImport(work, statusInfo);
}

export async function resumeListingCategoryRecoveryFromChildResults({
  work, controller = productionCategoryRecoveryController, continueImport,
} = {}) {
  const recovery = work?.categoryRecovery;
  if (!recovery || !["CHECKING", "RECONCILING"].includes(work?.status)
    || !["RETRY_ACCEPTED", "SUCCEEDED", "NEEDS_REVIEW"].includes(recovery.status)
    || !Array.isArray(work.categoryRecoveryResults) || work.categoryRecoveryResults.length < 1) {
    return Object.freeze({ handled: false });
  }
  const rawItems = work.categoryRecoveryResults;
  if (!Array.isArray(work.items) || rawItems.length !== work.items.length) {
    throw Object.assign(new Error("类目恢复子结果不完整"), {
      code: "LISTING_CATEGORY_RECOVERY_RESULT_INVALID",
    });
  }
  const success = rawItems.filter((item) => item?.status === "SUCCEEDED").length;
  const skipped = rawItems.filter((item) => item?.status === "SKIPPED").length;
  const failed = rawItems.length - success - skipped;
  const status = success === rawItems.length ? "SUCCEEDED" : success > 0 ? "PARTIAL_SUCCESS" : "FAILED";
  const statusInfo = Object.freeze({
    done: true, status, success, failed, skipped,
    items: Object.freeze(rawItems.map((item) => Object.freeze({
      offerId: item?.offerId, status: item?.status, productId: item?.productId ?? null,
    }))),
    errorMessage: "", statusMessage: "",
  });
  if (!retryTerminalItems(statusInfo) || typeof continueImport !== "function") {
    throw Object.assign(new Error("类目恢复子结果无效"), {
      code: "LISTING_CATEGORY_RECOVERY_RESULT_INVALID",
    });
  }
  if (recovery.status === "RETRY_ACCEPTED") {
    if (status === "SUCCEEDED") await controller.completeRetry({ work });
    else await controller.reviewRetry({ work });
  }
  await continueImport(work, statusInfo);
  return Object.freeze({ handled: true, status });
}

export function resolveListingSubmitFailureDispositionForWork(work, error) {
  if (work?.categoryRecovery?.status === "RETRY_PENDING") return "FAILED";
  return resolveSubmissionFailureDisposition(error);
}

function collectPatch(status, job = {}, extra = {}) {
  const statusText = {
    QUEUE_PENDING: "上架中",
    QUEUED: "上架中",
    VALIDATING: "上架中",
    SUBMITTING: "上架中",
    OZON_ACCEPTED: "上架中",
    CHECKING: "上架中",
    RECONCILING: "待核对",
    RETRY_PENDING: "上架中",
    SUCCEEDED: "已上架",
    PARTIAL_SUCCESS: "部分成功",
    FAILED: "失败",
    CANCELLED: "已取消",
  }[status] || status;
  return {
    status: statusText,
    listingJobId: job.id || "",
    listingTaskId: job.ozon_task_id || job.ozonTaskId || "",
    listingLastError: extra.errorMessage || job.error_message || "",
    listingStatusMessage: extra.statusMessage || job.status_message || "",
    ...(status === "SUCCEEDED" || status === "PARTIAL_SUCCESS" || status === "FAILED"
      ? { listingCompletedAt: new Date().toISOString() }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

async function failSubmission(work, error, status = "FAILED") {
  const row = await transitionSubmissionJobV3(work.id, status, {
    errorCode: error?.code || (error?.status ? `ZONGZI_HTTP_${error.status}` : "LISTING_WORKER_ERROR"),
    errorMessage: error?.message || String(error),
  }, {
    type: status === "RECONCILING" ? "submission.reconciliation_required" : "submission.failed",
    message: error?.message || String(error),
    actorId: workerId,
    payload: { network: Boolean(error?.body?.network), status: error?.status || null },
  });
  if (work.collect_item_id) await patchLegacyCollectStatusV3(work.account_id, work.collect_item_id, collectPatch(status, row));
  return row;
}

async function processSubmit(jobId) {
  let work = await loadSubmissionWorkV3(jobId);
  if (!work) throw new Error(`V3 上架任务不存在: ${jobId}`);
  if (["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "CANCELLED", "OZON_ACCEPTED", "CHECKING"].includes(work.status)) return;
  const claimed = await claimSubmissionJobV3(jobId, workerId, ["QUEUE_PENDING", "QUEUED", "RETRY_PENDING"]);
  if (!claimed) return;
  work = await loadSubmissionWorkV3(jobId);
  try {
    if (work.status === "QUEUE_PENDING") {
      await transitionSubmissionJobV3(jobId, "QUEUED", {}, { force: true, type: "submission.queue_recovered", actorId: workerId });
    }
    await transitionSubmissionJobV3(jobId, "VALIDATING", {}, {
      type: "submission.worker_claimed",
      message: "Worker 已读取不可变快照并开始最终校验",
      actorId: workerId,
    });
    const items = Array.isArray(work.effectiveItems) ? work.effectiveItems : [];
    if (!items.length) throw Object.assign(new Error("不可变上架快照没有商品变体"), { status: 400, code: "SNAPSHOT_EMPTY" });
    await authorizeListingRfbsWritePhase(work, "PRE_IMPORT");
    const credential = await readStoreCredentialV3(work.store_id, work.account_id);
    if (!credential?.apiKey) throw Object.assign(new Error("经营店铺的 Ozon API 凭证不可用"), { status: 400, code: "STORE_CREDENTIAL_MISSING" });
    await transitionSubmissionJobV3(jobId, "SUBMITTING", {}, {
      type: "submission.ozon_request_started",
      message: `正在向 Ozon 提交 ${items.length} 个变体`,
      actorId: workerId,
    });
    const response = await callOzonSellerApi(credential, "/v3/product/import", { items }, 120000);
    const ozonTaskId = String(response?.result?.task_id || response?.task_id || "");
    if (!ozonTaskId) throw Object.assign(new Error("Ozon 已响应但未返回 task_id"), { code: "ZONGZI_TASK_ID_MISSING" });
    let accepted;
    if (work.categoryRecovery?.status === "RETRY_PENDING") {
      await productionCategoryRecoveryController.acceptRetry({ work, retryOzonTaskId: ozonTaskId });
      accepted = await loadSubmissionWorkV3(jobId);
    } else {
      accepted = await transitionSubmissionJobV3(jobId, "OZON_ACCEPTED", {
        ozonTaskId,
        errorCode: "",
        errorMessage: "",
        resultSummary: { accepted: true, ozonTaskId },
      }, {
        type: "submission.ozon_accepted",
        message: `Ozon 已受理，task_id=${ozonTaskId}`,
        actorId: workerId,
      });
    }
    await transitionSubmissionJobV3(jobId, "CHECKING", { ozonTaskId }, {
      type: "submission.status_check_scheduled",
      message: "已安排查询每个变体的最终结果",
      actorId: workerId,
    });
    await enqueueSubmissionActionV3(jobId, "check", 5);
    if (work.collect_item_id) await patchLegacyCollectStatusV3(work.account_id, work.collect_item_id, collectPatch("CHECKING", { ...accepted, ozon_task_id: ozonTaskId }));
  } catch (error) {
    const latest = await loadSubmissionWorkV3(jobId);
    const uncertainRecovery = await productionCategoryRecoveryController.handleSubmitFailure({
      work, latestWork: latest, error,
    });
    if (uncertainRecovery.handled) return;
    const disposition = latest?.status === "SUBMITTING"
      ? resolveListingSubmitFailureDispositionForWork(work, error)
      : "FAILED";
    if (/^LISTING_RFBS_PHASE_/u.test(String(error?.code || "")) && latest?.status === "VALIDATING"
      && Number(latest?.attempt_count || 0) < 3) {
      await transitionSubmissionJobV3(jobId, "RETRY_PENDING", {
        errorCode: error.code,
        errorMessage: error.message,
        statusMessage: "RFBS 仓库写入前验证暂时失败，任务将安全重试",
      }, { type: "submission.rfbs_phase_retry_scheduled", message: error.message, actorId: workerId });
      await enqueueSubmissionActionV3(jobId, "submit", Math.max(5, Number(latest?.attempt_count || 1) * 15));
    } else if (disposition === "RECONCILING") {
      await failSubmission(latest || work, error, "RECONCILING");
    } else if (disposition === "RETRY_PENDING" && Number(latest?.attempt_count || 0) < 3) {
      await transitionSubmissionJobV3(jobId, "RETRY_PENDING", {
        errorCode: error?.code || `ZONGZI_HTTP_${error.status}`,
        errorMessage: error?.message || String(error),
        statusMessage: "Ozon 暂时不可用，任务将自动重试",
      }, { type: "submission.retry_scheduled", message: error?.message || String(error), actorId: workerId });
      await enqueueSubmissionActionV3(jobId, "submit", Math.max(5, Number(latest?.attempt_count || 1) * 15));
    } else {
      await failSubmission(latest || work, error, "FAILED");
    }
  } finally {
    await releaseSubmissionLockV3(jobId, workerId);
  }
}

async function finishSuccessfulImport(work, statusInfo) {
  let finalStatus = statusInfo.status;
  let statusMessage = statusInfo.statusMessage || "";
  let errorMessage = statusInfo.errorMessage || "";
  let completionErrorCode = "";
  const successfulOffers = new Set((statusInfo.items || [])
    .filter((item) => item.status === "SUCCEEDED").map((item) => item.offerId));
  // Snapshot order is immutable and retains the identity of pre-upgrade journals.
  const stocks = (Array.isArray(work.stocks) ? work.stocks : [])
    .filter((stock) => successfulOffers.has(stock.offer_id));
  const stockResults = new Map((work.result_summary?.stockResults || [])
    .map((result) => [`${result.offerId}:${result.warehouseId}`, result]));
  const recordStock = (stock, status, errors = [], updated = status === "SUCCEEDED" ? true : null) => stockResults.set(
    `${stock.offer_id}:${stock.warehouse_id}`,
    { offerId: stock.offer_id, warehouseId: String(stock.warehouse_id), status, errors, updated },
  );
  const summary = () => ({
    success: statusInfo.success, failed: statusInfo.failed, skipped: statusInfo.skipped,
    stockCount: stocks.length,
    stockSuccessCount: [...stockResults.values()].filter((item) => item.status === "SUCCEEDED").length,
    stockResults: [...stockResults.values()],
  });
  const waitForStock = async (message, delayMs) => {
    await transitionSubmissionJobV3(work.id, "CHECKING", {
      errorCode: "", errorMessage: "", statusMessage: message,
      resultSummary: { ...summary(), stockWaiting: true },
    }, { type: "submission.stock_waiting", message, actorId: workerId });
    await enqueueSubmissionActionV3(work.id, "check", Math.max(1, Math.ceil(delayMs / 1000)));
  };
  const itemByOffer = new Map((work.submissionItems || []).map((item) => [item.offerId, item.submissionItemId]));
  const commandFor = (batch) => {
    const stockItems = batch.map((stock) => ({
      submissionItemId: itemByOffer.get(stock.offer_id), offerId: stock.offer_id,
      warehouseId: String(stock.warehouse_id), quantity: stock.stock,
    }));
    return {
      accountId: work.account_id, jobId: work.id, snapshotId: work.snapshot_id,
      storeId: work.store_id, importOzonTaskId: work.ozon_task_id,
      recoveryAttemptId: work.categoryRecovery?.retryOzonTaskId === work.ozon_task_id
        ? work.categoryRecovery.attemptId : null,
      requestHash: submissionStockRequestHashV3(stockItems), correlationId: work.correlation_id,
      actorId: workerId, stocks: stockItems,
    };
  };
  const restoreJournal = async (prepared, command, batch) => {
    if (prepared.status === "DONE") {
      batch.forEach((stock) => recordStock(stock, "SUCCEEDED"));
      return true;
    }
    if (prepared.status === "RESOLVED") {
      const results = await readResolvedStockResponseV3(command);
      for (const result of results) {
        const key = `${result.offerId}:${result.warehouseId}`;
        stockResults.set(key, result);
      }
      return true;
    }
    if (!["IN_FLIGHT", "AMBIGUOUS"].includes(prepared.status)) return false;
    if (prepared.status === "IN_FLIGHT") await markSubmissionStockWriteAmbiguousV3(command);
    for (const stock of batch) {
      if (!stockResults.has(`${stock.offer_id}:${stock.warehouse_id}`)
        || stockResults.get(`${stock.offer_id}:${stock.warehouse_id}`)?.status === "RETRYABLE") {
        recordStock(stock, "UNKNOWN", ["ZONGZI_STOCK_RESULT_AMBIGUOUS"]);
      }
    }
    return true;
  };
  const resumeStockBatch = async (batch) => {
    let stockCommand = commandFor(batch);
    let prepared = await prepareSubmissionStockWriteV3(stockCommand);
    while (await restoreJournal(prepared, stockCommand, batch)) {
      if (prepared.status !== "RESOLVED") { batch = []; break; }
      const retry = batch.filter((stock) => stockResults.get(`${stock.offer_id}:${stock.warehouse_id}`)?.status === "RETRYABLE");
      if (!retry.length) { batch = []; break; }
      if (retry.length === batch.length) {
        prepared = await reprepareResolvedStockWriteV3(stockCommand);
        break;
      }
      batch = retry;
      stockCommand = commandFor(batch);
      prepared = await prepareSubmissionStockWriteV3(stockCommand);
    }
    return {batch, stockCommand};
  };
  if (["SUCCEEDED", "PARTIAL_SUCCESS"].includes(finalStatus) && stocks.length) {
    try {
      let legacyHandled = false;
      // Old workers submitted the whole immutable snapshot in one request. Check
      // that journal before creating smaller intents, so an upgrade cannot resend it.
      if (stocks.length > 100 && finalStatus === "SUCCEEDED") {
        const legacyCommand = commandFor(stocks);
        const legacy = await (await getPostgresPool()).query(
          `SELECT status FROM submission_stock_write_intents
           WHERE account_id=$1 AND submission_job_id=$2 AND submission_snapshot_id=$3
             AND store_id=$4 AND import_ozon_task_id=$5
             AND recovery_attempt_id IS NOT DISTINCT FROM $6::text
             AND request_hash=$7 AND stock_items=$8::jsonb`,
          [legacyCommand.accountId, legacyCommand.jobId, legacyCommand.snapshotId,
            legacyCommand.storeId, legacyCommand.importOzonTaskId, legacyCommand.recoveryAttemptId,
            legacyCommand.requestHash, JSON.stringify(legacyCommand.stocks)],
        );
        if (legacy.rows[0]) legacyHandled = await restoreJournal(legacy.rows[0], legacyCommand, stocks);
      }
      for (let offset = 0; !legacyHandled && offset < stocks.length; offset += 100) {
        let {batch, stockCommand} = await resumeStockBatch(stocks.slice(offset, offset + 100));
        if (!batch.length) continue;
        try { await authorizeListingRfbsWritePhase(work, "PRE_STOCK", {stocks: batch}); }
        catch (error) {
          if (error?.code === "LISTING_RFBS_PHASE_VALIDATION_REQUIRED" && error.retryable === true) {
            await waitForStock("RFBS 仓库官方核验暂不可用，稍后继续库存同步", 60000);
            return;
          }
          throw error;
        }
        const credential = await readStoreCredentialV3(work.store_id, work.account_id);
        let response;
        try {
          response = await callOzonSellerApi(credential, "/v3/product/info/list", {
            offer_id: batch.map((stock) => stock.offer_id),
          }, 60000);
        } catch (error) {
          const status = Number(error?.status);
          if (status === 429 || (status >= 500 && status < 600)
            || ["ZONGZI_TIMEOUT", "ZONGZI_NETWORK_ERROR"].includes(error?.code)) {
            await waitForStock("Ozon 商品就绪查询暂不可用，稍后继续同步库存", 60000);
            return;
          }
          throw error;
        }
        const products = Array.isArray(response?.items) ? response.items
          : Array.isArray(response?.result?.items) ? response.result.items : [];
        const declined = batch.filter((stock) => products.some((item) => item.offer_id === stock.offer_id
          && item.statuses?.is_created === false
          && [item.statuses?.moderate_status, item.statuses?.status_failed].includes("declined")));
        for (const stock of declined) {
          const product = products.find(item => item.offer_id === stock.offer_id);
          recordStock(stock, "FAILED", ["ZONGZI_PRODUCT_MODERATION_DECLINED", ...(Array.isArray(product.errors) ? product.errors : [])
            .map(error => String(error?.code || "ZONGZI_PRODUCT_ERROR").slice(0, 120))]);
        }
        if (declined.length) {
          const rejectedOffers = new Set(declined.map(stock => stock.offer_id));
          batch = batch.filter(stock => !rejectedOffers.has(stock.offer_id));
          if (!batch.length) continue;
          ({batch, stockCommand} = await resumeStockBatch(batch));
          if (!batch.length) continue;
        }
        if (!batch.every((stock) => products.some((item) => item.offer_id === stock.offer_id
          && item.statuses?.status === "price_sent"))) {
          await waitForStock("商品价格仍在 Ozon 处理中，稍后继续同步库存", 60000);
          return;
        }
        const capacity = await reserveOzonWriteCapacity({
          pool: await getPostgresPool(), sellerId: credential.clientId, operation: "stock",
          requestKey: crypto.randomUUID(), units: 1,
          pairKeys: batch.map((stock) => `${stock.offer_id}:${stock.warehouse_id}`),
          limit: 80, clock: Date.now,
        });
        if (!capacity.allowed) {
          await waitForStock("等待 Ozon 库存写入额度，稍后继续", capacity.retryAfterMs);
          return;
        }
        const begun = await beginSubmissionStockWriteV3(stockCommand);
        if (begun.status !== "IN_FLIGHT") {
          throw Object.assign(new Error("库存写入状态无法安全开始"), { code: "LISTING_STOCK_WRITE_IDENTITY_CONFLICT" });
        }
        try {
          const written = await callOzonSellerApi(credential, "/v2/products/stocks", { stocks: batch }, 60000);
          for (const stock of batch) {
            const matches = Array.isArray(written?.result) ? written.result.filter((item) =>
              item.offer_id === stock.offer_id && String(item.warehouse_id) === String(stock.warehouse_id)) : [];
            const item = matches.length === 1 ? matches[0] : null;
            const errors = (Array.isArray(item?.errors) ? item.errors : []).map((error) =>
              String(error?.code || "ZONGZI_STOCK_ITEM_ERROR").slice(0, 120));
            if (item?.updated === true && !errors.length) recordStock(stock, "SUCCEEDED");
            else if (item?.updated === false) {
              const retryable = errors.length > 0 && errors.every((code) =>
                ["PRODUCT_HAS_NOT_BEEN_TAGGED_YET", "TOO_MANY_REQUESTS"].includes(code));
              recordStock(stock, retryable ? "RETRYABLE" : "FAILED",
                errors.length ? errors : ["ZONGZI_STOCK_NOT_UPDATED"], false);
            } else recordStock(stock, "UNKNOWN", errors.length ? errors : ["ZONGZI_STOCK_RESULT_AMBIGUOUS"]);
          }
          // Receipt and per-item summary are atomic; the append-only event retains
          // each attempt even when a fully retryable request reuses its identity.
          await resolveSubmissionStockResponseV3(stockCommand, summary());
        } catch (error) {
          for (const stock of batch) {
            if (!stockResults.has(`${stock.offer_id}:${stock.warehouse_id}`)
              || stockResults.get(`${stock.offer_id}:${stock.warehouse_id}`)?.status === "RETRYABLE") recordStock(stock, "UNKNOWN", ["ZONGZI_STOCK_RESULT_AMBIGUOUS"]);
          }
          await markSubmissionStockWriteAmbiguousV3(stockCommand,
            Number.isSafeInteger(error?.status) && error.status > 0
              ? "ZONGZI_STOCK_WRITE_REJECTED" : "ZONGZI_STOCK_WRITE_AMBIGUOUS");
          throw error;
        }
      }
    } catch (error) {
      finalStatus = "PARTIAL_SUCCESS";
      completionErrorCode = error?.code === "LISTING_STOCK_WRITE_IDENTITY_CONFLICT"
        ? "ZONGZI_STOCK_WRITE_BLOCKED" : "ZONGZI_STOCK_WRITE_FAILED";
      errorMessage = `${errorMessage ? `${errorMessage}；` : ""}已导入商品的库存同步未完成：${error?.message || error}`;
    }
    if (!completionErrorCode && [...stockResults.values()].some((item) => item.status === "RETRYABLE")) {
      await waitForStock("Ozon 暂未受理部分库存，稍后仅重试这些库存项", 60000);
      return;
    }
    const pendingResults = [...stockResults.values()].filter((item) => item.status !== "SUCCEEDED");
    if (pendingResults.length) {
      finalStatus = "PARTIAL_SUCCESS";
      completionErrorCode ||= pendingResults.some((item) => item.status === "UNKNOWN")
        ? "ZONGZI_STOCK_RESULT_AMBIGUOUS" : "ZONGZI_STOCK_ITEM_FAILED";
      const detail = pendingResults.map((item) => `${item.offerId}: ${item.errors.join(", ")}`).join("；");
      errorMessage = `${errorMessage ? `${errorMessage}；` : ""}库存待处理：${detail}`;
    }
    statusMessage = `已导入 ${statusInfo.success} 个商品，${summary().stockSuccessCount}/${stocks.length} 条库存已同步`;
  }
  if (finalStatus === "SKIPPED") finalStatus = "FAILED";
  const completed = await transitionSubmissionJobV3(work.id, finalStatus, {
    successCount: statusInfo.success, failedCount: statusInfo.failed, skippedCount: statusInfo.skipped,
    errorCode: completionErrorCode
      || (finalStatus === "FAILED" || finalStatus === "PARTIAL_SUCCESS" ? "ZONGZI_ITEM_RESULT" : ""),
    errorMessage, statusMessage, resultSummary: summary(),
  }, {
    type: "submission.completed", message: statusMessage || errorMessage || "Ozon 已返回最终结果", actorId: workerId,
  });
  if (work.collect_item_id) await patchLegacyCollectStatusV3(work.account_id, work.collect_item_id, collectPatch(finalStatus, completed, { errorMessage, statusMessage }));
}

async function processCheck(jobId) {
  let work = await loadSubmissionWorkV3(jobId);
  if (!work || ["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "CANCELLED"].includes(work.status)) return;
  const claimed = await claimSubmissionJobV3(jobId, workerId, ["OZON_ACCEPTED", "CHECKING", "RECONCILING"]);
  if (!claimed) return;
  work = await loadSubmissionWorkV3(jobId);
  try {
    if (!work.ozon_task_id) {
      throw Object.assign(new Error("任务处于待对账状态，但没有 Ozon task_id；为避免重复创建，已停止自动重提"), { code: "ZONGZI_TASK_ID_UNKNOWN" });
    }
    if (work.status !== "CHECKING") {
      await transitionSubmissionJobV3(jobId, "CHECKING", {}, {
        type: "submission.status_check_started",
        message: "开始核对 Ozon 最终状态",
        actorId: workerId,
      });
      work = await loadSubmissionWorkV3(jobId);
    }
    const resumedRecovery = await resumeListingCategoryRecoveryFromChildResults({
      work, controller: productionCategoryRecoveryController, continueImport: finishSuccessfulImport,
    });
    if (resumedRecovery.handled) return;
    const checkCount = await incrementSubmissionStatusCheckV3(jobId);
    const credential = await readStoreCredentialV3(work.store_id, work.account_id);
    const response = await callOzonSellerApi(credential, "/v1/product/import/info", {
      task_id: Number(work.ozon_task_id) || work.ozon_task_id,
    }, 60000);
    const statusInfo = deriveOzonImportStatus(response, {
      expectedOfferIds: (Array.isArray(work.effectiveItems) ? work.effectiveItems : [])
        .map((item) => String(item?.offer_id || "")),
    });
    if (work.categoryRecovery?.status !== "RETRY_ACCEPTED") {
      await updateSubmissionItemsV3({
        accountId: work.account_id,
        jobId,
        snapshotId: work.snapshot_id,
        ozonTaskId: work.ozon_task_id,
        statusVersion: Number(work.status_version),
        items: statusInfo.items,
      });
    }
    if (statusInfo.done) {
      if (statusInfo.status === "SUCCEEDED" && work.categoryRecovery?.status === "RETRY_ACCEPTED") {
        await completeListingCategoryRetryAndContinue({
          work, statusInfo, controller: productionCategoryRecoveryController,
          continueImport: finishSuccessfulImport,
        });
        return;
      } else {
        let category = { handled: false };
        try {
          category = await productionCategoryRecoveryController.handleTerminal({ work, statusInfo });
        } catch (error) {
          if (error?.code !== "AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED") throw error;
        }
        if (category.handled && category.status === "RETRY_PENDING") return;
      }
      await finishSuccessfulImport(work, statusInfo);
    } else if (checkCount >= maxStatusChecks) {
      await failSubmission(work, Object.assign(new Error(`超过 ${maxStatusChecks} 次状态查询仍未完成`), { code: "ZONGZI_STATUS_TIMEOUT" }), "FAILED");
    } else {
      await transitionSubmissionJobV3(jobId, "CHECKING", {
        statusMessage: `Ozon 处理中，第 ${checkCount} 次查询`,
        resultSummary: { checking: true, checkCount },
      }, { type: "submission.status_pending", actorId: workerId });
      await enqueueSubmissionActionV3(jobId, "check", checkCount < 10 ? 15 : 30);
    }
  } catch (error) {
    const latest = await loadSubmissionWorkV3(jobId);
    if (["ZONGZI_TASK_ID_UNKNOWN", "ZONGZI_IMPORT_RESULT_CONFLICT",
      "ZONGZI_IMPORT_RESULT_SCOPE_MISMATCH", "ZONGZI_IMPORT_OFFER_IDENTITY_MISMATCH",
      "ZONGZI_IMPORT_RESULT_CONTRACT_INVALID"].includes(error?.code)) {
      await failSubmission(latest || work, error, "RECONCILING");
    } else {
      const count = await incrementSubmissionStatusCheckV3(jobId);
      if (count >= maxStatusChecks) await failSubmission(latest || work, error, "FAILED");
      else {
        await transitionSubmissionJobV3(jobId, "CHECKING", {
          errorCode: error?.code || "ZONGZI_STATUS_CHECK_FAILED",
          errorMessage: error?.message || String(error),
          statusMessage: "状态查询暂时失败，稍后自动重试",
        }, { type: "submission.status_check_retry", message: error?.message || String(error), actorId: workerId });
        await enqueueSubmissionActionV3(jobId, "check", Math.min(120, Math.max(15, count * 10)));
      }
    }
  } finally {
    await releaseSubmissionLockV3(jobId, workerId);
  }
}

export async function processListingQueueMessage(data = {}) {
  const jobId = String(data.submissionJobId || "");
  if (!jobId) throw new Error("队列消息缺少 submissionJobId");
  if (data.action === "check") return processCheck(jobId);
  return processSubmit(jobId);
}

async function relayLoop() {
  if (stopping) return;
  try {
    await dispatchListingOutboxOnce({ workerId: `${workerId}_relay`, limit: 100 });
  } catch (error) {
    console.error(`[listing-worker] outbox relay failed: ${error?.message || error}`);
  } finally {
    if (!stopping) relayTimer = setTimeout(relayLoop, 1000);
  }
}

async function watchdogLoop() {
  if (stopping) return;
  try {
    const recovered = await recoverStaleSubmissionJobsV3({ workerId: `${workerId}_watchdog`, limit: 100 });
    if (recovered.length) console.warn(`[listing-worker] recovered ${recovered.length} stale submission job(s)`);
  } catch (error) {
    console.error(`[listing-worker] watchdog failed: ${error?.message || error}`);
  } finally {
    if (!stopping) watchdogTimer = setTimeout(watchdogLoop, 30000);
  }
}

export async function startListingWorker() {
  if (!listingPipelineEnabled()) throw new Error("V3 上架 Worker 需要 PostgreSQL，并且 LISTING_PIPELINE_V3 不能为 0");
  const boss = await getListingBoss();
  await boss.work(LISTING_QUEUE, {
    localConcurrency: Math.max(1, Number(process.env.LISTING_WORKER_CONCURRENCY || 2)),
    groupConcurrency: { default: 1 },
    pollingIntervalSeconds: 1,
    heartbeatRefreshSeconds: 10,
  }, async (jobs) => {
    for (const job of jobs) await processListingQueueMessage(job.data || {});
  });
  relayLoop();
  watchdogLoop();
  console.log(`[listing-worker] started ${workerId}`);
}

export async function stopListingWorker() {
  stopping = true;
  if (relayTimer) clearTimeout(relayTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  relayTimer = null;
  watchdogTimer = null;
  await stopListingBoss();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startListingWorker().catch((error) => {
    console.error(`[listing-worker] startup failed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stopListingWorker().finally(() => process.exit(0)));
  }
}
