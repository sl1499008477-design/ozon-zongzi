import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  AUTO_LISTING_AI_QUEUE,
  AUTO_LISTING_AI_QUEUE_OPTIONS,
} from "./auto-listing-ai-queue.mjs";
import {
  AUTO_LISTING_AI_PHASES,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";

const FACTORY_KEYS = new Set([
  "enabled", "bossFactory", "loadContext", "orchestrate", "workflow", "logger", "phasePolicies", "timers",
]);
const WORKFLOW_KEYS = new Set(["applyOutcome"]);
const POLICY_KEYS = new Set(["concurrency", "timeoutMs", "retryLimit", "retryDelayMs"]);
const CONTEXT_KEYS = new Set([
  "accountId", "jobId", "itemId", "status", "statusVersion", "activeContentPlanId", "phaseInput",
]);
const ORCHESTRATOR_OUTCOME_KEYS = new Set([
  "contractVersion", "disposition", "phase", "outcome", "retryable", "failureCode", "correlationId",
]);
const OUTCOME_DISPOSITIONS = new Set(["ACK", "RETRY", "FAIL"]);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SENSITIVE_CODE_FRAGMENT = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTHORIZATION|BEARER|COOKIE|SESSION_?ID|PRIVATE_?KEY)/u;
const MAX_CONCURRENCY = 16;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RETRY_LIMIT = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const QUEUE_EXECUTION_MARGIN_MS = Math.max(
  60_000,
  AUTO_LISTING_AI_QUEUE_OPTIONS.heartbeatSeconds * 2 * 1_000,
);
const MAX_PHASE_BUDGET_MS = (AUTO_LISTING_AI_QUEUE_OPTIONS.expireInSeconds * 1_000)
  - QUEUE_EXECUTION_MARGIN_MS;
const PERSISTENCE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 300_000;

export const AUTO_LISTING_AI_PHASE_POLICIES = Object.freeze({
  PLAN_CONTENT: Object.freeze({ concurrency: 2, timeoutMs: 120_000, retryLimit: 2, retryDelayMs: 1_000 }),
  MATERIALIZE_SOURCE_ASSET: Object.freeze({ concurrency: 4, timeoutMs: 60_000, retryLimit: 2, retryDelayMs: 500 }),
  FINALIZE_MATERIALIZED_PLAN: Object.freeze({ concurrency: 2, timeoutMs: 30_000, retryLimit: 2, retryDelayMs: 500 }),
  GENERATE_IMAGE_SLOT: Object.freeze({ concurrency: 4, timeoutMs: 180_000, retryLimit: 2, retryDelayMs: 2_000 }),
  GENERATE_RICH_CONTENT: Object.freeze({ concurrency: 2, timeoutMs: 120_000, retryLimit: 2, retryDelayMs: 1_000 }),
});

function failureOutcome(message, error) {
  const failureCode = safeErrorCode(error);
  return Object.freeze({
    contractVersion: "V1",
    disposition: "FAIL",
    phase: message.phase,
    outcome: "FAILED",
    retryable: safeErrorRetryable(error),
    failureCode,
    correlationId: message.correlationId,
  });
}

function workerError(code, retryable = false) {
  const error = new Error("自动上架 AI Worker 操作失败");
  error.code = code;
  error.retryable = retryable;
  return error;
}

function plainObject(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch {
    return false;
  }
}

function exactKeys(value, keys) {
  try {
    const actual = Reflect.ownKeys(value);
    return plainObject(value) && actual.length === keys.size
      && actual.every((key) => typeof key === "string" && keys.has(key));
  } catch {
    return false;
  }
}

function safeCode(value, fallback = "AUTO_LISTING_AI_PHASE_FAILED") {
  return typeof value === "string" && ERROR_CODE.test(value) && !SENSITIVE_CODE_FRAGMENT.test(value)
    ? value : fallback;
}

function safeErrorField(error, name) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, name);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorCode(error, fallback = "AUTO_LISTING_AI_PHASE_FAILED") {
  return safeCode(safeErrorField(error, "code"), fallback);
}

function safeErrorRetryable(error) {
  return safeErrorField(error, "retryable") === true;
}

