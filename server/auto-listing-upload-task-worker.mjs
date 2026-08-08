const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const STALE_CODES = new Set([
  "AUTO_LISTING_UPLOAD_STATE_INVALID", "AUTO_LISTING_UPLOAD_BLOCKED",
  "AUTO_LISTING_UPLOAD_NOT_FOUND", "AUTO_LISTING_UPLOAD_VERSION_CONFLICT",
]);

function workerError(code = "AUTO_LISTING_UPLOAD_WORKER_INVALID") {
  const error = new Error("自动上架上传后台任务暂时不可用");
  error.code = code;
  error.retryable = false;
  return error;
}

function ownCode(error, fallback = "AUTO_LISTING_UPLOAD_WORKER_FAILED") {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : null;
    const value = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
  } catch { return fallback; }
}

function retryable(error) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "retryable") : null;
    return descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === true;
  } catch { return false; }
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function delay(attempt, base, maximum) {
  return Math.min(maximum, base * (2 ** Math.max(0, Math.min(30, attempt - 1))));
}

function resultEvidence(result) {
  let keys;
  try { keys = Reflect.ownKeys(result); } catch { throw workerError("AUTO_LISTING_UPLOAD_WORKER_RESULT_INVALID"); }
  if (!result || typeof result !== "object" || Array.isArray(result)
    || keys.length !== 5
    || !["itemId", "status", "submissionJobId", "submissionSnapshotId", "duplicate"].every((key) => keys.includes(key))
    || !SAFE_ID.test(result.itemId || "") || !SAFE_CODE.test(result.status || "")
    || !SAFE_ID.test(result.submissionJobId || "") || !SAFE_ID.test(result.submissionSnapshotId || "")
    || typeof result.duplicate !== "boolean") {
    throw workerError("AUTO_LISTING_UPLOAD_WORKER_RESULT_INVALID");
  }
  return { outcome: "SUBMITTED", code: null };
}

