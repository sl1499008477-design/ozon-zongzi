import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  AUTO_LISTING_AI_QUEUE,
  AUTO_LISTING_AI_QUEUE_OPTIONS,
  AUTO_LISTING_AI_WORK_QUEUE,
  AUTO_LISTING_AI_WORK_QUEUE_OPTIONS,
} from "./auto-listing-ai-queue.mjs";
import {
  AUTO_LISTING_AI_PHASES,
  isSafeAutoListingAiIdentifier,
  normalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import {
  normalizeAutoListingAiWorkMessage,
} from "./auto-listing-ai-work-message.mjs";
const FACTORY_KEYS = new Set([
  "enabled", "bossFactory", "executionRepository", "loadContext", "orchestrate", "workflow", "logger", "phasePolicies", "timers",
]);
const WORKFLOW_KEYS = new Set(["applyOutcome"]);
const EXECUTION_REPOSITORY_KEYS = new Set(["adopt", "renew", "requeueChannelFailure"]);
const POLICY_KEYS = new Set(["concurrency", "retryLimit", "retryDelayMs"]);
const CONTEXT_KEYS = new Set([
  "accountId", "jobId", "itemId", "status", "statusVersion", "activeContentPlanId", "phaseInput",
]);
const ORCHESTRATOR_OUTCOME_KEYS = new Set([
  "contractVersion", "disposition", "phase", "outcome", "retryable", "failureCode", "correlationId",
  "failureScope", "deliveryState", "retryAfterMs",
]);
const OUTCOME_DISPOSITIONS = new Set(["ACK", "RETRY", "FAIL"]);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SENSITIVE_CODE_FRAGMENT = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTHORIZATION|BEARER|COOKIE|SESSION_?ID|PRIVATE_?KEY)/u;
const MAX_CONCURRENCY = 16;
const MAX_RETRY_LIMIT = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const STOP_TIMEOUT_MS = 300_000;
const EXECUTION_LEASE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = Math.floor(EXECUTION_LEASE_MS / 3);
const RETRY_AFTER_EXTERNAL_ACTION = new Set(["AI_GATEWAY_RATE_LIMITED"]);
const FAILURE_SCOPES = new Set([null, "BUSINESS", "CHANNEL_TRANSIENT", "CHANNEL_REVALIDATION"]);
const DELIVERY_STATES = new Set([null, "NOT_SENT", "POSSIBLY_SENT"]);

