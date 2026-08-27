import { types } from "node:util";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import { diagnoseContentPlan } from "./auto-listing-content-planner.mjs";
import { mergeContentPlanFill } from "./auto-listing-fixed-skeleton.mjs";

const REQUEST_KEYS = new Set(["actor", "jobId", "itemId"]);
const REPLAY_KEYS = new Set([
  "actor", "jobId", "itemId", "sourceSnapshotId", "expectedStatusVersion",
  "costConfirmed", "idempotencyKey", "correlationId",
]);
const ACTOR_KEYS = new Set(["id", "role"]);
const DETAIL_KEYS = new Set([
  "responseId", "attemptId", "diagnosticRunId", "planningContract", "model",
  "promptTemplateVersion", "gatewayRequestId", "receivedAt", "response", "validation",
]);
const VALIDATION_KEYS = new Set(["status", "validatorVersion", "issues", "validatedAt"]);
const ISSUE_KEYS = new Set(["code", "slotKey", "claimIndex", "field", "expected", "actual"]);
const LEGACY_RESPONSE_KEYS = new Set(["version", "language", "slots"]);
const FIXED_RESPONSE_KEYS = new Set(["version", "language", "fills"]);
const CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,239}$/u;
const SECRET_VALUE = /^(?:sk-(?:proj-)?[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|Bearer\s+\S+)$/iu;
const FORBIDDEN_KEYS = /^(?:api[_-]?key|gateway[_-]?key|prompt|systemPrompt|cause|rawError|authorization|cookie|credential|password|secret|accessToken|refreshToken)$/iu;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_STRING = 2_000_000;

class UnsafeData extends Error {}

function diagnosticError(code, status) {
  const messages = {
    AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID: "规划诊断请求无效",
    AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND: "未找到该商品的规划诊断",
    AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED: "规划诊断暂时无法读取",
    AUTO_LISTING_PLAN_DIAGNOSTIC_IN_PROGRESS: "规划诊断正在进行",
    AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_ELIGIBLE: "该任务当前不能执行规划诊断",
    AUTO_LISTING_PLAN_DIAGNOSTIC_IDEMPOTENCY_CONFLICT: "规划诊断请求与原请求不一致",
    AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN: "文字诊断结果不确定，请使用新的确认请求",
  };
  const error = new Error(messages[code] || messages.AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED);
  error.code = code;
  error.status = status;
  error.retryable = status >= 500;
  return error;
}

const invalid = () => diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_INVALID", 400);
const notFound = () => diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND", 404);
const failed = () => diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED", 500);

function cloneData(value, state, depth = 0) {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) throw new UnsafeData();
  state.nodes += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeData();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING || SECRET_VALUE.test(value)) throw new UnsafeData();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.active.has(value)) throw new UnsafeData();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 20_000) throw new UnsafeData();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))
        || descriptors.length?.value !== value.length) throw new UnsafeData();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new UnsafeData();
        return cloneData(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new UnsafeData();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 10_000 || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || FORBIDDEN_KEYS.test(key))) throw new UnsafeData();
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new UnsafeData();
      output[key] = cloneData(descriptor.value, state, depth + 1);
    }
    return output;
  } catch (error) {
    if (error instanceof UnsafeData) throw error;
    throw new UnsafeData();
  } finally {
    state.active.delete(value);
  }
}