export function createAutoListingUploadTaskWorker(config = {}) {
  let enabled;
  try {
    const descriptor = config && typeof config === "object"
      ? Object.getOwnPropertyDescriptor(config, "enabled") : null;
    enabled = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { throw workerError(); }
  if (typeof enabled !== "boolean") throw workerError();
  if (!enabled) return Object.freeze({ async start() { return false; }, async runOnce() { return false; }, async stop() {} });

  let value;
  try {
    const allowed = new Set(["enabled", "repository", "uploadService", "workerId", "accountScanLimit",
      "pollIntervalMs", "leaseMs", "baseDelayMs", "maxDelayMs", "maxAttempts", "logger", "timers"]);
    const keys = Reflect.ownKeys(config);
    const descriptors = Object.getOwnPropertyDescriptors(config);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw workerError();
    value = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (ownCode(error) === "AUTO_LISTING_UPLOAD_WORKER_INVALID") throw error;
    throw workerError();
  }
  const { repository, uploadService, workerId, accountScanLimit, pollIntervalMs, leaseMs,
    baseDelayMs, maxDelayMs, maxAttempts, logger, timers } = value;
  if (![repository?.listRunnableAccounts, repository?.leaseNext, repository?.completeLease,
    repository?.rescheduleLease, repository?.deadLetterLease].every((entry) => typeof entry === "function")
    || typeof uploadService?.submitAutoListingItem !== "function"
    || typeof workerId !== "string" || !SAFE_ID.test(workerId)
    || !integer(accountScanLimit, 1, 1_000) || !integer(pollIntervalMs, 100, 300_000)
    || !integer(leaseMs, 1_000, 900_000) || !integer(baseDelayMs, 100, 86_400_000)
    || !integer(maxDelayMs, baseDelayMs, 86_400_000) || !integer(maxAttempts, 1, 999)
    || typeof logger?.log !== "function" || typeof timers?.setTimeout !== "function"
    || typeof timers?.clearTimeout !== "function") throw workerError();

  let cursor = null;
  let running = false;
  let timer = null;
  let inFlight = null;

  function log(task, code) {
    try { logger.log(Object.freeze({ component: "AUTO_LISTING_UPLOAD_DISPATCH",
      taskId: task?.taskId || "unknown", correlationId: task ? `${task.taskId}:${task.attemptCount}` : "unknown",
      code })); } catch {}
  }

  async function accounts() {
    let result = await repository.listRunnableAccounts({ afterAccountId: cursor, limit: accountScanLimit });
    if ((!Array.isArray(result) || result.length === 0) && cursor !== null) {
      cursor = null;
      result = await repository.listRunnableAccounts({ afterAccountId: null, limit: accountScanLimit });
    }
    if (!Array.isArray(result) || result.some((entry) => typeof entry !== "string" || !SAFE_ID.test(entry))) {
      throw workerError("AUTO_LISTING_UPLOAD_WORKER_ACCOUNTS_INVALID");
    }
    return result;
  }

  async function processOne() {
    const accountIds = await accounts();
    for (const accountId of accountIds) {
      cursor = accountId;
      const task = await repository.leaseNext({ accountId, workerId, leaseMs });
      if (!task) continue;
      if (task.accountId !== accountId || task.actor?.id !== accountId
        || !["admin", "user"].includes(task.actor?.role)) {
        throw workerError("AUTO_LISTING_UPLOAD_WORKER_TASK_INVALID");
      }
      const correlationId = `${task.taskId}:${task.attemptCount}`;
      const lease = { accountId, taskId: task.taskId, leaseToken: task.leaseToken, correlationId };
      const runnable = (task.itemStatus === "UPLOAD_QUEUED"
        && task.itemStatusVersion === task.expectedStatusVersion)
        || (task.itemStatus === "UPLOADING"
          && task.itemStatusVersion === task.expectedStatusVersion + 1);
      if (!runnable) {
        await repository.completeLease({ ...lease,
          evidence: { outcome: "STALE", code: "AUTO_LISTING_UPLOAD_TASK_STALE" },
        });
        return true;
      }
      if (task.attemptCount > maxAttempts) {
        await repository.deadLetterLease({ ...lease,
          errorCode: "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED",
          evidence: { outcome: "BLOCKED", code: "AUTO_LISTING_UPLOAD_ATTEMPT_LIMIT_REACHED" },
        });
        return true;
      }
      try {
        const result = await uploadService.submitAutoListingItem({ actor: task.actor,
          itemId: task.itemId, expectedStatusVersion: task.expectedStatusVersion, correlationId });
        await repository.completeLease({ ...lease, evidence: resultEvidence(result) });
      } catch (error) {
        const code = ownCode(error);
        log(task, code);
        if (code === "AUTO_LISTING_UPLOAD_RETRYABLE") {
          await repository.completeLease({ ...lease, evidence: { outcome: "HANDED_OFF", code } });
        } else if (STALE_CODES.has(code)) {
          await repository.completeLease({ ...lease,
            evidence: { outcome: code === "AUTO_LISTING_UPLOAD_BLOCKED" ? "BLOCKED" : "STALE", code },
          });
        } else if (code === "AUTO_LISTING_UPLOAD_UNCERTAIN" || !retryable(error)) {
          await repository.deadLetterLease({ ...lease, errorCode: code,
            evidence: { outcome: "BLOCKED", code } });
        } else {
          await repository.rescheduleLease({ ...lease,
            delayMs: delay(task.attemptCount, baseDelayMs, maxDelayMs), errorCode: code,
            evidence: { outcome: "STALE", code },
          });
        }
      }
      return true;
    }
    if (accountIds.length < accountScanLimit) cursor = null;
    return false;
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = processOne().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(waitMs) {
    if (!running) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      try { await runOnce(); } catch (error) { log(null, ownCode(error)); }
      schedule(pollIntervalMs);
    }, waitMs);
  }

  return Object.freeze({
    async start() { if (running) return true; running = true; schedule(0); return true; },
    runOnce,
    async stop() {
      running = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight.catch(() => {});
    },
  });
}
