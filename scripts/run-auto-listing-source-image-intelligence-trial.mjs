import { pathToFileURL } from "node:url";

const TRIAL_COLLECT_ITEM_IDS = Object.freeze([
  "collect_9a5cc7e1da9b50dd2642d078",
  "collect_1c0c66c95d4203ef65c00489",
]);
const TRIAL_COLLECT_ITEM_ID = TRIAL_COLLECT_ITEM_IDS[0];
const TRIAL_HARD_PAID_CALL_LIMIT = 512;
const TRIAL_RESUMABLE_ITEM_STATUSES = new Set(["PLANNING", "GENERATING"]);
const TRIAL_SAFE_TERMINAL_ITEM_STATUSES = new Set([
  "READY_FOR_REVIEW", "BLOCKED", "RETRYABLE_ERROR", "CANCELLED",
]);
const TRIAL_FORBIDDEN_UPLOAD_ITEM_STATUSES = new Set(["UPLOAD_QUEUED", "UPLOADING", "SUCCEEDED"]);
const TRIAL_OZON_READ_PATHS = new Set([
  "/v1/description-category/tree",
  "/v1/description-category/attribute",
  "/v1/description-category/attribute/values",
  "/v2/warehouse/list",
]);
const PAID_PHASES = new Set([
  "ANALYZE_SOURCE_IMAGE_BATCH",
  "CLEAN_SOURCE_IMAGE_OVERLAY",
  "CHECK_SOURCE_IMAGE_CLEANUP",
  "PLAN_CONTENT",
  "GENERATE_IMAGE_SLOT",
  "CHECK_IMAGE_GROUP",
  "GENERATE_RICH_CONTENT",
]);
const SAFE_ANALYSIS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_ANALYSIS_REASON = /^[A-Z0-9][A-Z0-9_:-]{0,119}$/u;
const throwingOzonWriters = new WeakSet();
let closeProductionTrialPool = null;

function trialError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

const trialIdempotencyKey = (collectItemIds) => {
  const ids = Array.isArray(collectItemIds) ? collectItemIds : [collectItemIds];
  return ids.length === 1
    ? `source-image-v2-cleanup-trial-${ids[0]}`
    : "source-image-v2-cleanup-dual-trial-v4";
};

function isExactExpiredTrialAssignment({ channel, preflight, collectItemId }) {
  const assignment = preflight?.resumeAssignment;
  return channel?.status === "BUSY"
    && assignment && typeof assignment === "object" && !Array.isArray(assignment)
    && assignment.idempotencyKey === trialIdempotencyKey(collectItemId)
    && assignment.collectItemId === collectItemId
    && typeof assignment.jobId === "string" && assignment.jobId.length > 0
    && typeof assignment.itemId === "string" && assignment.itemId.length > 0
    && assignment.itemId === channel.assignedItemId
    && assignment.channelId === channel.channelId
    && TRIAL_RESUMABLE_ITEM_STATUSES.has(assignment.itemStatus)
    && Number.isSafeInteger(assignment.itemStatusVersion) && assignment.itemStatusVersion > 0
    && assignment.assignedStatusVersion === assignment.itemStatusVersion
    && assignment.leaseActive === false;
}

function isExactExpiredDualTrialAssignment({ channel, preflight, collectItemIds }) {
  const assignments = Array.isArray(preflight?.resumeAssignments) ? preflight.resumeAssignments : [];
  const assignment = assignments.find((candidate) => candidate?.channelId === channel?.channelId);
  return channel?.status === "BUSY"
    && assignment && assignment.idempotencyKey === trialIdempotencyKey(collectItemIds)
    && collectItemIds.includes(assignment.collectItemId)
    && typeof assignment.jobId === "string" && assignment.jobId.length > 0
    && typeof assignment.itemId === "string" && assignment.itemId.length > 0
    && assignment.itemId === channel.assignedItemId
    && TRIAL_RESUMABLE_ITEM_STATUSES.has(assignment.itemStatus)
    && Number.isSafeInteger(assignment.itemStatusVersion) && assignment.itemStatusVersion > 0
    && assignment.assignedStatusVersion === assignment.itemStatusVersion
    && assignment.leaseActive === false;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ARGUMENTS_INVALID", "Trial arguments are invalid");
  }
  if (argv[0] === "--") argv = argv.slice(1);
  const parsed = {
    collectItemIds: [],
    channelCapacity: null,
    stopAt: null,
    paidCallsUsed: null,
    confirmPaidAi: false,
    preflightOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-paid-ai") {
      if (parsed.confirmPaidAi) throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ARGUMENTS_INVALID", "Duplicate trial argument");
      parsed.confirmPaidAi = true;
      continue;
    }
    if (argument === "--preflight-only") {
      if (parsed.preflightOnly) throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ARGUMENTS_INVALID", "Duplicate trial argument");
      parsed.preflightOnly = true;
      continue;
    }
    const key = ({
      "--channel-capacity": "channelCapacity",
      "--stop-at": "stopAt",
      "--paid-calls-used": "paidCallsUsed",
    })[argument];
    if (argument === "--collect-item-id") {
      if (parsed.collectItemIds.length >= 2 || index + 1 >= argv.length) {
        throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ARGUMENTS_INVALID", "Trial arguments are invalid");
      }
      parsed.collectItemIds.push(argv[index += 1]);
      continue;
    }
    if (!key || parsed[key] !== null || index + 1 >= argv.length) {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ARGUMENTS_INVALID", "Trial arguments are invalid");
    }
    parsed[key] = argv[index += 1];
  }
  const paidCallsUsed = parsed.paidCallsUsed === null ? 0 : Number(parsed.paidCallsUsed);
  if (!Number.isSafeInteger(paidCallsUsed) || paidCallsUsed < 0
    || paidCallsUsed > TRIAL_HARD_PAID_CALL_LIMIT
    || (parsed.paidCallsUsed !== null && String(paidCallsUsed) !== parsed.paidCallsUsed)) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ARGUMENTS_INVALID", "Trial arguments are invalid");
  }
  return Object.freeze({ ...parsed, collectItemIds: Object.freeze([...parsed.collectItemIds]), paidCallsUsed });
}

export function createThrowingOzonWriter() {
  const calls = [];
  const target = async function forbiddenOzonWrite() {
    calls.push("callOzonSellerApi");
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN", "Ozon writes are disabled for this trial");
  };
  Object.defineProperty(target, "calls", { enumerable: true, value: calls });
  const writer = new Proxy(target, {
    get(value, property, receiver) {
      if (property === "calls") return calls;
      if (property === "then") return undefined;
      if (typeof property === "symbol") return Reflect.get(value, property, receiver);
      return async function forbiddenOzonMethod() {
        calls.push(property);
        throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN", "Ozon writes are disabled for this trial");
      };
    },
  });
  throwingOzonWriters.add(writer);
  return Object.freeze(writer);
}

