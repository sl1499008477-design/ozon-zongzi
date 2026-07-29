import "./env.mjs";
import { assertProductionConfiguration } from "./runtime-config.mjs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callOzonSellerApi } from "./ozon-client.mjs";
import { deriveOzonImportStatus } from "./ozon-import-status.mjs";
import { resolveSubmissionFailureDisposition } from "./listing-submission-policy.mjs";
import { dispatchListingOutboxOnce, getListingBoss, stopListingBoss } from "./listing-queue.mjs";
import {
  LISTING_QUEUE,
  claimSubmissionJobV3,
  enqueueSubmissionActionV3,
  incrementSubmissionStatusCheckV3,
  listingPipelineEnabled,
  loadSubmissionWorkV3,
  patchLegacyCollectStatusV3,
  readStoreCredentialV3,
  recoverStaleSubmissionJobsV3,
  releaseSubmissionLockV3,
  transitionSubmissionJobV3,
  updateSubmissionItemsV3,
} from "./listing-pipeline.mjs";

const workerId = `${process.env.HOSTNAME || "local"}_${process.pid}_${crypto.randomUUID()}`;
assertProductionConfiguration("worker");
const maxStatusChecks = Number(process.env.LISTING_MAX_STATUS_CHECKS || 240);
let relayTimer = null;
let watchdogTimer = null;
let stopping = false;

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
    errorCode: error?.code || (error?.status ? `OZON_HTTP_${error.status}` : "LISTING_WORKER_ERROR"),
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
    const items = Array.isArray(work.items) ? work.items : [];
    if (!items.length) throw Object.assign(new Error("不可变上架快照没有商品变体"), { status: 400, code: "SNAPSHOT_EMPTY" });
    const credential = await readStoreCredentialV3(work.store_id, work.account_id);
    if (!credential?.apiKey) throw Object.assign(new Error("经营店铺的 Ozon API 凭证不可用"), { status: 400, code: "STORE_CREDENTIAL_MISSING" });
    await transitionSubmissionJobV3(jobId, "SUBMITTING", {}, {
      type: "submission.ozon_request_started",
      message: `正在向 Ozon 提交 ${items.length} 个变体`,
      actorId: workerId,
    });
    const response = await callOzonSellerApi(credential, "/v3/product/import", { items }, 120000);
    const ozonTaskId = String(response?.result?.task_id || response?.task_id || "");
    if (!ozonTaskId) throw Object.assign(new Error("Ozon 已响应但未返回 task_id"), { code: "OZON_TASK_ID_MISSING" });
    const accepted = await transitionSubmissionJobV3(jobId, "OZON_ACCEPTED", {
      ozonTaskId,
      errorCode: "",
      errorMessage: "",
      resultSummary: { accepted: true, ozonTaskId },
    }, {
      type: "submission.ozon_accepted",
      message: `Ozon 已受理，task_id=${ozonTaskId}`,
      actorId: workerId,
    });
    await transitionSubmissionJobV3(jobId, "CHECKING", { ozonTaskId }, {
      type: "submission.status_check_scheduled",
      message: "已安排查询每个变体的最终结果",
      actorId: workerId,
    });
    await enqueueSubmissionActionV3(jobId, "check", 5);
    if (work.collect_item_id) await patchLegacyCollectStatusV3(work.account_id, work.collect_item_id, collectPatch("CHECKING", { ...accepted, ozon_task_id: ozonTaskId }));
  } catch (error) {
    const latest = await loadSubmissionWorkV3(jobId);
    const disposition = latest?.status === "SUBMITTING"
      ? resolveSubmissionFailureDisposition(error)
      : "FAILED";
    if (disposition === "RECONCILING") {
      await failSubmission(latest || work, error, "RECONCILING");
    } else if (disposition === "RETRY_PENDING" && Number(latest?.attempt_count || 0) < 3) {
      await transitionSubmissionJobV3(jobId, "RETRY_PENDING", {
        errorCode: error?.code || `OZON_HTTP_${error.status}`,
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
  const stocks = Array.isArray(work.stocks) ? work.stocks : [];
  if (finalStatus === "SUCCEEDED" && stocks.length) {
    try {
      const credential = await readStoreCredentialV3(work.store_id, work.account_id);
      await callOzonSellerApi(credential, "/v2/products/stocks", { stocks }, 60000);
      statusMessage = `商品已上架，${stocks.length} 条库存已同步`;
    } catch (error) {
      finalStatus = "PARTIAL_SUCCESS";
      errorMessage = `商品已上架，但库存同步失败：${error?.message || error}`;
    }
  }
  if (finalStatus === "SKIPPED") finalStatus = "FAILED";
  const completed = await transitionSubmissionJobV3(work.id, finalStatus, {
    successCount: statusInfo.success,
    failedCount: statusInfo.failed,
    skippedCount: statusInfo.skipped,
    errorCode: finalStatus === "FAILED" || finalStatus === "PARTIAL_SUCCESS" ? "OZON_ITEM_RESULT" : "",
    errorMessage,
    statusMessage,
    resultSummary: {
      success: statusInfo.success,
      failed: statusInfo.failed,
      skipped: statusInfo.skipped,
      stockCount: stocks.length,
    },
  }, {
    type: "submission.completed",
    message: statusMessage || errorMessage || "Ozon 已返回最终结果",
    actorId: workerId,
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
      throw Object.assign(new Error("任务处于待对账状态，但没有 Ozon task_id；为避免重复创建，已停止自动重提"), { code: "OZON_TASK_ID_UNKNOWN" });
    }
    if (work.status !== "CHECKING") {
      await transitionSubmissionJobV3(jobId, "CHECKING", {}, {
        type: "submission.status_check_started",
        message: "开始核对 Ozon 最终状态",
        actorId: workerId,
      });
    }
    const checkCount = await incrementSubmissionStatusCheckV3(jobId);
    const credential = await readStoreCredentialV3(work.store_id, work.account_id);
    const response = await callOzonSellerApi(credential, "/v1/product/import/info", {
      task_id: Number(work.ozon_task_id) || work.ozon_task_id,
    }, 60000);
    const statusInfo = deriveOzonImportStatus(response);
    await updateSubmissionItemsV3(jobId, statusInfo.items);
    if (statusInfo.done) {
      await finishSuccessfulImport(work, statusInfo);
    } else if (checkCount >= maxStatusChecks) {
      await failSubmission(work, Object.assign(new Error(`超过 ${maxStatusChecks} 次状态查询仍未完成`), { code: "OZON_STATUS_TIMEOUT" }), "FAILED");
    } else {
      await transitionSubmissionJobV3(jobId, "CHECKING", {
        statusMessage: `Ozon 处理中，第 ${checkCount} 次查询`,
        resultSummary: { checking: true, checkCount },
      }, { type: "submission.status_pending", actorId: workerId });
      await enqueueSubmissionActionV3(jobId, "check", checkCount < 10 ? 15 : 30);
    }
  } catch (error) {
    const latest = await loadSubmissionWorkV3(jobId);
    if (error?.code === "OZON_TASK_ID_UNKNOWN") {
      await failSubmission(latest || work, error, "RECONCILING");
    } else {
      const count = await incrementSubmissionStatusCheckV3(jobId);
      if (count >= maxStatusChecks) await failSubmission(latest || work, error, "FAILED");
      else {
        await transitionSubmissionJobV3(jobId, "CHECKING", {
          errorCode: error?.code || "OZON_STATUS_CHECK_FAILED",
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
