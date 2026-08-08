const UNRESOLVED_LINKS = new Set(["SUBMITTED", "RECONCILING"]);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;

function workerError(code) {
  const error = new Error("自动上架结果核对任务暂时不可用");
  error.code = code;
  error.retryable = false;
  return error;
}

function ownCode(error, fallback = "AUTO_LISTING_RECONCILE_WORKER_FAILED") {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const value = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
  } catch { return fallback; }
}

function isRetryable(error) {
  try {
    const descriptor = error && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "retryable") : null;
    return descriptor && Object.hasOwn(descriptor, "value") && descriptor.value === true;
  } catch { return false; }
}

function positiveInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function delayFor(attemptCount, baseDelayMs, maxDelayMs) {
  const exponent = Math.max(0, Math.min(30, attemptCount - 1));
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

function safeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.status !== "string" || typeof value.linkStatus !== "string"
    || !SAFE_CODE.test(value.status) || !SAFE_CODE.test(value.linkStatus)) {
    throw workerError("AUTO_LISTING_RECONCILE_RESULT_INVALID");
  }
  return Object.freeze({ itemStatus: value.status, linkStatus: value.linkStatus });
}

export function createAutoListingSubmissionReconciliationWorker(config = {}) {
  let enabledDescriptor;
  try {
    enabledDescriptor = config && typeof config === "object"
      ? Object.getOwnPropertyDescriptor(config, "enabled") : null;
  } catch { throw workerError("AUTO_LISTING_RECONCILE_WORKER_INVALID"); }
  if (!enabledDescriptor || !Object.hasOwn(enabledDescriptor, "value")
    || typeof enabledDescriptor.value !== "boolean") throw workerError("AUTO_LISTING_RECONCILE_WORKER_INVALID");
  if (!enabledDescriptor.value) {
    return Object.freeze({ async start() { return false; }, async runOnce() { return false; }, async stop() {} });
  }

  let values;
  try {
    const allowed = new Set(["enabled", "repository", "reconciler", "workerId", "pollIntervalMs",
      "leaseMs", "baseDelayMs", "maxDelayMs", "maxAttempts", "logger", "timers"]);
    const keys = Reflect.ownKeys(config);
    const descriptors = Object.getOwnPropertyDescriptors(config);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw workerError("AUTO_LISTING_RECONCILE_WORKER_INVALID");
    }
    values = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (ownCode(error) === "AUTO_LISTING_RECONCILE_WORKER_INVALID") throw error;
    throw workerError("AUTO_LISTING_RECONCILE_WORKER_INVALID");
  }
  const { repository, reconciler, workerId, pollIntervalMs, leaseMs, baseDelayMs, maxDelayMs,
    maxAttempts, logger, timers } = values;
  if (!["leaseNext", "completeLease", "rescheduleLease", "deadLetterLease"]
    .every((key) => typeof repository?.[key] === "function")
    || typeof reconciler?.reconcile !== "function"
    || typeof workerId !== "string" || !workerId.trim() || workerId.length > 240
    || !positiveInteger(pollIntervalMs, 100, 300_000)
    || !positiveInteger(leaseMs, 1_000, 900_000)
    || !positiveInteger(baseDelayMs, 100, 86_400_000)
    || !positiveInteger(maxDelayMs, baseDelayMs, 86_400_000)
    || !positiveInteger(maxAttempts, 1, 999)
    || typeof logger?.log !== "function"
    || typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function") {
    throw workerError("AUTO_LISTING_RECONCILE_WORKER_INVALID");
  }

  let running = false;
  let timer = null;
  let inFlight = null;

  function log(task, code) {
    try {
      logger.log(Object.freeze({
        component: "AUTO_LISTING_SUBMISSION_RECONCILIATION",
        taskId: typeof task?.taskId === "string" ? task.taskId : "unknown",
        correlationId: typeof task?.taskId === "string" && Number.isInteger(task?.attemptCount)
          ? `${task.taskId}:${task.attemptCount}` : "unknown",
        code: ownCode({ code }, "AUTO_LISTING_RECONCILE_WORKER_FAILED"),
      }));
    } catch {}
  }

  async function processOne() {
    const task = await repository.leaseNext({ workerId: workerId.trim(), leaseMs });
    if (!task) return false;
    const correlationId = `${task.taskId}:${task.attemptCount}`;
    const lease = {
      accountId: task.accountId, taskId: task.taskId, leaseToken: task.leaseToken, correlationId,
    };
    if (task.attemptCount > maxAttempts) {
      await repository.deadLetterLease({ ...lease,
        errorCode: "AUTO_LISTING_RECONCILE_ATTEMPT_LIMIT_REACHED", evidence: {},
      });
      return true;
    }
    try {
      const result = safeResult(await reconciler.reconcile({
        accountId: task.accountId,
        itemId: task.itemId,
        submissionLinkId: task.submissionLinkId,
        correlationId,
      }));
      if (UNRESOLVED_LINKS.has(result.linkStatus)) {
        await repository.rescheduleLease({ ...lease,
          delayMs: delayFor(task.attemptCount, baseDelayMs, maxDelayMs),
          errorCode: null,
          evidence: result,
        });
      } else {
        await repository.completeLease({ ...lease, evidence: result });
      }
    } catch (error) {
      const code = ownCode(error);
      log(task, code);
      if (isRetryable(error)) {
        await repository.rescheduleLease({ ...lease,
          delayMs: delayFor(task.attemptCount, baseDelayMs, maxDelayMs), errorCode: code, evidence: {},
        });
      } else {
        await repository.deadLetterLease({ ...lease, errorCode: code, evidence: {} });
      }
    }
    return true;
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = processOne().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(delay) {
    if (!running) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      try { await runOnce(); } catch (error) { log(null, ownCode(error)); }
      schedule(pollIntervalMs);
    }, delay);
  }

  return Object.freeze({
    async start() {
      if (running) return true;
      running = true;
      schedule(0);
      return true;
    },
    runOnce,
    async stop() {
      running = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight.catch(() => {});
    },
  });
}