export function createTrialOzonReadTransport({ transport } = {}) {
  if (typeof transport !== "function") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_READ_TRANSPORT_INVALID", "The Ozon read transport is required");
  }
  const calls = [];
  const readTransport = async (...args) => {
    const apiPath = args[1];
    if (typeof apiPath !== "string" || !TRIAL_OZON_READ_PATHS.has(apiPath)) {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_READ_PATH_FORBIDDEN", "The Ozon path is outside the approved read-only trial boundary");
    }
    calls.push(apiPath);
    return transport(...args);
  };
  Object.defineProperty(readTransport, "calls", {
    enumerable: true,
    get: () => Object.freeze([...calls]),
  });
  return Object.freeze(readTransport);
}

export function estimatePaidCalls({ capturedSourceImageCount, cleanupAttemptsReserved = 0 } = {}) {
  if (!Number.isSafeInteger(capturedSourceImageCount) || capturedSourceImageCount < 1) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_IMAGE_COUNT_INVALID", "Captured source image count is required");
  }
  if (!Number.isSafeInteger(cleanupAttemptsReserved) || cleanupAttemptsReserved < 0
    || cleanupAttemptsReserved > capturedSourceImageCount * 3) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_IMAGE_COUNT_INVALID", "Reserved cleanup attempt count is invalid");
  }
  const analysisBatchCalls = Math.ceil(capturedSourceImageCount / 6);
  const cleanupEditCalls = cleanupAttemptsReserved;
  const cleanupCheckCalls = cleanupAttemptsReserved;
  const baselinePaidCalls = analysisBatchCalls + cleanupEditCalls + cleanupCheckCalls + 15;
  if (baselinePaidCalls > TRIAL_HARD_PAID_CALL_LIMIT) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_BUDGET_UNSUPPORTED", "Captured source images exceed the approved paid-call budget");
  }
  const estimate = {
    capturedSourceImageCount,
    analysisBatchCalls,
    cleanupAttemptsReserved,
    cleanupEditCalls,
    cleanupCheckCalls,
    planContentCalls: 1,
    slotGenerationCalls: 6,
    perSlotCheckCalls: 6,
    groupCheckCalls: 1,
    richContentCalls: 1,
    baselinePaidCalls,
    hardPaidCallLimit: TRIAL_HARD_PAID_CALL_LIMIT,
  };
  return Object.freeze(estimate);
}

function duplicateCount(values) {
  return Array.isArray(values) ? values.length - new Set(values).size : 0;
}

const trialConnectionIdentity = ({ connectionId, connectionVersion }) =>
  `${connectionId || ""}\0${connectionVersion || ""}`;