function project(value) {
  return cloneData(value, { nodes: 0, active: new Set() });
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function safeText(value, max = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    && !SECRET_VALUE.test(value);
}

function canonicalTime(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function projectRequest(raw) {
  let input;
  try { input = project(raw); } catch { throw invalid(); }
  if (!exact(input, REQUEST_KEYS) || !exact(input.actor, ACTOR_KEYS)
    || !safeId(input.actor.id) || !["admin", "user"].includes(input.actor.role)
    || !safeId(input.jobId) || !safeId(input.itemId)) throw invalid();
  return input;
}

function projectReplayRequest(raw) {
  let input;
  try { input = project(raw); } catch { throw invalid(); }
  if (!exact(input, REPLAY_KEYS) || !exact(input.actor, ACTOR_KEYS)
    || !safeId(input.actor.id) || !["admin", "user"].includes(input.actor.role)
    || ![input.jobId, input.itemId, input.sourceSnapshotId, input.idempotencyKey, input.correlationId].every(safeId)
    || !Number.isSafeInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1
    || input.expectedStatusVersion > 2_147_483_647 || input.costConfirmed !== true) throw invalid();
  return input;
}

function projectIssue(issue) {
  if (!exact(issue, ISSUE_KEYS) || !CODE.test(issue.code || "")
    || !(issue.slotKey === null || safeText(issue.slotKey, 500))
    || !(issue.claimIndex === null || (Number.isSafeInteger(issue.claimIndex) && issue.claimIndex >= 0))
    || !(issue.field === null || safeText(issue.field, 240))
    || ![issue.expected, issue.actual].every((value) => value === null || safeText(value, 160))) throw new UnsafeData();
}

function projectDetail(raw) {
  let value;
  try { value = project(raw); } catch { throw failed(); }
  try {
    if (!exact(value, DETAIL_KEYS) || !safeId(value.responseId)
      || !((safeId(value.attemptId) && value.diagnosticRunId === null)
        || (value.attemptId === null && safeId(value.diagnosticRunId)))
      || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(value.planningContract)
      || !safeText(value.model) || !safeText(value.promptTemplateVersion)
      || !(value.gatewayRequestId === null || safeText(value.gatewayRequestId))
      || !canonicalTime(value.receivedAt)
      || !exact(value.validation, VALIDATION_KEYS)
      || !["ACCEPTED", "REJECTED"].includes(value.validation.status)
      || !safeText(value.validation.validatorVersion)
      || !Array.isArray(value.validation.issues) || value.validation.issues.length > 100
      || !canonicalTime(value.validation.validatedAt)) throw new UnsafeData();
    const rootKeys = value.planningContract === "FIXED_SKELETON_V1" ? FIXED_RESPONSE_KEYS : LEGACY_RESPONSE_KEYS;
    if (!exact(value.response, rootKeys) || value.response.version !== 1 || value.response.language !== "ru"
      || (value.planningContract === "FIXED_SKELETON_V1" ? !value.response.fills || Array.isArray(value.response.fills)
        : !Array.isArray(value.response.slots))) throw new UnsafeData();
    value.validation.issues.forEach(projectIssue);
    if ((value.validation.status === "ACCEPTED" && value.validation.issues.length !== 0)
      || (value.validation.status === "REJECTED" && value.validation.issues.length < 1)) throw new UnsafeData();
    return deepFreeze(value);
  } catch {
    throw failed();
  }
}

function reservationScope(value) {
  if (!value || typeof value !== "object" || !["RESERVED", "EXISTING", "IN_PROGRESS"].includes(value.status)
    || !safeId(value.runId)) throw failed();
  if (value.status !== "RESERVED") return value;
  if (![value.accountId, value.jobId, value.itemId, value.sourceSnapshotId, value.profileId,
    value.requestKey, value.correlationId].every(safeId)
    || !safeText(value.model) || !safeText(value.templateVersion)
    || !Number.isSafeInteger(value.profileVersion) || value.profileVersion < 1
    || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(value.planningContract)
    || typeof value.inputHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.inputHash)
    || !((value.planningContract === "LEGACY_FULL_PLAN_V3" && value.skeletonHash === null)
      || (value.planningContract === "FIXED_SKELETON_V1" && /^[a-f0-9]{64}$/u.test(value.skeletonHash || "")))
    || !value.gatewayProfile || typeof value.gatewayProfile !== "object"
    || !value.request || typeof value.request !== "object"
    || !value.request.schema || typeof value.request.text !== "string" || !value.request.text) throw failed();
  return value;
}

function validationResult(value) {
  try {
    const projected = project(value);
    if (!exact(projected, new Set(["status", "validatorVersion", "issues", "validatedAt"]))
      || !["ACCEPTED", "REJECTED"].includes(projected.status)
      || !safeText(projected.validatorVersion) || !canonicalTime(projected.validatedAt)
      || !Array.isArray(projected.issues) || projected.issues.length > 100
      || (projected.status === "ACCEPTED" && projected.issues.length !== 0)
      || (projected.status === "REJECTED" && projected.issues.length < 1)) throw new UnsafeData();
    projected.issues.forEach(projectIssue);
    return projected;
  } catch {
    throw failed();
  }
}

function diagnoseReplayResponse({ reservation, response, now }) {
  const plannerContext = reservation?.validationContext?.plannerContext;
  const skeleton = reservation?.validationContext?.skeleton ?? null;
  if (!plannerContext || (reservation.planningContract === "FIXED_SKELETON_V1" && !skeleton)) throw failed();
  let diagnosis;
  try {
    const plan = reservation.planningContract === "FIXED_SKELETON_V1"
      ? mergeContentPlanFill({ skeleton, fill: response, plannerContext }) : response;
    diagnosis = diagnoseContentPlan({ plan, plannerContext });
  } catch (error) {
    if (error?.code !== "AUTO_LISTING_CONTENT_PLAN_INVALID" || !Array.isArray(error?.issues)) throw failed();
    diagnosis = {
      status: "REJECTED",
      validatorVersion: "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1",
      issues: error.issues,
    };
  }
  return {
    status: diagnosis.status,
    validatorVersion: diagnosis.validatorVersion,
    issues: diagnosis.issues,
    validatedAt: now(),
  };
}

export function createAutoListingPlanDiagnosticService({
  repository,
  contextRepository = null,
  gateway = null,
  evidenceRepository = null,
  diagnoseResponse = diagnoseReplayResponse,
  getReplayDependencies = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof repository?.loadLatest !== "function") {
    throw new TypeError("Auto-listing plan diagnostic repository is required");
  }
  const api = {
    async getLatest(raw) {
      const input = projectRequest(raw);
      assertPermission(input.actor, PERMISSIONS.AI_CONTENT_MANAGE);
      let record;
      try {
        record = await repository.loadLatest({
          accountId: input.actor.id,
          jobId: input.jobId,
          itemId: input.itemId,
        });
      } catch {
        throw failed();
      }
      if (record === null) throw notFound();
      return projectDetail(record);
    },
    async replay(raw) {
      const input = projectReplayRequest(raw);
      assertPermission(input.actor, PERMISSIONS.AI_CONTENT_MANAGE);
      let dependencies = { contextRepository, gateway, evidenceRepository };
      if (typeof getReplayDependencies === "function") {
        try { dependencies = await getReplayDependencies(); } catch { throw failed(); }
      }
      const replayContextRepository = dependencies?.contextRepository;
      const replayGateway = dependencies?.gateway;
      const replayEvidenceRepository = dependencies?.evidenceRepository;
      if (typeof replayContextRepository?.reserve !== "function"
        || typeof replayContextRepository?.complete !== "function"
        || typeof replayGateway?.createTextResponse !== "function"
        || typeof replayEvidenceRepository?.loadOutcome !== "function"
        || typeof replayEvidenceRepository?.recordResponse !== "function"
        || typeof replayEvidenceRepository?.recordValidation !== "function"
        || typeof diagnoseResponse !== "function" || typeof now !== "function") throw failed();
      let reservation;
      try {
        reservation = reservationScope(await replayContextRepository.reserve({
          accountId: input.actor.id,
          actorAccountId: input.actor.id,
          jobId: input.jobId,
          itemId: input.itemId,
          sourceSnapshotId: input.sourceSnapshotId,
          expectedStatusVersion: input.expectedStatusVersion,
          costConfirmed: true,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
        }));
      } catch (error) {
        if ([
          "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_ELIGIBLE",
          "AUTO_LISTING_PLAN_DIAGNOSTIC_IDEMPOTENCY_CONFLICT",
          "AUTO_LISTING_PLAN_DIAGNOSTIC_RESPONSE_UNKNOWN",
        ].includes(error?.code)) throw error;
        throw failed();
      }
      if (reservation.status === "IN_PROGRESS") {
        throw diagnosticError("AUTO_LISTING_PLAN_DIAGNOSTIC_IN_PROGRESS", 409);
      }
      if (reservation.status === "EXISTING") {
        if (typeof repository.loadRun !== "function") throw failed();
        let record;
        try {
          record = await repository.loadRun({
            accountId: input.actor.id, jobId: input.jobId, itemId: input.itemId, runId: reservation.runId,
          });
        } catch { throw failed(); }
        if (record === null) throw failed();
        const detail = projectDetail(record);
        return deepFreeze({ created: false, detail });
      }
      const evidenceScope = {
        accountId: reservation.accountId,
        jobId: reservation.jobId,
        itemId: reservation.itemId,
        sourceSnapshotId: reservation.sourceSnapshotId,
        owner: { kind: "DIAGNOSTIC", id: reservation.runId },
        planningContract: reservation.planningContract,
        inputHash: reservation.inputHash,
        skeletonHash: reservation.skeletonHash,
        profileId: reservation.profileId,
        profileVersion: reservation.profileVersion,
      };
      let terminalValidation = null;
      try {
        let outcome = await replayEvidenceRepository.loadOutcome(evidenceScope);
        let responseEvidence = outcome?.response || null;
        if (!responseEvidence) {
          const response = await replayGateway.createTextResponse({
            profile: reservation.gatewayProfile,
            model: reservation.model,
            correlationId: reservation.correlationId,
            requestKey: reservation.requestKey,
            jsonSchema: reservation.request.schema,
            prompt: reservation.request.text,
          });
          responseEvidence = await replayEvidenceRepository.recordResponse({
            ...evidenceScope,
            modelName: reservation.model,
            promptTemplateVersion: reservation.templateVersion,
            gatewayRequestId: response?.requestId ?? null,
            response: response?.value,
          });
          outcome = null;
        }
        const validation = outcome?.validation || validationResult(await diagnoseResponse({
          reservation,
          response: responseEvidence.response,
          now,
        }));
        if (!outcome?.validation) {
          const validationCommand = {
            accountId: reservation.accountId,
            responseId: responseEvidence.id,
            status: validation.status,
            validatorVersion: validation.validatorVersion,
            issues: validation.issues,
          };
          try {
            await replayEvidenceRepository.recordValidation(validationCommand);
          } catch {
            await replayEvidenceRepository.recordValidation(validationCommand);
          }
        }
        terminalValidation = validation;
        await replayContextRepository.complete({
          accountId: reservation.accountId,
          runId: reservation.runId,
          status: validation.status,
          failureCode: null,
        });
        if (typeof repository.loadRun !== "function") throw failed();
        const replayRecord = await repository.loadRun({
          accountId: input.actor.id, jobId: input.jobId, itemId: input.itemId, runId: reservation.runId,
        });
        if (replayRecord === null) throw failed();
        const detail = projectDetail(replayRecord);
        return deepFreeze({ created: true, detail });
      } catch (error) {
        try {
          await replayContextRepository.complete({
            accountId: reservation.accountId,
            runId: reservation.runId,
            status: terminalValidation?.status || "FAILED",
            failureCode: terminalValidation ? null : "AUTO_LISTING_PLAN_DIAGNOSTIC_EXECUTION_FAILED",
          });
        } catch {}
        if (error?.code === "AUTO_LISTING_PLAN_DIAGNOSTIC_FAILED") throw error;
        throw failed();
      }
    },
  };
  return Object.freeze(api);
}