function safeJobId(job) {
  try {
    if (!job || typeof job !== "object") return "unknown";
    const descriptor = Object.getOwnPropertyDescriptor(job, "id");
    const value = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    return (typeof value === "string" || typeof value === "number") && String(value).length <= 240
      ? String(value) : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizePolicies(value) {
  if (!plainObject(value) || Object.keys(value).length !== AUTO_LISTING_AI_PHASES.length
    || AUTO_LISTING_AI_PHASES.some((phase) => !Object.hasOwn(value, phase))) {
    throw workerError("AUTO_LISTING_AI_WORKER_INVALID");
  }
  const result = {};
  for (const phase of AUTO_LISTING_AI_PHASES) {
    const policy = value[phase];
    if (!exactKeys(policy, POLICY_KEYS)
      || !Number.isInteger(policy.concurrency) || policy.concurrency < 1 || policy.concurrency > MAX_CONCURRENCY
      || !Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1 || policy.timeoutMs > MAX_TIMEOUT_MS
      || !Number.isInteger(policy.retryLimit) || policy.retryLimit < 0 || policy.retryLimit > MAX_RETRY_LIMIT
      || !Number.isInteger(policy.retryDelayMs) || policy.retryDelayMs < 1
      || policy.retryDelayMs > MAX_RETRY_DELAY_MS
      || (policy.timeoutMs * (policy.retryLimit + 1))
        + (policy.retryDelayMs * ((2 ** policy.retryLimit) - 1)) >= MAX_PHASE_BUDGET_MS) {
      throw workerError("AUTO_LISTING_AI_WORKER_INVALID");
    }
    result[phase] = Object.freeze({ ...policy });
  }
  return Object.freeze(result);
}

function normalizeContext(value, message) {
  if (value === null || value === undefined) return null;
  if (!exactKeys(value, CONTEXT_KEYS)
    || value.accountId !== message.accountId || value.itemId !== message.itemId
    || !isSafeAutoListingAiIdentifier(value.jobId)
    || typeof value.status !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.status)
    || !Number.isInteger(value.statusVersion) || value.statusVersion < 1 || value.statusVersion > 2_147_483_647
    || !(value.activeContentPlanId === null || isSafeAutoListingAiIdentifier(value.activeContentPlanId))) {
    throw workerError("AUTO_LISTING_AI_CONTEXT_INVALID");
  }
  return value;
}

function assertCurrentPhaseInput(context) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(context, "phaseInput"); } catch {}
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true
    || !plainObject(descriptor.value)) throw workerError("AUTO_LISTING_AI_CONTEXT_INVALID");
}

function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  function release() {
    active -= 1;
    waiting.shift()?.();
  }
  return async function run(operation) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try { return await operation(); } finally { release(); }
  };
}