export function summarizeTrialExecutionEvidence({
  itemIds,
  expectedConnections,
  itemRows,
  attemptRows,
} = {}) {
  const validConnection = ({ connectionId, connectionVersion }) => typeof connectionId === "string"
    && connectionId.length > 0 && Number.isSafeInteger(connectionVersion) && connectionVersion > 0;
  const expected = Array.isArray(expectedConnections) ? expectedConnections : [];
  const expectedIdentities = new Set(expected.map(trialConnectionIdentity));
  const requestedItemIds = Array.isArray(itemIds) ? itemIds : [];
  const requestedItemIdSet = new Set(requestedItemIds);
  const rowsByItemId = new Map((Array.isArray(itemRows) ? itemRows : []).map((row) => [row.id, row]));
  const itemConnections = requestedItemIds.map((itemId) => {
    const row = rowsByItemId.get(itemId) || {};
    return Object.freeze({
      itemId,
      connectionId: row.last_ai_connection_id,
      connectionVersion: row.last_ai_connection_version,
    });
  });
  const attempts = (Array.isArray(attemptRows) ? attemptRows : []).map((row) => Object.freeze({
    itemId: row.item_id,
    attemptId: row.attempt_id,
    connectionId: row.connection_id,
    connectionVersion: row.connection_version,
  }));
  const attemptIds = attempts.map(({ attemptId }) => attemptId);
  const actualConnectionIdentities = new Set(attempts.map(trialConnectionIdentity));
  const usage = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.itemId}\0${trialConnectionIdentity(attempt)}`;
    const current = usage.get(key);
    usage.set(key, current ? { ...current, attemptCount: current.attemptCount + 1 } : {
      itemId: attempt.itemId,
      connectionId: attempt.connectionId,
      connectionVersion: attempt.connectionVersion,
      attemptCount: 1,
    });
  }
  const connectionUsage = [...usage.values()].sort((left, right) => {
    const itemOrder = requestedItemIds.indexOf(left.itemId) - requestedItemIds.indexOf(right.itemId);
    return itemOrder || trialConnectionIdentity(left).localeCompare(trialConnectionIdentity(right));
  }).map(Object.freeze);
  const lastConnectionIdentities = new Set(itemConnections.map(trialConnectionIdentity));
  const evidence = Object.freeze({
    itemConnections: Object.freeze(itemConnections),
    connectionUsage: Object.freeze(connectionUsage),
    distinctConnectionCount: actualConnectionIdentities.size,
    lastConnectionCount: lastConnectionIdentities.size,
    attemptCount: attemptIds.length,
    duplicateAttemptIdCount: duplicateCount(attemptIds),
  });
  const everyItemExecuted = requestedItemIds.every((itemId) => attempts.some((row) => row.itemId === itemId));
  const exactConnectionSet = actualConnectionIdentities.size === expectedIdentities.size
    && [...actualConnectionIdentities].every((identity) => expectedIdentities.has(identity));
  if (requestedItemIds.length < 1 || requestedItemIdSet.size !== requestedItemIds.length
    || expected.length !== requestedItemIds.length || expectedIdentities.size !== expected.length
    || expected.some((connection) => !validConnection(connection))
    || rowsByItemId.size !== requestedItemIds.length || itemConnections.some((connection) =>
      !validConnection(connection) || !expectedIdentities.has(trialConnectionIdentity(connection)))
    || attempts.length < requestedItemIds.length || attempts.some((attempt) =>
      !requestedItemIdSet.has(attempt.itemId) || typeof attempt.attemptId !== "string"
      || attempt.attemptId.length === 0 || !validConnection(attempt)
      || !expectedIdentities.has(trialConnectionIdentity(attempt)))
    || !everyItemExecuted || !exactConnectionSet || evidence.duplicateAttemptIdCount !== 0) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EXECUTION_EVIDENCE_INVALID",
      "The trial did not prove isolated channel execution");
  }
  return evidence;
}

function boundsShape(value) {
  if (value === null) return "VALID_NULL";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "NON_OBJECT";
  if (Object.keys(value).length !== 4
    || ["x", "y", "width", "height"].some((key) => !Object.hasOwn(value, key))) return "OBJECT_SHAPE";
  const { x, y, width, height } = value;
  const values = [x, y, width, height];
  if (!values.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return "NON_NUMERIC";
  const normalized = values.every((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 1)
    && width > 0 && height > 0 && x + width <= 1 && y + height <= 1;
  const normalizedEndpoint = values.every((entry) => entry >= 0 && entry <= 1)
    && width > x && height > y && (x + width > 1 || y + height > 1);
  const integerGrid = values.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000)
    && values.some((entry) => entry > 1)
    && width > 0 && height > 0 && x + width <= 1_000 && y + height <= 1_000;
  const integerGridEndpoint = values.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000)
    && values.some((entry) => entry > 1)
    && width > x && height > y && (x + width > 1_000 || y + height > 1_000);
  if (normalized) return "VALID_NORMALIZED";
  if (normalizedEndpoint) return "VALID_NORMALIZED_ENDPOINT";
  if (integerGrid) return "VALID_INTEGER_GRID";
  if (integerGridEndpoint) return "VALID_INTEGER_GRID_ENDPOINT";
  if (values.every((entry) => entry >= 0 && entry <= 1)) return "NORMALIZED_GEOMETRY";
  if (values.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000)) {
    return "INTEGER_GRID_GEOMETRY";
  }
  if (values.every((entry) => entry >= 0 && entry <= 1_000)) return "DECIMAL_GRID";
  return "UNSUPPORTED_RANGE";
}

function invalidReasonCount(value) {
  if (!Array.isArray(value)) return 1;
  return value.filter((reason) => typeof reason !== "string" || !SAFE_ANALYSIS_REASON.test(reason)).length
    + duplicateCount(value);
}

export function summarizeSourceImageAnalysisResponse(response) {
  const value = response?.value && typeof response.value === "object" ? response.value : response;
  const observations = Array.isArray(value?.observations) ? value.observations : [];
  let duplicateContentKindCount = 0;
  let duplicateEligibleUseCount = 0;
  let invalidReasonCodeCount = 0;
  let invalidBoundsCount = 0;
  const invalidBoundsKinds = {};
  let invalidOcrTextCount = 0;
  let invalidDuplicateGroupCount = 0;
  const inspectBounds = (value) => {
    const shape = boundsShape(value);
    if (!shape.startsWith("VALID_")) {
      invalidBoundsCount += 1;
      invalidBoundsKinds[shape] = (invalidBoundsKinds[shape] || 0) + 1;
    }
  };
  for (const observation of observations) {
    const contentKinds = Array.isArray(observation?.contentKinds) ? observation.contentKinds : [];
    const eligibleUses = Array.isArray(observation?.eligibleUses) ? observation.eligibleUses : [];
    duplicateContentKindCount += duplicateCount(contentKinds);
    duplicateEligibleUseCount += duplicateCount(eligibleUses);
    invalidReasonCodeCount += invalidReasonCount(observation?.reasonCodes);
    inspectBounds(observation?.subjectBounds);
    for (const viewpoint of Array.isArray(observation?.viewpoints) ? observation.viewpoints : []) {
      invalidReasonCodeCount += invalidReasonCount(viewpoint?.reasonCodes);
    }
    if (observation?.quality !== null) {
      invalidReasonCodeCount += invalidReasonCount(observation?.quality?.reasonCodes);
    }
    for (const region of Array.isArray(observation?.ocrRegions) ? observation.ocrRegions : []) {
      inspectBounds(region?.region);
      const text = region?.text;
      if (typeof text !== "string" || !text.trim() || text !== text.trim() || text.length > 500
        || /[\u0000-\u001f\u007f]/u.test(text)) invalidOcrTextCount += 1;
    }
    for (const marking of Array.isArray(observation?.markings) ? observation.markings : []) {
      invalidReasonCodeCount += invalidReasonCount(marking?.reasonCodes);
      inspectBounds(marking?.region);
    }
    const group = observation?.perceptualDuplicateGroup;
    if (!(group === null || (typeof group === "string" && SAFE_ANALYSIS_ID.test(group)))) {
      invalidDuplicateGroupCount += 1;
    }
  }
  const sourceAssetIds = observations.map((observation) => observation?.sourceAssetId);
  return Object.freeze({
    observationCount: observations.length,
    duplicateSourceAssetIdCount: duplicateCount(sourceAssetIds),
    duplicateContentKindCount,
    duplicateEligibleUseCount,
    invalidReasonCodeCount,
    invalidBoundsCount,
    invalidBoundsKinds: Object.freeze({ ...invalidBoundsKinds }),
    invalidOcrTextCount,
    invalidDuplicateGroupCount,
  });
}

export function selectTrialJobItems(job, collectItemIds) {
  if (!Array.isArray(job?.items) || !Array.isArray(collectItemIds)) return [];
  return collectItemIds.map((collectItemId) => job.items.find((candidate) =>
    candidate?.sourceRecordId === collectItemId || candidate?.collectItemId === collectItemId)).filter(Boolean);
}

export function trialBatchHasSettledFailure(items, expectedCount) {
  return Number.isSafeInteger(expectedCount) && expectedCount > 0
    && Array.isArray(items) && items.length === expectedCount
    && items.every((item) => TRIAL_SAFE_TERMINAL_ITEM_STATUSES.has(item?.status))
    && items.some((item) => item.status !== "READY_FOR_REVIEW");
}

function estimateTrialPaidCalls({ collectItemIds, preflight }) {
  if (collectItemIds.length === 1) {
    return estimatePaidCalls({
      capturedSourceImageCount: preflight?.capturedSourceImageCount,
      cleanupAttemptsReserved: preflight?.cleanupAttemptsReserved ?? 0,
    });
  }
  const rows = Array.isArray(preflight?.capturedSourceImages) ? preflight.capturedSourceImages : [];
  if (rows.length !== collectItemIds.length) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_IMAGE_COUNT_INVALID", "Captured source image counts are required");
  }
  const byId = new Map(rows.map((row) => [row?.collectItemId, row]));
  const items = collectItemIds.map((collectItemId) => {
    const row = byId.get(collectItemId);
    const estimate = estimatePaidCalls({
      capturedSourceImageCount: row?.count,
      cleanupAttemptsReserved: row?.cleanupAttemptsReserved ?? 0,
    });
    return Object.freeze({ collectItemId, capturedSourceImageCount: estimate.capturedSourceImageCount,
      cleanupAttemptsReserved: estimate.cleanupAttemptsReserved,
      baselinePaidCalls: estimate.baselinePaidCalls });
  });
  const baselinePaidCalls = items.reduce((total, item) => total + item.baselinePaidCalls, 0);
  if (baselinePaidCalls > TRIAL_HARD_PAID_CALL_LIMIT) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_BUDGET_UNSUPPORTED", "Captured source images exceed the approved paid-call budget");
  }
  return Object.freeze({ items: Object.freeze(items), baselinePaidCalls,
    hardPaidCallLimit: TRIAL_HARD_PAID_CALL_LIMIT });
}

function paidCallKind(phase, method) {
  if (method === "analyzeSourceImages") {
    return phase === "ANALYZE_SOURCE_IMAGE_BATCH" ? "ANALYZE_SOURCE_IMAGE_BATCH" : null;
  }
  if (method === "createTextResponse") {
    return ({
      ANALYZE_SOURCE_IMAGE_BATCH: "ANALYZE_SOURCE_IMAGE_BATCH",
      CHECK_SOURCE_IMAGE_CLEANUP: "CHECK_SOURCE_IMAGE_CLEANUP",
      PLAN_CONTENT: "PLAN_CONTENT",
      GENERATE_RICH_CONTENT: "GENERATE_RICH_CONTENT",
    })[phase] || null;
  }
  if (method === "generateImage") {
    if (phase === "CLEAN_SOURCE_IMAGE_OVERLAY") return "CLEAN_SOURCE_IMAGE_OVERLAY";
    return phase === "GENERATE_IMAGE_SLOT" ? "GENERATE_IMAGE_SLOT" : null;
  }
  if (method === "inspectImage") {
    if (phase === "GENERATE_IMAGE_SLOT") return "CHECK_IMAGE_SLOT";
    if (phase === "CHECK_IMAGE_GROUP") return "CHECK_IMAGE_GROUP";
  }
  return null;
}

export function createTrialPaidCallBudget({
  hardPaidCallLimit, paidCallsUsed = 0, onPaidResponse = () => {},
} = {}) {
  if (!Number.isSafeInteger(hardPaidCallLimit) || hardPaidCallLimit < 1
    || hardPaidCallLimit > TRIAL_HARD_PAID_CALL_LIMIT
    || !Number.isSafeInteger(paidCallsUsed) || paidCallsUsed < 0 || paidCallsUsed > hardPaidCallLimit
    || typeof onPaidResponse !== "function") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_BUDGET_INVALID", "The paid-call budget is invalid");
  }
  let paidCalls = paidCallsUsed;
  const callsByKind = new Map();
  const invoke = async (phase, method, gateway, args) => {
    const kind = paidCallKind(phase, method);
    if (!kind || typeof gateway?.[method] !== "function") {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "The paid gateway operation is outside the approved boundary");
    }
    if (paidCalls >= hardPaidCallLimit) {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_CALL_LIMIT_EXCEEDED", "The approved paid-call limit has been reached");
    }
    paidCalls += 1;
    callsByKind.set(kind, (callsByKind.get(kind) || 0) + 1);
    const response = await gateway[method](...args);
    try { onPaidResponse(Object.freeze({ phase, method, kind, response })); } catch {}
    return response;
  };
  return Object.freeze({
    wrapGateway({ phase, gateway } = {}) {
      if (!PAID_PHASES.has(phase) || !gateway || typeof gateway !== "object") {
        throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "The paid gateway boundary is invalid");
      }
      return Object.freeze({
        ...gateway,
        ...(typeof gateway.analyzeSourceImages === "function" ? {
          analyzeSourceImages: (...args) => invoke(phase, "analyzeSourceImages", gateway, args),
        } : {}),
        createTextResponse: (...args) => invoke(phase, "createTextResponse", gateway, args),
        generateImage: (...args) => invoke(phase, "generateImage", gateway, args),
        inspectImage: (...args) => invoke(phase, "inspectImage", gateway, args),
        async listModels() {
          throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "Model catalog calls are outside the paid trial");
        },
        async testCapabilities() {
          throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "Capability probes are outside the paid trial");
        },
      });
    },
    snapshot() {
      return Object.freeze({
        paidCalls,
        hardPaidCallLimit,
        callsByKind: Object.freeze(Object.fromEntries([...callsByKind].sort())),
      });
    },
  });
}

export function wrapTrialProductionAiDependencies({ dependencies, paidCallBudget } = {}) {
  if (!dependencies || typeof dependencies !== "object" || typeof dependencies.loadContext !== "function"
    || !paidCallBudget || typeof paidCallBudget.wrapGateway !== "function") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "Production AI dependencies cannot be budgeted");
  }
  return Object.freeze({
    ...dependencies,
    async loadContext(input) {
      const context = await dependencies.loadContext(input);
      const phase = input?.message?.phase;
      if (!PAID_PHASES.has(phase)) return context;
      if (!context || typeof context !== "object" || !context.phaseInput
        || typeof context.phaseInput !== "object" || !context.phaseInput.gateway) {
        throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "A paid phase did not expose its gateway boundary");
      }
      return Object.freeze({
        ...context,
        phaseInput: Object.freeze({
          ...context.phaseInput,
          gateway: paidCallBudget.wrapGateway({ phase, gateway: context.phaseInput.gateway }),
        }),
      });
    },
    async sourceImageAnalyzer() {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PAID_GATEWAY_BOUNDARY_INVALID", "Unbudgeted source analysis is forbidden");
    },
  });
}

export async function runGuardedTrial({
  argv = [],
  env = {},
  uploadStrategy,
  ozonWriter,
  loadPreflight,
  reloadUploadPolicy,
  gatewayFactory,
  runTrial,
  writeLine = (line) => process.stdout.write(`${line}\n`),
  loadProductionComposition = createProductionComposition,
} = {}) {
  const parsed = parseArguments(argv);
  const collectItemIds = parsed.collectItemIds;
  if (env?.AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED !== "true") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_FLAG_REQUIRED", "Source image intelligence must be explicitly enabled");
  }
  const approvedCollectItems = collectItemIds.length === 1
    ? collectItemIds[0] === TRIAL_COLLECT_ITEM_ID
    : collectItemIds.length === TRIAL_COLLECT_ITEM_IDS.length
      && collectItemIds.every((collectItemId, index) => collectItemId === TRIAL_COLLECT_ITEM_IDS[index]);
  if (!approvedCollectItems) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_COLLECT_ITEM_REQUIRED", "The approved collect item is required");
  }
  const channelCapacity = Number(parsed.channelCapacity);
  if (!Number.isSafeInteger(channelCapacity) || channelCapacity !== collectItemIds.length) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_CHANNEL_CAPACITY_REQUIRED", "Effective channel capacity must match the approved item count");
  }
  if (parsed.stopAt !== "READY_FOR_REVIEW") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_STOP_STATUS_REQUIRED", "The trial must stop at review");
  }
  if (uploadStrategy !== "REVIEW") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_REVIEW_UPLOAD_REQUIRED", "Upload strategy must be review-only");
  }
  if (!throwingOzonWriters.has(ozonWriter)) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_STUB_REQUIRED", "The throwing Ozon stub is required");
  }
  if (!parsed.preflightOnly && !parsed.confirmPaidAi) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_CONFIRMATION_REQUIRED", "Explicit paid AI confirmation is required");
  }

  if ([loadPreflight, reloadUploadPolicy, gatewayFactory, runTrial].some((operation) => typeof operation !== "function")) {
    if (typeof loadProductionComposition !== "function") {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EXECUTOR_REQUIRED", "The approved production composition is required");
    }
    const production = await loadProductionComposition({ env, ozonWriter });
    loadPreflight ??= production?.loadPreflight;
    reloadUploadPolicy ??= production?.reloadUploadPolicy;
    gatewayFactory ??= production?.gatewayFactory;
    runTrial ??= production?.runTrial;
  }
  if (typeof loadPreflight !== "function") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PREFLIGHT_REQUIRED", "The production preflight is required");
  }
  const preflight = await loadPreflight({ collectItemIds,
    ...(collectItemIds.length === 1 ? { collectItemId: collectItemIds[0] } : {}) });
  if (preflight?.uploadPolicy?.mode !== "REVIEW") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_REVIEW_UPLOAD_REQUIRED", "The persisted upload policy must be review-only");
  }
  const enabledProfiles = Array.isArray(preflight?.profiles)
    ? preflight.profiles.filter((profile) => profile?.enabled === true) : [];
  if (enabledProfiles.length !== 1) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_PROFILE_REQUIRED", "Exactly one enabled AI profile is required");
  }
  const enabledChannels = Array.isArray(preflight?.channels) ? preflight.channels.filter((channel) =>
    channel?.enabled === true && channel.requiresRevalidation === false) : [];
  const distinctConnections = new Set(enabledChannels.map((channel) =>
    `${channel?.connectionId || ""}\0${channel?.connectionVersion || ""}`));
  const channelReady = enabledChannels.length === channelCapacity
    && (channelCapacity === 1 || distinctConnections.size === channelCapacity)
    && enabledChannels.every((channel) => channel?.status === "AVAILABLE"
      || (channelCapacity === 1
        ? isExactExpiredTrialAssignment({ channel, preflight, collectItemId: collectItemIds[0] })
        : isExactExpiredDualTrialAssignment({ channel, preflight, collectItemIds })));
  if (!channelReady) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EFFECTIVE_CAPACITY_REQUIRED", "Effective channel capacity or connection isolation is invalid");
  }
  const estimate = estimateTrialPaidCalls({ collectItemIds, preflight });
  if (typeof writeLine !== "function") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OUTPUT_INVALID", "A safe estimate output is required");
  }
  writeLine(JSON.stringify({ event: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ESTIMATE", estimate }));
  if (parsed.preflightOnly) {
    return Object.freeze({ status: "PREFLIGHT_ONLY", estimate });
  }
  if (typeof gatewayFactory !== "function" || typeof runTrial !== "function") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_EXECUTOR_REQUIRED", "The controller must provide the approved trial composition");
  }
  if (typeof reloadUploadPolicy !== "function"
    || (await reloadUploadPolicy({ accountId: preflight.accountId }))?.mode !== "REVIEW") {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_REVIEW_UPLOAD_REQUIRED", "The persisted upload policy changed before task creation");
  }
  const paidCallBudget = createTrialPaidCallBudget({
    hardPaidCallLimit: estimate.hardPaidCallLimit,
    paidCallsUsed: parsed.paidCallsUsed,
    onPaidResponse({ phase, method, response }) {
      if (phase === "ANALYZE_SOURCE_IMAGE_BATCH"
        && ["createTextResponse", "analyzeSourceImages"].includes(method)) {
        writeLine(JSON.stringify({
          event: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ANALYSIS_RESPONSE",
          ...summarizeSourceImageAnalysisResponse(response),
        }));
        return;
      }
      if (phase === "CHECK_SOURCE_IMAGE_CLEANUP" && method === "createTextResponse") {
        const modelEvidence = response?.modelEvidence || {};
        const value = response?.value || {};
        writeLine(JSON.stringify({
          event: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_CLEANUP_CHECK_RESPONSE",
          requestId: typeof response?.requestId === "string" ? response.requestId.slice(0, 240) : null,
          modelEvidence: {
            requestedTextModel: typeof modelEvidence.requestedTextModel === "string"
              ? modelEvidence.requestedTextModel.slice(0, 300) : null,
            gatewayReportedTextModel: typeof modelEvidence.gatewayReportedTextModel === "string"
              ? modelEvidence.gatewayReportedTextModel.slice(0, 300) : null,
            gatewayReportedTextModelPresent: modelEvidence.gatewayReportedTextModelPresent === true,
          },
          value: Object.fromEntries([
            "overlayRemoved", "productIdentityPreserved", "nativeMarksPreserved",
            "geometryPreserved", "noInventedContent",
          ].map((key) => [key, typeof value[key] === "boolean" ? value[key] : null])),
          reasonCodes: Array.isArray(value.reasonCodes)
            ? value.reasonCodes.filter((entry) => typeof entry === "string").slice(0, 20) : null,
        }));
        return;
      }
      if (phase !== "CHECK_IMAGE_GROUP" || method !== "inspectImage") return;
      const modelEvidence = response?.modelEvidence || {};
      const value = response?.value || {};
      writeLine(JSON.stringify({
        event: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_GROUP_RESPONSE",
        requestId: typeof response?.requestId === "string" ? response.requestId.slice(0, 240) : null,
        modelEvidence: {
          requestedTextModel: typeof modelEvidence.requestedTextModel === "string"
            ? modelEvidence.requestedTextModel.slice(0, 300) : null,
          gatewayReportedTextModel: typeof modelEvidence.gatewayReportedTextModel === "string"
            ? modelEvidence.gatewayReportedTextModel.slice(0, 300) : null,
          gatewayReportedTextModelPresent: modelEvidence.gatewayReportedTextModelPresent === true,
        },
        value: Object.fromEntries([
          "acceptedSlotKeys", "duplicateSlotKeys", "viewMismatchSlotKeys",
          "identityMismatchSlotKeys", "reasonCodes",
        ].map((key) => [key, Array.isArray(value[key])
          ? value[key].filter((entry) => typeof entry === "string").slice(0, 20)
          : null])),
      }));
    },
  });
  const gateway = await gatewayFactory({ ozonWriter, channelCapacity, preflight, paidCallBudget });
  const result = await runTrial({
    gateway,
    collectItemIds,
    ...(collectItemIds.length === 1 ? { collectItemId: collectItemIds[0] } : {}),
    channelCapacity,
    stopAt: parsed.stopAt,
    uploadStrategy,
    ozonWriter,
    estimate,
    preflight,
    paidCallBudget,
  });
  if (!result || !["READY_FOR_REVIEW", "BLOCKED"].includes(result.status)) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_TERMINAL_INVALID", "The trial stopped outside review");
  }
  if (ozonWriter.calls.length !== 0) {
    throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN", "The Ozon stub recorded a forbidden call");
  }
  writeLine(JSON.stringify({
    event: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_TERMINAL",
    status: result.status,
    itemStatuses: Array.isArray(result.itemStatuses) ? result.itemStatuses : null,
    ozonWriteCalls: 0,
    paidCalls: Number.isSafeInteger(result.paidCalls) ? result.paidCalls : null,
    paidCallsByKind: result.paidCallsByKind && typeof result.paidCallsByKind === "object"
      ? result.paidCallsByKind : null,
    executionEvidence: result.executionEvidence && typeof result.executionEvidence === "object"
      ? result.executionEvidence : null,
  }));
  return result;
}

async function createProductionComposition({ env, ozonWriter }) {
  const [connectionModule, repositoryModule, preferencesModule, settingsModule, snapshotModule,
    intelligenceModule, uploadPolicyModule, runtimeModule, aiCompositionModule, ozonClientModule] = await Promise.all([
    import("../server/db/connection.mjs"),
    import("../server/auto-listing-repository.mjs"),
    import("../server/auto-listing-preferences-postgres.mjs"),
    import("../server/auto-listing-ai-settings-postgres.mjs"),
    import("../server/auto-listing-source-snapshot.mjs"),
    import("../server/auto-listing-source-image-intelligence-contract.mjs"),
    import("../server/auto-listing-upload-policy.mjs"),
    import("../server/auto-listing-runtime.mjs"),
    import("../server/auto-listing-ai-runtime-composition.mjs"),
    import("../server/ozon-client.mjs"),
  ]);
  const pool = await connectionModule.getPostgresPool();
  closeProductionTrialPool = connectionModule.closePostgresPool;
  const repository = repositoryModule.createAutoListingRepository({ pool });
  const preferencesRepository = preferencesModule.createPostgresAutoListingPreferencesRepository({ pool });
  const settingsRepository = settingsModule.createAutoListingAiSettingsPostgres({ pool });
  const ozonReadTransport = createTrialOzonReadTransport({ transport: ozonClientModule.callOzonSellerApi });

  const selectReviewPolicy = async (accountId) => {
    const policy = uploadPolicyModule.selectAutoListingUploadPolicyForNewJob({
      accountId,
      policies: await repository.loadPublishedUploadPolicies({ accountId }),
      directUploadAllowed: false,
      uploadEnabled: false,
      listingPipelineEnabled: true,
    });
    if (policy.mode !== "REVIEW") {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_REVIEW_UPLOAD_REQUIRED", "The persisted upload policy must be review-only");
    }
    return policy;
  };

  const loadPreflight = async ({ collectItemIds }) => {
    const accountRows = await pool.query(
      `SELECT account_id,COUNT(*)::INTEGER AS item_count
         FROM collect_items
        WHERE id=ANY($1::text[]) AND deleted_at IS NULL
        GROUP BY account_id ORDER BY account_id`,
      [collectItemIds],
    );
    if (accountRows.rows?.length !== 1 || typeof accountRows.rows[0]?.account_id !== "string"
      || accountRows.rows[0].item_count !== collectItemIds.length) {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_ACCOUNT_REQUIRED", "The approved collect item must resolve to one account");
    }
    const accountId = accountRows.rows[0].account_id;
    const [sources, preferences, uploadPolicy, settings] = await Promise.all([
      repository.loadCollectSources({ accountId, collectItemIds }),
      preferencesRepository.getPreferences({ accountId }),
      selectReviewPolicy(accountId),
      settingsRepository.loadSettingsOverview({ accountId }),
    ]);
    if (sources.length !== collectItemIds.length || !preferences) {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_SOURCE_REQUIRED", "The approved source and saved preferences are required");
    }
    const targetStore = await repository.loadTargetStore({
      accountId,
      targetStoreId: preferences.targetStoreId,
    });
    if (!targetStore) {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_SOURCE_REQUIRED", "The saved target store is required");
    }
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const capturedSourceImages = collectItemIds.map((collectItemId) => {
      const source = sourceById.get(collectItemId);
      if (!source) {
        throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_SOURCE_REQUIRED", "The approved source is required");
      }
      const sourceCapture = snapshotModule.buildAutoListingSourceSnapshot({
        accountId,
        sourceType: "COLLECT_BOX",
        sourceRecordId: collectItemId,
        collectItemId,
        sourceVersion: source.sourceVersion,
        collectItem: source.collectItem,
        productDraft: source.productDraft,
        rawResponseRef: source.rawResponseRef,
        rawResponseHash: source.rawResponseHash,
        rawCollectedAt: source.rawCollectedAt,
        categoryEvidence: source.categoryEvidence,
        sharedCategory: source.sharedCategory,
        targetStoreId: targetStore.id,
        targetStoreCurrency: targetStore.currencyCode,
      });
      return Object.freeze({ collectItemId,
        count: intelligenceModule.enumerateSourceImageAssets({ sourceCapture }).length });
    });
    const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
    const enabledProfiles = profiles.filter((profile) => profile?.enabled === true);
    let channels = [];
    if (enabledProfiles.length === 1) {
      const listed = await settingsRepository.listProfileChannels({
        accountId,
        profileId: enabledProfiles[0].id,
        profileVersion: enabledProfiles[0].configVersion,
      });
      channels = listed?.channels || [];
    }
    const resumeRows = await pool.query(
      `SELECT job.id AS job_id,job.idempotency_key,item.id AS item_id,item.status AS item_status,
              item.status_version,snapshot.source_record_id AS collect_item_id,
              channel.channel_id,channel.assigned_status_version,
              (channel.execution_lease_expires_at IS NOT NULL
                AND channel.execution_lease_expires_at > NOW()) AS lease_active
         FROM auto_listing_jobs AS job
         JOIN auto_listing_job_items AS item
           ON item.account_id=job.account_id AND item.job_id=job.id
         JOIN auto_listing_source_snapshots AS snapshot
           ON snapshot.account_id=item.account_id AND snapshot.id=item.snapshot_id
         JOIN auto_listing_ai_profile_channels AS channel
           ON channel.account_id=job.account_id
          AND channel.profile_id=job.ai_profile_id
          AND channel.profile_version=job.ai_profile_version
          AND channel.assigned_job_id=job.id AND channel.assigned_item_id=item.id
        WHERE job.account_id=$1 AND job.idempotency_key=$2
          AND snapshot.source_type='COLLECT_BOX' AND snapshot.source_record_id=ANY($3::text[])
        ORDER BY item.id,channel.channel_order
        LIMIT 4`,
      [accountId, trialIdempotencyKey(collectItemIds), collectItemIds],
    );
    const resumeAssignments = (resumeRows.rows || []).map((resumeRow) => Object.freeze({
      idempotencyKey: resumeRow.idempotency_key,
      collectItemId: resumeRow.collect_item_id,
      jobId: resumeRow.job_id,
      itemId: resumeRow.item_id,
      itemStatus: resumeRow.item_status,
      itemStatusVersion: resumeRow.status_version,
      channelId: resumeRow.channel_id,
      assignedStatusVersion: resumeRow.assigned_status_version,
      leaseActive: resumeRow.lease_active,
    }));
    const resumeAssignment = collectItemIds.length === 1 && resumeAssignments.length === 1
      ? resumeAssignments[0] : null;
    const cleanupRows = await pool.query(
      `SELECT snapshot.source_record_id AS collect_item_id,
              COUNT(derivative.id)::INTEGER AS cleanup_attempts_reserved
         FROM auto_listing_jobs AS job
         JOIN auto_listing_job_items AS item
           ON item.account_id=job.account_id AND item.job_id=job.id
         JOIN auto_listing_source_snapshots AS snapshot
           ON snapshot.account_id=item.account_id AND snapshot.id=item.snapshot_id
         LEFT JOIN auto_listing_source_image_derivatives AS derivative
           ON derivative.account_id=item.account_id AND derivative.job_id=item.job_id
          AND derivative.item_id=item.id
          AND derivative.analysis_run_id=item.current_source_image_analysis_run_id
        WHERE job.account_id=$1 AND job.idempotency_key=$2
          AND snapshot.source_type='COLLECT_BOX' AND snapshot.source_record_id=ANY($3::text[])
        GROUP BY snapshot.source_record_id`,
      [accountId, trialIdempotencyKey(collectItemIds), collectItemIds],
    );
    const cleanupCountByCollectItem = new Map((cleanupRows.rows || []).map((row) => [
      row.collect_item_id,
      Number(row.cleanup_attempts_reserved),
    ]));
    const capturedSourceImagesWithCleanup = capturedSourceImages.map((row) => Object.freeze({
      ...row,
      cleanupAttemptsReserved: cleanupCountByCollectItem.get(row.collectItemId) || 0,
    }));
    return Object.freeze({
      accountId,
      preferences,
      uploadPolicy,
      profiles,
      channels,
      resumeAssignment,
      resumeAssignments: Object.freeze(resumeAssignments),
      capturedSourceImages: Object.freeze(capturedSourceImagesWithCleanup),
      ...(collectItemIds.length === 1 ? {
        capturedSourceImageCount: capturedSourceImagesWithCleanup[0].count,
        cleanupAttemptsReserved: capturedSourceImagesWithCleanup[0].cleanupAttemptsReserved,
      } : {}),
    });
  };

  const reloadUploadPolicy = ({ accountId }) => selectReviewPolicy(accountId);
  const runtimeEnv = Object.freeze({
    ...env,
    AUTO_LISTING_ENABLED: "true",
    AUTO_LISTING_AI_ENABLED: "true",
    AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1_ENABLED: "true",
    AUTO_LISTING_UPLOAD_ENABLED: "false",
    AUTO_LISTING_DIRECT_UPLOAD_ALLOWED: "false",
    LISTING_PIPELINE_V3: "1",
  });
  const gatewayFactory = async ({ paidCallBudget }) => runtimeModule.createAutoListingRuntime({
    env: runtimeEnv,
    getPostgresPool: async () => pool,
    createAiWorkerDependencies: async ({ env: workerEnv, resolvePool }) => wrapTrialProductionAiDependencies({
      dependencies: await aiCompositionModule.createDefaultAutoListingAiProductionDependencies({
        env: workerEnv,
        resolvePool,
      }),
      paidCallBudget,
    }),
    createAiOutboxRelay: ({ env: workerEnv, resolvePool }) =>
      aiCompositionModule.createDefaultAutoListingAiProductionOutboxRelay({
        env: workerEnv,
        resolvePool,
      }),
    callOzonSellerApi: ozonReadTransport,
  });
  const loadExecutionEvidence = async ({ accountId, jobId, itemIds, expectedConnections }) => {
    const [connectionsResult, attemptsResult] = await Promise.all([
      pool.query(
        `SELECT id,last_ai_connection_id,last_ai_connection_version
           FROM auto_listing_job_items
          WHERE account_id=$1 AND job_id=$2 AND id=ANY($3::text[])
          ORDER BY id`,
        [accountId, jobId, itemIds],
      ),
      pool.query(
        `SELECT item_id,'cleanup-edit:' || derivative_attempt_id AS attempt_id,
                edit_gateway_connection_id AS connection_id,
                edit_gateway_connection_version AS connection_version
           FROM auto_listing_source_image_derivatives
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND edit_gateway_request_id IS NOT NULL
            AND edit_gateway_connection_id IS NOT NULL AND edit_gateway_connection_version IS NOT NULL
         UNION ALL
         SELECT item_id,'cleanup-check:' || derivative_attempt_id AS attempt_id,
                checker_gateway_connection_id AS connection_id,
                checker_gateway_connection_version AS connection_version
           FROM auto_listing_source_image_derivatives
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND checker_gateway_request_id IS NOT NULL
            AND checker_gateway_connection_id IS NOT NULL
            AND checker_gateway_connection_version IS NOT NULL
         UNION ALL
         SELECT item_id,'image-generate:' || id AS attempt_id,
                gateway_connection_id AS connection_id,
                gateway_connection_version AS connection_version
           FROM ai_generation_assets
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND gateway_request_id IS NOT NULL
            AND gateway_connection_id IS NOT NULL AND gateway_connection_version IS NOT NULL
         UNION ALL
         SELECT item_id,'image-check:' || id AS attempt_id,
                checker_connection_id AS connection_id,
                checker_connection_version AS connection_version
           FROM ai_generation_assets
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND checker_request_id IS NOT NULL
            AND checker_connection_id IS NOT NULL AND checker_connection_version IS NOT NULL
         UNION ALL
         SELECT item_id,'plan:' || id AS attempt_id,
                gateway_connection_id AS connection_id,
                gateway_connection_version AS connection_version
           FROM auto_listing_content_plan_attempts
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND status='ACCEPTED'
            AND gateway_connection_id IS NOT NULL AND gateway_connection_version IS NOT NULL
         UNION ALL
         SELECT item_id,'group-check:' || id AS attempt_id,
                gateway_connection_id AS connection_id,
                gateway_connection_version AS connection_version
           FROM auto_listing_image_group_checks
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND gateway_request_id IS NOT NULL
            AND gateway_connection_id IS NOT NULL AND gateway_connection_version IS NOT NULL
         UNION ALL
         SELECT item_id,'rich-content:' || id AS attempt_id,
                gateway_connection_id AS connection_id,
                gateway_connection_version AS connection_version
           FROM ai_rich_content_results
          WHERE account_id=$1 AND job_id=$2 AND item_id=ANY($3::text[])
            AND gateway_request_id IS NOT NULL
            AND gateway_connection_id IS NOT NULL AND gateway_connection_version IS NOT NULL`,
        [accountId, jobId, itemIds],
      ),
    ]);
    return summarizeTrialExecutionEvidence({
      itemIds,
      expectedConnections,
      itemRows: connectionsResult.rows,
      attemptRows: attemptsResult.rows,
    });
  };
  const runTrial = async ({ gateway: runtime, collectItemIds, preflight, paidCallBudget }) => {
    const { accountId, preferences } = preflight;
    const actor = Object.freeze({ id: accountId, role: "user" });
    const service = await runtime.getService();
    const config = {
      targetStoreId: preferences.targetStoreId,
      targetWarehouseId: preferences.targetWarehouseId,
      stock: preferences.stock,
      priceAdjustmentKopecks: preferences.priceAdjustmentKopecks,
      priceMultiplierMicros: preferences.priceMultiplierMicros,
      image: {
        ...preferences.image,
        roles: {
          main: 1,
          sellingPoint: 1,
          detail: 1,
          scene: 1,
          specification: 1,
          infographic: 1,
        },
      },
      ...(preferences.brandMode ? { brandMode: preferences.brandMode } : {}),
      ...(typeof preferences.useCategoryStrategy === "boolean"
        ? { useCategoryStrategy: preferences.useCategoryStrategy } : {}),
    };
    const created = await service.createAutoListingJob({
      actor,
      collectItemIds,
      idempotencyKey: trialIdempotencyKey(collectItemIds),
      correlationId: trialIdempotencyKey(collectItemIds),
      config,
    });
    if ((await selectReviewPolicy(accountId)).mode !== "REVIEW") {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_REVIEW_UPLOAD_REQUIRED", "The persisted upload policy changed after task creation");
    }
    const jobId = created?.jobId;
    if (typeof jobId !== "string") {
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_JOB_INVALID", "The trial task was not created");
    }
    await runtime.startAiWorker();
    const deadline = Date.now() + 30 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        const job = await service.getAutoListingJob({ actor, jobId });
        const items = selectTrialJobItems(job, collectItemIds);
        if (items.length === collectItemIds.length
          && items.every((item) => ["READY_FOR_REVIEW", "BLOCKED"].includes(item.status))) {
          if (ozonWriter.calls.length !== 0) {
            throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_OZON_WRITE_FORBIDDEN", "The Ozon stub recorded a forbidden call");
          }
          const itemIds = Object.freeze(items.map((item) => item.itemId || item.id));
          const itemStatuses = Object.freeze(items.map(({ status }) => status));
          const executionEvidence = await loadExecutionEvidence({
            accountId,
            jobId,
            itemIds,
            expectedConnections: preflight.channels.filter((channel) =>
              channel.enabled === true && channel.requiresRevalidation === false).map((channel) => ({
              connectionId: channel.connectionId,
              connectionVersion: channel.connectionVersion,
            })),
          });
          return Object.freeze({
            status: itemStatuses.every((status) => status === "READY_FOR_REVIEW")
              ? "READY_FOR_REVIEW" : "BLOCKED",
            jobId,
            itemIds,
            itemStatuses,
            ...(items.length === 1 ? { itemId: items[0].itemId || items[0].id } : {}),
            executionEvidence,
            ozonReadCalls: ozonReadTransport.calls.length, ozonWriteCalls: 0,
            paidCalls: paidCallBudget.snapshot().paidCalls,
            paidCallsByKind: paidCallBudget.snapshot().callsByKind,
          });
        }
        if (items.some((item) => TRIAL_FORBIDDEN_UPLOAD_ITEM_STATUSES.has(item?.status))
          || trialBatchHasSettledFailure(items, collectItemIds.length)) {
          throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_TERMINAL_INVALID", "The trial stopped outside review");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw trialError("AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_TIMEOUT", "The trial did not reach review before the deadline");
    } finally {
      await runtime.stopAiWorker();
    }
  };
  return Object.freeze({ loadPreflight, reloadUploadPolicy, gatewayFactory, runTrial });
}

async function main() {
  try {
    await runGuardedTrial({
      argv: process.argv.slice(2),
      env: process.env,
      uploadStrategy: "REVIEW",
      ozonWriter: createThrowingOzonWriter(),
    });
  } finally {
    if (typeof closeProductionTrialPool === "function") await closeProductionTrialPool();
    closeProductionTrialPool = null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_TRIAL_FAILED"}\n`);
    process.exitCode = 1;
  });
}