export const AUTO_LISTING_AI_PHASE_POLICIES = Object.freeze({
  PLAN_CONTENT: Object.freeze({ concurrency: 2, retryLimit: 2, retryDelayMs: 1_000 }),
  MATERIALIZE_SOURCE_ASSET: Object.freeze({ concurrency: 4, retryLimit: 2, retryDelayMs: 500 }),
  FINALIZE_MATERIALIZED_PLAN: Object.freeze({ concurrency: 2, retryLimit: 2, retryDelayMs: 500 }),
  GENERATE_IMAGE_SLOT: Object.freeze({ concurrency: 1, retryLimit: 0, retryDelayMs: 2_000 }),
  GENERATE_RICH_CONTENT: Object.freeze({
    concurrency: 2,
    retryLimit: 2,
    retryDelayMs: 1_000,
  }),
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
    failureScope: "BUSINESS",
    deliveryState: null,
    retryAfterMs: null,
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
      || !Number.isInteger(policy.retryLimit) || policy.retryLimit < 0 || policy.retryLimit > MAX_RETRY_LIMIT
      || !Number.isInteger(policy.retryDelayMs) || policy.retryDelayMs < 1
      || policy.retryDelayMs > MAX_RETRY_DELAY_MS) {
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
    || !FAILURE_SCOPES.has(value.failureScope) || !DELIVERY_STATES.has(value.deliveryState)
    || !(value.retryAfterMs === null || (Number.isInteger(value.retryAfterMs)
      && value.retryAfterMs >= 0 && value.retryAfterMs <= 86_400_000))
    || (value.disposition === "ACK" && (value.failureScope !== null
      || value.deliveryState !== null || value.retryAfterMs !== null))
    || (value.failureScope === "BUSINESS" && (value.deliveryState !== null || value.retryAfterMs !== null))
    || (typeof value.failureScope === "string" && value.failureScope.startsWith("CHANNEL_")
      && value.deliveryState === null)
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
    failureScope: outcome.failureScope,
    deliveryState: outcome.deliveryState,
    retryAfterMs: outcome.retryAfterMs,
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

function validExecutionRepository(value) {
  if (!exactKeys(value, EXECUTION_REPOSITORY_KEYS)) return false;
  try {
    return [...EXECUTION_REPOSITORY_KEYS].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
        && typeof descriptor.value === "function";
    });
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
  const executionRepository = config.executionRepository;
  const loadContext = config.loadContext;
  const orchestrate = config.orchestrate;
  const workflow = config.workflow;
  const logger = config.logger || { log(record) { console.log(JSON.stringify(record)); } };
  const timers = config.timers || { setTimeout, clearTimeout };
  const policies = normalizePolicies(config.phasePolicies || AUTO_LISTING_AI_PHASE_POLICIES);
  if (typeof bossFactory !== "function" || typeof loadContext !== "function" || typeof orchestrate !== "function"
    || !validWorkflow(workflow) || !validExecutionRepository(executionRepository)
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

  async function executePhaseAttempt(message, finalAttempt, execution = null) {
    const loaded = await loadContext(message);
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
    const outcome = await orchestrate({ message, context });
    let normalized = normalizeOrchestratorOutcome(outcome, message);
    if (execution && typeof normalized.failureScope === "string"
      && normalized.failureScope.startsWith("CHANNEL_")) {
      return Object.freeze({ persist: true, outcome: normalized });
    }
    if (normalized.disposition === "RETRY" && !finalAttempt
      && !RETRY_AFTER_EXTERNAL_ACTION.has(normalized.failureCode)) {
      return Object.freeze({ persist: false, outcome: normalized });
    }
    if (normalized.disposition === "RETRY") normalized = terminalizeRetryOutcome(normalized);
    return Object.freeze({ persist: true, outcome: normalized });
  }

  async function persistOutcome(message, outcome, execution) {
    if (execution && typeof outcome.failureScope === "string" && outcome.failureScope.startsWith("CHANNEL_")) {
      return executionRepository.requeueChannelFailure({ message, outcome, execution });
    }
    return workflow.applyOutcome({ message, outcome, execution });
  }

  async function runMessage(job, message, execution = null, leaseLost = () => false) {
    const policy = policies[message.phase];
    try {
      const outcome = await limiters[message.phase](async () => {
        let attempt = 0;
        let terminal = null;
        while (attempt <= policy.retryLimit) {
          attempt += 1;
          try {
            const result = await executePhaseAttempt(message, attempt > policy.retryLimit, execution);
            if (result.outcome.disposition !== "RETRY"
              || (execution && typeof result.outcome.failureScope === "string"
                && result.outcome.failureScope.startsWith("CHANNEL_"))) {
              terminal = result;
              break;
            }
            log(message, result.outcome.failureCode);
            await waitBeforeRetry(policy, attempt, timers);
          } catch (error) {
            const errorCode = safeErrorCode(error);
            const retryable = safeErrorRetryable(error);
            if (!retryable || attempt > policy.retryLimit) {
              terminal = Object.freeze({ persist: true, outcome: failureOutcome(message, error) });
              break;
            }
            log(message, errorCode);
            await waitBeforeRetry(policy, attempt, timers);
          }
        }
        if (!terminal) throw workerError("AUTO_LISTING_AI_PHASE_FAILED");
        if (execution && leaseLost()) {
          return Object.freeze({ disposition: "ACK", code: "AUTO_LISTING_AI_MESSAGE_STALE" });
        }
        if (terminal.persist) await persistOutcome(message, terminal.outcome, execution);
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

  async function processLegacyJob(job) {
    let message;
    try { message = normalizeAutoListingAiMessage(job?.data); } catch {
      const output = Object.freeze({ disposition: "FAILED", code: "AUTO_LISTING_AI_MESSAGE_INVALID" });
      log(null, output.code);
      return { id: safeJobId(job), status: "failed", output };
    }
    return runMessage(job, message);
  }

  function adoptedExecution(message, value) {
    try {
      return normalizeAutoListingAiWorkMessage({
        workContractVersion: "CHANNEL_WORK_V1",
        message,
        execution: value,
      }).execution;
    } catch {
      return null;
    }
  }

  function startHeartbeat(message, execution) {
    let active = true;
    let lost = false;
    let handle = null;
    let running = null;
    const beat = () => {
      if (!active) return;
      running = Promise.resolve(executionRepository.renew({
        message,
        execution,
        leaseMs: EXECUTION_LEASE_MS,
      })).then(() => {
        if (active) handle = timers.setTimeout(beat, HEARTBEAT_INTERVAL_MS);
      }, () => {
        lost = true;
        active = false;
      }).finally(() => { running = null; });
    };
    handle = timers.setTimeout(beat, HEARTBEAT_INTERVAL_MS);
    return Object.freeze({
      lost: () => lost,
      async stop() {
        active = false;
        if (handle !== null) timers.clearTimeout(handle);
        if (running) await running;
      },
    });
  }

  async function processWorkJob(job) {
    let work;
    try { work = normalizeAutoListingAiWorkMessage(job?.data); } catch {
      const output = Object.freeze({ disposition: "FAILED", code: "AUTO_LISTING_AI_MESSAGE_INVALID" });
      log(null, output.code);
      return { id: safeJobId(job), status: "failed", output };
    }
    let execution;
    try {
      execution = adoptedExecution(work.message, await executionRepository.adopt({
        message: work.message,
        execution: work.execution,
        workerId: "auto-listing-ai-worker-v3",
        leaseToken: crypto.randomUUID(),
        leaseMs: EXECUTION_LEASE_MS,
      }));
    } catch {
      execution = null;
    }
    if (!execution) {
      const output = Object.freeze({ disposition: "ACK", code: "AUTO_LISTING_AI_MESSAGE_STALE" });
      log(work.message, output.code);
      return { id: safeJobId(job), status: "completed", output };
    }
    const heartbeat = startHeartbeat(work.message, execution);
    try {
      return await runMessage(job, work.message, execution, heartbeat.lost);
    } finally {
      await heartbeat.stop();
    }
  }

  async function handler(jobs, processJob) {
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
          await candidate.createQueue(AUTO_LISTING_AI_WORK_QUEUE, AUTO_LISTING_AI_WORK_QUEUE_OPTIONS);
          await candidate.work(AUTO_LISTING_AI_QUEUE, {
            batchSize: 1,
            localConcurrency: Object.values(policies).reduce((sum, policy) => sum + policy.concurrency, 0),
            pollingIntervalSeconds: 1,
            heartbeatRefreshSeconds: 10,
            perJobResults: true,
          }, (jobs) => handler(jobs, processLegacyJob));
          await candidate.work(AUTO_LISTING_AI_WORK_QUEUE, {
            batchSize: 1,
            localConcurrency: Object.values(policies).reduce((sum, policy) => sum + policy.concurrency, 0),
            pollingIntervalSeconds: 1,
            heartbeatRefreshSeconds: 10,
            perJobResults: true,
          }, (jobs) => handler(jobs, processWorkJob));
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