function withTimeout(operationFactory, timeoutMs, timers, timeoutCode = "AUTO_LISTING_AI_PHASE_TIMEOUT") {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timeout = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      reject(workerError(timeoutCode, true));
    }, timeoutMs);
    Promise.resolve().then(() => operationFactory(() => timedOut)).then((value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitBeforeRetry(policy, attempt, timers) {
  const delayMs = Math.min(MAX_RETRY_DELAY_MS, policy.retryDelayMs * (2 ** (attempt - 1)));
  return new Promise((resolve) => timers.setTimeout(resolve, delayMs));
}

function normalizeOrchestratorOutcome(value, message) {
  if (!exactKeys(value, ORCHESTRATOR_OUTCOME_KEYS) || value.contractVersion !== "V1"
    || !OUTCOME_DISPOSITIONS.has(value.disposition) || value.phase !== message.phase
    || value.correlationId !== message.correlationId || !ERROR_CODE.test(value.outcome || "")
    || typeof value.retryable !== "boolean"
    || !(value.failureCode === null || ERROR_CODE.test(value.failureCode || ""))
    || (value.disposition === "ACK" && value.retryable)
    || (value.disposition === "RETRY" && (!value.retryable || value.failureCode === null))
    || (value.disposition === "FAIL" && value.failureCode === null)) {
    throw workerError("AUTO_LISTING_AI_ORCHESTRATOR_OUTCOME_INVALID");
  }
  return value;
}

function terminalizeRetryOutcome(outcome) {
  return Object.freeze({
    contractVersion: outcome.contractVersion,
    disposition: "FAIL",
    phase: outcome.phase,
    outcome: "FAILED",
    retryable: true,
    failureCode: outcome.failureCode,
    correlationId: outcome.correlationId,
  });
}

function validWorkflow(value) {
  if (!exactKeys(value, WORKFLOW_KEYS)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "applyOutcome");
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
      && typeof descriptor.value === "function";
  } catch {
    return false;
  }
}

function safeOutcome(value) {
  const disposition = OUTCOME_DISPOSITIONS.has(value?.disposition) ? value.disposition : "FAIL";
  const code = Object.hasOwn(value || {}, "outcome")
    ? disposition === "ACK" ? value.outcome : value.failureCode
    : value?.code;
  return Object.freeze({
    disposition,
    code: safeCode(code, disposition === "ACK" ? "AUTO_LISTING_AI_PHASE_ACKNOWLEDGED" : "AUTO_LISTING_AI_PHASE_FAILED"),
  });
}

export function createAutoListingAiWorker(config = {}) {
  if (!exactKeys(config, new Set(Object.keys(config)))
    || Object.keys(config).some((key) => !FACTORY_KEYS.has(key))
    || typeof config.enabled !== "boolean") throw workerError("AUTO_LISTING_AI_WORKER_INVALID");
  if (!config.enabled) {
    return Object.freeze({ async start() { return false; }, async stop() {} });
  }
  const bossFactory = config.bossFactory;
  const loadContext = config.loadContext;
  const orchestrate = config.orchestrate;
  const workflow = config.workflow;
  const logger = config.logger || { log(record) { console.log(JSON.stringify(record)); } };
  const timers = config.timers || { setTimeout, clearTimeout };
  const policies = normalizePolicies(config.phasePolicies || AUTO_LISTING_AI_PHASE_POLICIES);
  if (typeof bossFactory !== "function" || typeof loadContext !== "function" || typeof orchestrate !== "function"
    || !validWorkflow(workflow)
    || typeof logger?.log !== "function" || typeof timers?.setTimeout !== "function"
    || typeof timers?.clearTimeout !== "function") throw workerError("AUTO_LISTING_AI_WORKER_INVALID");

  const limiters = Object.fromEntries(AUTO_LISTING_AI_PHASES.map((phase) => [
    phase, createLimiter(policies[phase].concurrency),
  ]));
  const inFlight = new Set();
  let boss = null;
  let startPromise = null;
  let stopping = false;

  function log(message, code) {
    try {
      logger.log(Object.freeze({
        correlationId: message?.correlationId || "unknown",
        phase: message?.phase || "UNKNOWN",
        code: safeCode(code, "AUTO_LISTING_AI_PHASE_FAILED"),
      }));
    } catch {}
  }

  async function executePhaseAttempt(message, policy, finalAttempt) {
    return withTimeout(async (timedOut) => {
      const loaded = await loadContext(message);
      if (timedOut()) throw workerError("AUTO_LISTING_AI_PHASE_TIMEOUT", true);
      const context = normalizeContext(loaded, message);
      if (!context || context.statusVersion !== message.expectedStatusVersion) {
        return Object.freeze({
          persist: false,
          outcome: Object.freeze({ disposition: "ACK", code: "AUTO_LISTING_AI_MESSAGE_STALE" }),
        });
      }
      if (context.status === "CANCELLED") {
        return Object.freeze({
          persist: false,
          outcome: Object.freeze({ disposition: "ACK", code: "AUTO_LISTING_AI_ITEM_CANCELLED" }),
        });
      }
      assertCurrentPhaseInput(context);
      if (timedOut()) throw workerError("AUTO_LISTING_AI_PHASE_TIMEOUT", true);
      const outcome = await orchestrate({ message, context });
      let normalized = normalizeOrchestratorOutcome(outcome, message);
      if (normalized.disposition === "RETRY" && !finalAttempt) {
        return Object.freeze({ persist: false, outcome: normalized });
      }
      if (normalized.disposition === "RETRY") normalized = terminalizeRetryOutcome(normalized);
      return Object.freeze({ persist: true, outcome: normalized });
    }, policy.timeoutMs, timers);
  }

  async function persistOutcome(message, outcome) {
    return withTimeout(
      () => workflow.applyOutcome(message, outcome),
      PERSISTENCE_TIMEOUT_MS,
      timers,
      "AUTO_LISTING_AI_PERSISTENCE_TIMEOUT",
    );
  }

  async function processJob(job) {
    let message;
    try { message = normalizeAutoListingAiMessage(job?.data); } catch {
      const output = Object.freeze({ disposition: "FAILED", code: "AUTO_LISTING_AI_MESSAGE_INVALID" });
      log(null, output.code);
      return { id: safeJobId(job), status: "failed", output };
    }
    const policy = policies[message.phase];
    try {
      const outcome = await limiters[message.phase](async () => {
        let attempt = 0;
        let terminal = null;
        while (attempt <= policy.retryLimit) {
          attempt += 1;
          try {
            const result = await executePhaseAttempt(message, policy, attempt > policy.retryLimit);
            if (result.outcome.disposition !== "RETRY") {
              terminal = result;
              break;
            }
            log(message, result.outcome.failureCode);
            await waitBeforeRetry(policy, attempt, timers);
          } catch (error) {
            // A timed-out operation may still be completing externally. Do not overlap it
            // with another attempt; fence the item through the durable workflow instead.
            const errorCode = safeErrorCode(error);
            const retryable = safeErrorRetryable(error) && errorCode !== "AUTO_LISTING_AI_PHASE_TIMEOUT";
            if (!retryable || attempt > policy.retryLimit) {
              terminal = Object.freeze({ persist: true, outcome: failureOutcome(message, error) });
              break;
            }
            log(message, errorCode);
            await waitBeforeRetry(policy, attempt, timers);
          }
        }
        if (!terminal) throw workerError("AUTO_LISTING_AI_PHASE_FAILED");
        if (terminal.persist) await persistOutcome(message, terminal.outcome);
        return terminal.outcome;
      });
      const output = safeOutcome(outcome);
      log(message, output.code);
      return { id: safeJobId(job), status: "completed", output };
    } catch (error) {
      const output = Object.freeze({ disposition: "FAILED", code: safeErrorCode(error) });
      log(message, output.code);
      return { id: safeJobId(job), status: "failed", output };
    }
  }

  async function handler(jobs) {
    if (!Array.isArray(jobs)) throw workerError("AUTO_LISTING_AI_WORKER_INVALID");
    const tasks = jobs.map((job) => {
      const task = processJob(job);
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
      return task;
    });
    return Promise.all(tasks);
  }

  async function start() {
    if (stopping) throw workerError("AUTO_LISTING_AI_WORKER_STOPPED");
    if (!startPromise) {
      startPromise = (async () => {
        let candidate = null;
        try {
          candidate = await bossFactory();
          if (!candidate || typeof candidate.start !== "function" || typeof candidate.createQueue !== "function"
            || typeof candidate.work !== "function" || typeof candidate.stop !== "function") throw new Error("invalid boss");
          candidate.on?.("error", () => log(null, "AUTO_LISTING_AI_QUEUE_UNAVAILABLE"));
          candidate.on?.("warning", () => log(null, "AUTO_LISTING_AI_QUEUE_WARNING"));
          await candidate.start();
          await candidate.createQueue(AUTO_LISTING_AI_QUEUE, AUTO_LISTING_AI_QUEUE_OPTIONS);
          await candidate.work(AUTO_LISTING_AI_QUEUE, {
            batchSize: 1,
            localConcurrency: Object.values(policies).reduce((sum, policy) => sum + policy.concurrency, 0),
            pollingIntervalSeconds: 1,
            heartbeatRefreshSeconds: 10,
            perJobResults: true,
          }, handler);
          boss = candidate;
          log(null, "AUTO_LISTING_AI_WORKER_STARTED");
          return true;
        } catch {
          try { await candidate?.stop?.({ graceful: true, timeout: STOP_TIMEOUT_MS }); } catch {}
          boss = null;
          startPromise = null;
          throw workerError("AUTO_LISTING_AI_WORKER_START_FAILED", true);
        }
      })();
    }
    return startPromise;
  }

  async function stop() {
    stopping = true;
    let stopFailure = null;
    if (startPromise) {
      try { await startPromise; } catch {}
      if (boss) {
        const current = boss;
        boss = null;
        try { await current.stop({ graceful: true, timeout: STOP_TIMEOUT_MS }); } catch {
          stopFailure = workerError("AUTO_LISTING_AI_WORKER_STOP_FAILED", true);
        }
      }
    }
    await Promise.allSettled([...inFlight]);
    log(null, "AUTO_LISTING_AI_WORKER_STOPPED");
    if (stopFailure) throw stopFailure;
  }

  return Object.freeze({ start, stop });
}

async function runDirect() {
  const { createAutoListingRuntime } = await import("./auto-listing-runtime.mjs");
  const { closePostgresPool } = await import("./db/connection.mjs");
  const runtime = createAutoListingRuntime();
  let started;
  try { started = await runtime.startAiWorker(); } catch (error) {
    try { await closePostgresPool(); } catch {}
    throw error;
  }
  if (!started) return;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.stopAiWorker();
      await closePostgresPool();
      process.exitCode = 0;
    } catch {
      try { await closePostgresPool(); } catch {}
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) runDirect().catch((error) => {
  console.error(JSON.stringify({
    correlationId: "startup", phase: "STARTUP", code: safeErrorCode(error, "AUTO_LISTING_AI_WORKER_START_FAILED"),
  }));
  process.exitCode = 1;
});
