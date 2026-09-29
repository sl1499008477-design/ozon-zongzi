import crypto from "node:crypto";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  verifySourceImageAssessment,
  verifySourceImageIntelligenceSummary,
} from "./auto-listing-source-image-intelligence-contract.mjs";
import {
  AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION,
  autoListingAiMessageDedupeKey,
  autoListingAiMessagePhaseTarget,
  canonicalizeAutoListingAiMessage,
} from "./auto-listing-ai-message.mjs";
import { assertAutoListingTransition } from "./auto-listing-state-machine.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const DECISIONS = new Set(["PRODUCT_MARKING", "EXTERNAL_OVERLAY_EXCLUDE", "UNRESOLVED_EXCLUDE"]);
const UNAVAILABLE = new Set(["DOWNLOAD_FAILED", "UNSUPPORTED_MEDIA"]);
const BATCH_TERMINAL = new Set(["ANALYZED", "DUPLICATE_REUSED", "CONFIRMATION_REQUIRED"]);
const TERMINAL_RUN = new Set(["ACCEPTED", "CONFIRMATION_REQUIRED", "FAILED"]);
const RUN_KEYS = new Set([
  "accountId", "jobId", "itemId", "sourceSnapshotId", "expectedStatusVersion", "contractVersion",
  "sourceSnapshotHash", "sourceAssetSetHash", "inputHash", "promptTemplateVersion", "profileId",
  "profileVersion", "modelName", "expectedAssetCount",
]);
const SCOPE_KEYS = new Set(["accountId", "jobId", "itemId", "analysisRunId", "expectedStatusVersion"]);
const MATERIALIZED_KEYS = new Set([
  ...SCOPE_KEYS, "sourceAssetId", "sourceOrdinal", "sourceRefHash", "objectKey", "contentHash", "contentType", "sizeBytes",
]);
const UNAVAILABLE_KEYS = new Set([...SCOPE_KEYS, "sourceAssetId", "sourceOrdinal", "terminalStatus", "errorCode"]);
const BATCH_KEYS = new Set([...SCOPE_KEYS, "analysisBatchId", "inputHash", "resultHash", "assessments"]);
const SUMMARY_KEYS = new Set([...SCOPE_KEYS, "inputHash", "summary"]);
const DECISION_KEYS = new Set([...SCOPE_KEYS, "sourceAssetId", "decision", "idempotencyKey", "correlationId"]);
const FACTORY_KEYS = new Set(["now", "id", "token"]);

function repositoryError(code = "AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED") {
  const error = new Error(code);
  error.code = code;
  error.retryable = code === "AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED";
  return error;
}

const clone = (value) => structuredClone(value);
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exactObject(value, keys) {
  try {
    return plainObject(value) && Reflect.ownKeys(value).length === keys.size
      && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
  } catch { return false; }
}
function safeIdentifier(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 240 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token/iu.test(value);
}
function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_REPOSITORY_FAILED");
  return date;
}
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const itemKey = (value) => [value.accountId, value.jobId, value.itemId].join("\u0001");
const runKey = (value) => [value.accountId, value.jobId, value.itemId, value.analysisRunId ?? value.id].join("\u0001");
const assetKey = (value) => `${runKey(value)}\u0001${value.sourceAssetId}`;

function validateIdentifiers(input, keys) {
  if (!keys.every((key) => safeIdentifier(input[key]))) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
}
function validateVersion(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
}
function validateScope(input) {
  if (!exactObject(input, SCOPE_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "analysisRunId"]);
  validateVersion(input.expectedStatusVersion);
  return input;
}
function validateRun(input) {
  if (!exactObject(input, RUN_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "sourceSnapshotId", "promptTemplateVersion", "profileId", "modelName"]);
  validateVersion(input.expectedStatusVersion);
  validateVersion(input.profileVersion);
  if (input.contractVersion !== SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION
    || ![input.sourceSnapshotHash, input.sourceAssetSetHash, input.inputHash].every((value) => HASH.test(value || ""))
    || !Number.isInteger(input.expectedAssetCount) || input.expectedAssetCount < 1 || input.expectedAssetCount > 10_000) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
  return input;
}
function validateMaterialized(input) {
  if (!exactObject(input, MATERIALIZED_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId"]);
  validateVersion(input.expectedStatusVersion);
  if (!Number.isSafeInteger(input.sourceOrdinal) || input.sourceOrdinal < 0 || input.sourceOrdinal > 9999
    || !HASH.test(input.sourceRefHash || "")
    || !HASH.test(input.contentHash || "") || !["image/png", "image/jpeg", "image/webp"].includes(input.contentType)
    || typeof input.objectKey !== "string" || !input.objectKey.startsWith("auto-listing/source/v2/")
    || Buffer.byteLength(input.objectKey, "utf8") > 2048 || /[?#]/u.test(input.objectKey)
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 8 * 1024 * 1024) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
  return input;
}
function validateUnavailable(input) {
  if (!exactObject(input, UNAVAILABLE_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId"]);
  validateVersion(input.expectedStatusVersion);
  if (!Number.isSafeInteger(input.sourceOrdinal) || input.sourceOrdinal < 0 || input.sourceOrdinal > 9999
    || !UNAVAILABLE.has(input.terminalStatus) || !ERROR_CODE.test(input.errorCode || "")) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
  return input;
}
function validateBatch(input) {
  if (!exactObject(input, BATCH_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "analysisRunId", "analysisBatchId"]);
  validateVersion(input.expectedStatusVersion);
  if (!HASH.test(input.inputHash || "") || !HASH.test(input.resultHash || "") || !Array.isArray(input.assessments)
    || input.assessments.length < 1 || input.assessments.length > 6) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  let assessments;
  try { assessments = input.assessments.map(verifySourceImageAssessment); }
  catch { throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID"); }
  if (new Set(assessments.map((entry) => entry.sourceAssetId)).size !== assessments.length) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
  if (new Set(assessments.map((entry) => entry.sourceOrdinal)).size !== assessments.length
    || assessments.some((entry) => !Number.isSafeInteger(entry.sourceOrdinal)
      || entry.sourceOrdinal < 0 || entry.sourceOrdinal > 9999
      || !BATCH_TERMINAL.has(entry.terminalStatus) || typeof entry.objectKey !== "string"
      || !HASH.test(entry.contentHash || ""))) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  return { ...input, assessments };
}
function validateSummary(input) {
  if (!exactObject(input, SUMMARY_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "analysisRunId"]);
  validateVersion(input.expectedStatusVersion);
  if (!HASH.test(input.inputHash || "")) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  let summary;
  try { summary = verifySourceImageIntelligenceSummary(input.summary); }
  catch { throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID"); }
  return { ...input, summary };
}
function validateDecision(input) {
  if (!exactObject(input, DECISION_KEYS)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  validateIdentifiers(input, ["accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId", "idempotencyKey", "correlationId"]);
  validateVersion(input.expectedStatusVersion);
  if (!DECISIONS.has(input.decision)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  return input;
}
function confirmationAssetIds(summary) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.requiredConfirmations)) return new Set();
  return new Set(summary.requiredConfirmations.map((entry) => typeof entry === "string" ? entry : entry?.sourceAssetId)
    .filter(safeIdentifier));
}
function verifiedAcceptedSummary(run) {
  if (!run?.summary || !HASH.test(run.summaryHash || "")) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
  }
  let summary;
  try { summary = verifySourceImageIntelligenceSummary(run.summary); }
  catch { throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT"); }
  if (summary.summaryHash !== run.summaryHash) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
  return summary;
}
function decisionBusiness(input) {
  const { correlationId: ignored, ...business } = input;
  return business;
}
function reconcileMessage(input, analysisRunId, expectedStatusVersion) {
  return Object.freeze({
    contractVersion: AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION,
    accountId: input.accountId,
    itemId: input.itemId,
    phase: "RECONCILE_SOURCE_IMAGE_ANALYSIS",
    expectedStatusVersion,
    correlationId: input.correlationId,
    analysisRunId,
  });
}
function publicRun(row) {
  return clone({
    id: row.id, accountId: row.accountId, jobId: row.jobId, itemId: row.itemId,
    sourceSnapshotId: row.sourceSnapshotId, expectedStatusVersion: row.expectedStatusVersion,
    contractVersion: row.contractVersion, sourceSnapshotHash: row.sourceSnapshotHash,
    sourceAssetSetHash: row.sourceAssetSetHash, inputHash: row.inputHash,
    promptTemplateVersion: row.promptTemplateVersion, profileId: row.profileId,
    profileVersion: row.profileVersion, modelName: row.modelName,
    expectedAssetCount: row.expectedAssetCount, terminalAssetCount: row.terminalAssetCount,
    status: row.status, parentRunId: row.parentRunId, derivationKind: row.derivationKind,
    summaryHash: row.summaryHash, summary: row.summary, createdAt: row.createdAt,
    completedAt: row.completedAt,
  });
}
function publicAssessment(row) {
  return clone({
    accountId: row.accountId, jobId: row.jobId, itemId: row.itemId, analysisRunId: row.analysisRunId,
    expectedStatusVersion: row.expectedStatusVersion, sourceAssetId: row.sourceAssetId,
    sourceOrdinal: row.sourceOrdinal, terminalStatus: row.terminalStatus, analysisBatchId: row.analysisBatchId,
    inputHash: row.inputHash, resultHash: row.resultHash, assessment: row.assessment,
    errorCode: row.errorCode, createdAt: row.createdAt,
  });
}
function publicDecision(row) { return clone(row); }
const sameRunInput = (row, input) => [...RUN_KEYS].every((key) => row[key] === input[key]);
function createGenerated(factory, kind) {
  let value;
  try { value = factory(kind); } catch { throw repositoryError(); }
  if (!safeIdentifier(value)) throw repositoryError();
  return value;
}
function requireWritableRun(run) {
  if (TERMINAL_RUN.has(run.status)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_RUN_TERMINAL");
}
function unresolvedConfirmations(summary, decisionSet = []) {
  const decided = new Set(decisionSet.map((entry) => entry.sourceAssetId));
  return summary.requiredConfirmations.some((entry) => {
    const sourceAssetId = typeof entry === "string" ? entry : entry?.sourceAssetId;
    return !safeIdentifier(sourceAssetId) || !decided.has(sourceAssetId);
  });
}
function runForScope(runs, input) {
  const direct = runs.get(runKey(input));
  if (direct && direct.expectedStatusVersion === input.expectedStatusVersion) return direct;
  const sameId = [...runs.values()].some((run) => run.id === input.analysisRunId);
  throw repositoryError(sameId ? "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT" : "AUTO_LISTING_SOURCE_IMAGE_RUN_NOT_FOUND");
}

export function createMemorySourceImageIntelligenceRepository(options = {}) {
  if (!plainObject(options) || Object.keys(options).some((key) => !FACTORY_KEYS.has(key))) {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
  const now = options.now ?? (() => new Date());
  const id = options.id ?? ((kind) => `${kind}-${crypto.randomUUID()}`);
  const token = options.token ?? (() => crypto.randomUUID());
  if (![now, id, token].every((entry) => typeof entry === "function")) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  const runs = new Map();
  const items = new Map();
  const materialized = new Map();
  const assessments = new Map();
  const batches = new Map();
  const decisions = new Map();

  function timestamp() { return validDate(now()).toISOString(); }
  function assertCurrent(input, run) {
    const item = items.get(itemKey(input));
    if (!item || item.currentRunId !== run.id || item.statusVersion !== input.expectedStatusVersion) {
      throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_STALE");
    }
  }
  function updateRunProgress(run) {
    const terminal = [...assessments.values()].filter((entry) => runKey(entry) === runKey(run)).length;
    run.terminalAssetCount = terminal;
    if (!["ACCEPTED", "CONFIRMATION_REQUIRED"].includes(run.status)) {
      run.status = terminal === run.expectedAssetCount ? "RECONCILING" : "ANALYZING";
    }
  }

  return Object.freeze({
    async reserveAnalysisRun(rawInput) {
      const input = validateRun(rawInput);
      const key = itemKey(input);
      const item = items.get(key);
      if (item) {
        const current = [...runs.values()].find((run) => run.id === item.currentRunId && itemKey(run) === key);
        if (item.statusVersion === input.expectedStatusVersion && current && sameRunInput(current, input)) return publicRun(current);
        throw repositoryError(item.accountId === input.accountId ? "AUTO_LISTING_SOURCE_IMAGE_RUN_CONFLICT" : "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT");
      }
      const createdAt = timestamp();
      const row = {
        ...clone(input), id: createGenerated(id, "source-image-run"), status: "MATERIALIZING",
        terminalAssetCount: 0, parentRunId: null, derivationKind: "INITIAL", summary: null,
        summaryHash: null, decisionSet: [], decisionSetHash: digest([]), createdAt, completedAt: null,
      };
      runs.set(runKey(row), row);
      items.set(key, {
        accountId: input.accountId, status: "PLANNING", statusVersion: input.expectedStatusVersion,
        failureCode: null, recoveryPoint: null, currentRunId: row.id,
      });
      return publicRun(row);
    },

    async markAssetMaterialized(rawInput) {
      const input = validateMaterialized(rawInput);
      const run = runForScope(runs, input); assertCurrent(input, run);
      const key = assetKey(input); const existing = materialized.get(key);
      if (existing) {
        if (!same(existing.input, input)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
        return clone(existing.output);
      }
      requireWritableRun(run);
      if (assessments.has(key)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
      if ([...materialized.values()].some((entry) => runKey(entry.input) === runKey(input)
        && entry.input.sourceAssetId !== input.sourceAssetId && entry.input.sourceOrdinal === input.sourceOrdinal)
        || [...assessments.values()].some((entry) => runKey(entry) === runKey(input)
          && entry.sourceAssetId !== input.sourceAssetId && entry.sourceOrdinal === input.sourceOrdinal)) {
        throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
      }
      const output = { ...clone(input), status: "MATERIALIZED", materializedAt: timestamp() };
      materialized.set(key, { input: clone(input), output });
      run.status = "ANALYZING";
      return clone(output);
    },

    async markAssetUnavailable(rawInput) {
      const input = validateUnavailable(rawInput);
      const run = runForScope(runs, input); assertCurrent(input, run);
      const key = assetKey(input); const existing = assessments.get(key);
      const resultHash = digest({ sourceAssetId: input.sourceAssetId, sourceOrdinal: input.sourceOrdinal,
        terminalStatus: input.terminalStatus, errorCode: input.errorCode });
      if (existing) {
        if (existing.resultHash !== resultHash) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
        return publicAssessment(existing);
      }
      requireWritableRun(run);
      const stored = materialized.get(key);
      if ((stored && stored.input.sourceOrdinal !== input.sourceOrdinal)
        || [...materialized.values()].some((entry) => runKey(entry.input) === runKey(input)
          && entry.input.sourceAssetId !== input.sourceAssetId && entry.input.sourceOrdinal === input.sourceOrdinal)
        || [...assessments.values()].some((entry) => runKey(entry) === runKey(input)
          && entry.sourceAssetId !== input.sourceAssetId && entry.sourceOrdinal === input.sourceOrdinal)) {
        throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
      }
      const row = {
        ...clone(input),
        analysisBatchId: null, inputHash: null, resultHash,
        assessment: null, createdAt: timestamp(),
      };
      assessments.set(key, row); updateRunProgress(run);
      return publicAssessment(row);
    },

    async recordBatchAssessments(rawInput) {
      const input = validateBatch(rawInput);
      const run = runForScope(runs, input); assertCurrent(input, run);
      const batchKey = `${runKey(input)}\u0001${input.analysisBatchId}`;
      const oldBatch = batches.get(batchKey);
      if (oldBatch) {
        if (oldBatch.inputHash !== input.inputHash || oldBatch.resultHash !== input.resultHash
          || !same(oldBatch.assessmentHashes, input.assessments.map((entry) => entry.assessmentHash))) {
          throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_BATCH_CONFLICT");
        }
        return clone({ status: "EXISTING_ACCEPTED", analysisBatchId: input.analysisBatchId, inputHash: input.inputHash,
          resultHash: input.resultHash, assessmentCount: input.assessments.length });
      }
      requireWritableRun(run);
      for (const entry of input.assessments) {
        const key = assetKey({ ...input, sourceAssetId: entry.sourceAssetId });
        const existing = assessments.get(key);
        if (existing) {
          throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
        }
        const stored = materialized.get(key)?.input;
        if (stored && (stored.sourceOrdinal !== entry.sourceOrdinal || stored.objectKey !== entry.objectKey
          || stored.contentHash !== entry.contentHash)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
        if ([...assessments.values()].some((row) => runKey(row) === runKey(input)
          && row.sourceAssetId !== entry.sourceAssetId && row.sourceOrdinal === entry.sourceOrdinal)
          || [...materialized.values()].some((row) => runKey(row.input) === runKey(input)
            && row.input.sourceAssetId !== entry.sourceAssetId && row.input.sourceOrdinal === entry.sourceOrdinal)) {
          throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
        }
      }
      const createdAt = timestamp();
      for (const entry of input.assessments) {
        const key = assetKey({ ...input, sourceAssetId: entry.sourceAssetId });
        if (!assessments.has(key)) assessments.set(key, {
          accountId: input.accountId, jobId: input.jobId, itemId: input.itemId,
          analysisRunId: input.analysisRunId, expectedStatusVersion: input.expectedStatusVersion,
          sourceAssetId: entry.sourceAssetId, sourceOrdinal: entry.sourceOrdinal,
          terminalStatus: entry.terminalStatus, analysisBatchId: input.analysisBatchId,
          inputHash: input.inputHash, resultHash: entry.assessmentHash, assessment: clone(entry),
          errorCode: null, createdAt,
        });
      }
      batches.set(batchKey, { inputHash: input.inputHash, resultHash: input.resultHash,
        assessmentHashes: input.assessments.map((entry) => entry.assessmentHash) });
      updateRunProgress(run);
      return { status: "ACCEPTED", analysisBatchId: input.analysisBatchId, inputHash: input.inputHash,
        resultHash: input.resultHash, assessmentCount: input.assessments.length };
    },

    async listRunAssessments(rawInput) {
      const input = validateScope(rawInput); runForScope(runs, input);
      return [...assessments.values()].filter((row) => runKey(row) === runKey(input))
        .sort((left, right) => (left.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrdinal ?? Number.MAX_SAFE_INTEGER)
          || left.sourceAssetId.localeCompare(right.sourceAssetId)).map(publicAssessment);
    },

    async acceptSummary(rawInput) {
      const input = validateSummary(rawInput);
      const run = runForScope(runs, input); updateRunProgress(run);
      if (run.summaryHash !== null) {
        if (run.summaryHash !== input.summary.summaryHash || run.summaryInputHash !== input.inputHash) {
          throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_SUMMARY_CONFLICT");
        }
        return publicRun(run);
      }
      assertCurrent(input, run);
      if (run.terminalAssetCount !== run.expectedAssetCount) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_TERMINAL_COUNT_MISMATCH");
      run.summary = clone(input.summary); run.summaryHash = input.summary.summaryHash; run.summaryInputHash = input.inputHash;
      run.status = unresolvedConfirmations(input.summary, run.decisionSet) ? "CONFIRMATION_REQUIRED" : "ACCEPTED";
      run.completedAt = timestamp();
      if (run.status === "CONFIRMATION_REQUIRED") {
        const item = items.get(itemKey(input));
        if (item?.currentRunId === run.id && item.statusVersion === run.expectedStatusVersion) {
          item.status = "BLOCKED";
          item.statusVersion = run.expectedStatusVersion + 1;
          item.failureCode = "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED";
          item.recoveryPoint = null;
        }
      }
      return publicRun(run);
    },

    async recordSourceImageDecision(rawInput) {
      const input = validateDecision(rawInput);
      const decisionKey = `${input.accountId}\u0001${input.idempotencyKey}`;
      const replay = decisions.get(decisionKey);
      if (replay) {
        if (!same(replay.business, decisionBusiness(input))) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
        return clone(replay.output);
      }
      const parent = [...runs.values()].find((run) => run.id === input.analysisRunId
        && run.accountId === input.accountId && run.jobId === input.jobId && run.itemId === input.itemId);
      if (!parent) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_RUN_NOT_FOUND");
      const item = items.get(itemKey(input));
      if (!item || item.currentRunId !== parent.id || item.status !== "BLOCKED"
        || item.failureCode !== "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED"
        || item.statusVersion !== input.expectedStatusVersion) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_STALE");
      if (parent.status !== "CONFIRMATION_REQUIRED") throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
      const acceptedSummary = verifiedAcceptedSummary(parent);
      if (!confirmationAssetIds(acceptedSummary).has(input.sourceAssetId)) {
        throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
      }
      const target = assessments.get(assetKey(input));
      if (!target) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
      const createdAt = timestamp();
      const decision = {
        id: createGenerated(id, "source-image-decision"), accountId: input.accountId, jobId: input.jobId,
        itemId: input.itemId, analysisRunId: input.analysisRunId, expectedStatusVersion: input.expectedStatusVersion,
        sourceAssetId: input.sourceAssetId, decision: input.decision, idempotencyKey: input.idempotencyKey,
        decisionHash: digest({ analysisRunId: input.analysisRunId, expectedStatusVersion: input.expectedStatusVersion,
          sourceAssetId: input.sourceAssetId, decision: input.decision, idempotencyKey: input.idempotencyKey }), createdAt,
      };
      const decisionSet = [...parent.decisionSet, { sourceAssetId: input.sourceAssetId, decision: input.decision,
        decisionHash: decision.decisionHash }].sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId));
      const nextVersion = item.statusVersion + 1;
      validateVersion(nextVersion);
      createGenerated(token, "source-image-decision-token");
      const derived = {
        ...clone(parent), id: createGenerated(id, "source-image-run"), expectedStatusVersion: nextVersion,
        inputHash: digest({ parentInputHash: parent.inputHash, decisions: decisionSet }), status: "RECONCILING",
        parentRunId: parent.id, derivationKind: "MANUAL_DECISION", summary: null, summaryHash: null,
        summaryInputHash: null, decisionSet, decisionSetHash: digest(decisionSet), createdAt, completedAt: null,
      };
      runs.set(runKey(derived), derived);
      for (const assessmentRow of [...assessments.values()].filter((row) => runKey(row) === runKey(parent))) {
        const copied = { ...clone(assessmentRow), analysisRunId: derived.id,
          expectedStatusVersion: nextVersion, createdAt };
        assessments.set(assetKey(copied), copied);
      }
      assertAutoListingTransition("BLOCKED", "SOURCE_IMAGE_DECISION_ACCEPTED", "PLANNING");
      const event = Object.freeze({ eventType: "SOURCE_IMAGE_DECISION_ACCEPTED", fromStatus: "BLOCKED",
        toStatus: "PLANNING", transitionVersion: nextVersion, correlationId: input.correlationId });
      const message = reconcileMessage(input, derived.id, nextVersion);
      const outbox = Object.freeze({ phase: message.phase, analysisRunId: derived.id,
        expectedStatusVersion: nextVersion, dedupeKey: autoListingAiMessageDedupeKey(message), correlationId: input.correlationId });
      items.set(itemKey(input), { accountId: input.accountId, status: "PLANNING", statusVersion: nextVersion,
        failureCode: null, recoveryPoint: null, currentRunId: derived.id });
      const output = { decision: publicDecision(decision), derivedRun: publicRun(derived),
        item: { status: "PLANNING", statusVersion: nextVersion }, event, outbox };
      decisions.set(decisionKey, { business: clone(decisionBusiness(input)), output: clone(output) });
      return output;
    },

    async loadAcceptedSummary(rawInput) {
      const input = validateScope(rawInput);
      const run = runForScope(runs, input);
      return run.summaryHash === null ? null : publicRun(run);
    },
  });
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    sourceSnapshotId: row.source_snapshot_id, expectedStatusVersion: row.expected_status_version,
    contractVersion: row.intelligence_contract_version, sourceSnapshotHash: row.source_snapshot_hash,
    sourceAssetSetHash: row.source_asset_set_hash, inputHash: row.input_hash,
    promptTemplateVersion: row.prompt_template_version, profileId: row.profile_id,
    profileVersion: row.profile_version, modelName: row.model_name,
    expectedAssetCount: row.expected_asset_count, terminalAssetCount: row.terminal_asset_count,
    status: row.status, parentRunId: row.parent_run_id, derivationKind: row.derivation_kind,
    summary: row.summary, summaryHash: row.summary_hash, summaryInputHash: row.summary_input_hash,
    decisionSet: row.decision_set, decisionSetHash: row.decision_set_hash,
    createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
function mapAssessment(row) {
  return {
    accountId: row.account_id, jobId: row.job_id, itemId: row.item_id, analysisRunId: row.analysis_run_id,
    expectedStatusVersion: row.expected_status_version, sourceAssetId: row.source_asset_id,
    sourceOrdinal: row.source_ordinal, terminalStatus: row.terminal_status, analysisBatchId: row.analysis_batch_id,
    inputHash: row.input_hash, resultHash: row.result_hash, assessment: row.assessment,
    errorCode: row.error_code, createdAt: new Date(row.created_at).toISOString(),
  };
}
function mapDecision(row) {
  return {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    analysisRunId: row.analysis_run_id, expectedStatusVersion: row.expected_status_version,
    sourceAssetId: row.source_asset_id, decision: row.decision, idempotencyKey: row.idempotency_key,
    decisionHash: row.decision_hash, createdAt: new Date(row.created_at).toISOString(),
  };
}
async function transaction(pool, work) {
  let client;
  try {
    client = await pool.connect(); await client.query("BEGIN");
    const output = await work(client); await client.query("COMMIT"); return output;
  } catch (caught) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (caught?.code?.startsWith?.("AUTO_LISTING_")) throw caught;
    if (["23503", "23514"].includes(caught?.code)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT");
    if (caught?.code === "23505") throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_RUN_CONFLICT");
    throw repositoryError();
  } finally { client?.release(); }
}
async function lockedRun(client, input) {
  const result = await client.query(
    `SELECT * FROM auto_listing_source_image_analysis_runs
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4 AND expected_status_version=$5 FOR UPDATE`,
    [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.expectedStatusVersion],
  );
  if (result.rowCount === 1) return mapRun(result.rows[0]);
  const exists = await client.query("SELECT 1 FROM auto_listing_source_image_analysis_runs WHERE id=$1", [input.analysisRunId]);
  throw repositoryError(exists.rowCount ? "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT" : "AUTO_LISTING_SOURCE_IMAGE_RUN_NOT_FOUND");
}
async function lockCurrentItem(client, input, run) {
  const item = await client.query(
    `SELECT status_version,current_source_image_analysis_run_id FROM auto_listing_job_items
      WHERE account_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE`, [input.accountId, input.jobId, input.itemId],
  );
  if (item.rowCount !== 1) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT");
  if (item.rows[0].status_version !== input.expectedStatusVersion
    || item.rows[0].current_source_image_analysis_run_id !== run.id) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_STALE");
  return item.rows[0];
}

async function lockedDecisionRun(client, input) {
  const result = await client.query(
    `SELECT * FROM auto_listing_source_image_analysis_runs
      WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND id=$4 FOR UPDATE`,
    [input.accountId, input.jobId, input.itemId, input.analysisRunId],
  );
  if (result.rowCount === 1) return mapRun(result.rows[0]);
  const exists = await client.query("SELECT 1 FROM auto_listing_source_image_analysis_runs WHERE id=$1", [input.analysisRunId]);
  throw repositoryError(exists.rowCount ? "AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT" : "AUTO_LISTING_SOURCE_IMAGE_RUN_NOT_FOUND");
}

async function lockDecisionItem(client, input, run) {
  const result = await client.query(
    `SELECT status,status_version,failure_code,recovery_point,current_source_image_analysis_run_id
       FROM auto_listing_job_items WHERE account_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE`,
    [input.accountId, input.jobId, input.itemId],
  );
  const item = result.rows[0];
  if (!item) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT");
  if (item.status_version !== input.expectedStatusVersion
    || item.current_source_image_analysis_run_id !== run.id) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_STALE");
  if (item.status !== "BLOCKED"
    || item.failure_code !== "AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED") {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
  }
  return item;
}

function deterministicId(prefix, identity) {
  return `${prefix}-${crypto.createHash("sha256").update(String(identity), "utf8").digest("hex")}`;
}

async function insertDecisionEvent(client, input, decisionHash, derivedRunId, transitionVersion, createdAt) {
  const details = { analysisRunId: input.analysisRunId, derivedRunId, sourceAssetId: input.sourceAssetId, decisionHash };
  const eventId = deterministicId("source-image-decision-event",
    [input.accountId, input.jobId, input.itemId, input.idempotencyKey].join("\u0000"));
  const result = await client.query(
    `INSERT INTO auto_listing_events (
       id,account_id,job_id,item_id,actor_account_id,from_status,to_status,event_type,
       correlation_id,details,transition_version,created_at
     ) VALUES ($1,$2,$3,$4,$2,'BLOCKED','PLANNING','SOURCE_IMAGE_DECISION_ACCEPTED',$5,$6::JSONB,$7,$8)
     RETURNING event_type,from_status,to_status,transition_version,correlation_id`,
    [eventId, input.accountId, input.jobId, input.itemId, input.correlationId,
      JSON.stringify(details), transitionVersion, createdAt],
  );
  if (result.rowCount !== 1) throw repositoryError();
  return result.rows[0];
}

async function insertDecisionOutbox(client, input, derivedRunId, transitionVersion, createdAt) {
  const message = reconcileMessage(input, derivedRunId, transitionVersion);
  const dedupeKey = autoListingAiMessageDedupeKey(message);
  const target = autoListingAiMessagePhaseTarget(message);
  const result = await client.query(
    `INSERT INTO auto_listing_ai_outbox (
       id,account_id,job_id,item_id,slot_key,event_type,dedupe_key,payload,state,attempts,available_at,
       contract_version,phase,phase_target_id,expected_status_version,correlation_id,next_retry_at,
       lease_owner,lease_token,lease_expires_at,publication_id,published_at,dead_at,last_error_code,last_error_safe
     ) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7::JSONB,'PENDING',0,$11,$8,$5,$9,$10,$12,$11,
       NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)
     RETURNING phase,phase_target_id,expected_status_version,correlation_id,dedupe_key`,
    [deterministicId("ai-outbox", dedupeKey), input.accountId, input.jobId, input.itemId,
      message.phase, dedupeKey, canonicalizeAutoListingAiMessage(message), message.contractVersion,
      target, transitionVersion, createdAt, input.correlationId],
  );
  if (result.rowCount !== 1) throw repositoryError();
  return result.rows[0];
}

export function createPostgresSourceImageIntelligenceRepository({ pool, now = () => new Date(), id, token } = {}) {
  const createId = id ?? ((kind) => `${kind}-${crypto.randomUUID()}`);
  const createToken = token ?? (() => crypto.randomUUID());
  if (!pool || typeof pool.connect !== "function" || typeof now !== "function"
    || typeof createId !== "function" || typeof createToken !== "function") {
    throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID");
  }
  const at = () => validDate(now());
  const api = {
    async reserveAnalysisRun(rawInput) {
      const input = validateRun(rawInput);
      return transaction(pool, async (client) => {
        const item = await client.query(
          `SELECT status_version,current_source_image_analysis_run_id FROM auto_listing_job_items
            WHERE account_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE`, [input.accountId, input.jobId, input.itemId],
        );
        if (item.rowCount !== 1) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_SCOPE_CONFLICT");
        if (item.rows[0].status_version !== input.expectedStatusVersion) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_STALE");
        const existing = await client.query(
          `SELECT * FROM auto_listing_source_image_analysis_runs
            WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND expected_status_version=$4 AND input_hash=$5`,
          [input.accountId, input.jobId, input.itemId, input.expectedStatusVersion, input.inputHash],
        );
        if (existing.rowCount === 1) {
          const run = mapRun(existing.rows[0]);
          if (!sameRunInput(run, input)) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_RUN_CONFLICT");
          return publicRun(run);
        }
        if (item.rows[0].current_source_image_analysis_run_id !== null) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_RUN_CONFLICT");
        const runId = createGenerated(createId, "source-image-run"); const createdAt = at();
        const inserted = await client.query(
          `INSERT INTO auto_listing_source_image_analysis_runs (
            id,account_id,job_id,item_id,source_snapshot_id,expected_status_version,intelligence_contract_version,
            source_snapshot_hash,source_asset_set_hash,input_hash,prompt_template_version,profile_id,profile_version,
            model_name,expected_asset_count,status,parent_run_id,derivation_kind,decision_set,decision_set_hash,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'MATERIALIZING',NULL,'INITIAL','[]'::jsonb,$16,$17)
          RETURNING *`, [runId, input.accountId, input.jobId, input.itemId, input.sourceSnapshotId,
            input.expectedStatusVersion, input.contractVersion, input.sourceSnapshotHash, input.sourceAssetSetHash,
            input.inputHash, input.promptTemplateVersion, input.profileId, input.profileVersion, input.modelName,
            input.expectedAssetCount, digest([]), createdAt],
        );
        await client.query(
          `UPDATE auto_listing_job_items SET current_source_image_analysis_run_id=$4
            WHERE account_id=$1 AND job_id=$2 AND id=$3`, [input.accountId, input.jobId, input.itemId, runId],
        );
        return publicRun(mapRun(inserted.rows[0]));
      });
    },
    async markAssetMaterialized(rawInput) {
      const input = validateMaterialized(rawInput);
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, input); await lockCurrentItem(client, input, run);
        const existing = await client.query(
          `SELECT * FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND analysis_run_id=$4 AND source_asset_id=$5 FOR UPDATE`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceAssetId],
        );
        if (existing.rowCount) {
          const row = existing.rows[0];
          if (row.materialized_at === null || row.source_ordinal !== input.sourceOrdinal
            || row.source_ref_hash !== input.sourceRefHash || row.object_key !== input.objectKey
            || row.content_hash !== input.contentHash || row.content_type !== input.contentType || row.size_bytes !== input.sizeBytes) {
            throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
          }
          return { ...clone(input), status: "MATERIALIZED", materializedAt: new Date(row.materialized_at).toISOString() };
        }
        requireWritableRun(run);
        const ordinal = await client.query(
          `SELECT source_asset_id FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2
            AND item_id=$3 AND analysis_run_id=$4 AND source_ordinal=$5`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceOrdinal],
        );
        if (ordinal.rowCount) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
        const created = at();
        await client.query(
          `INSERT INTO auto_listing_source_image_assessments (
            account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id,source_ordinal,
            record_status,source_ref_hash,object_key,content_hash,content_type,size_bytes,materialized_at,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'MATERIALIZED',$8,$9,$10,$11,$12,$13,$13)`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.expectedStatusVersion,
            input.sourceAssetId, input.sourceOrdinal, input.sourceRefHash, input.objectKey, input.contentHash,
            input.contentType, input.sizeBytes, created],
        );
        await client.query("UPDATE auto_listing_source_image_analysis_runs SET status='ANALYZING' WHERE account_id=$1 AND id=$2", [input.accountId, run.id]);
        return { ...clone(input), status: "MATERIALIZED", materializedAt: created.toISOString() };
      });
    },
    async markAssetUnavailable(rawInput) {
      const input = validateUnavailable(rawInput);
      const resultHash = digest({ sourceAssetId: input.sourceAssetId, sourceOrdinal: input.sourceOrdinal,
        terminalStatus: input.terminalStatus, errorCode: input.errorCode });
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, input); await lockCurrentItem(client, input, run);
        const existing = await client.query(
          `SELECT * FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND analysis_run_id=$4 AND source_asset_id=$5 FOR UPDATE`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceAssetId],
        );
        if (existing.rows[0]?.record_status === "ACCEPTED") {
          if (existing.rows[0].result_hash !== resultHash) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
          return publicAssessment(mapAssessment(existing.rows[0]));
        }
        requireWritableRun(run);
        if (existing.rows[0]?.source_ordinal !== undefined
          && existing.rows[0].source_ordinal !== input.sourceOrdinal) {
          throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
        }
        const ordinal = await client.query(
          `SELECT source_asset_id FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2
            AND item_id=$3 AND analysis_run_id=$4 AND source_ordinal=$5 AND source_asset_id<>$6`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceOrdinal, input.sourceAssetId],
        );
        if (ordinal.rowCount) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSET_CONFLICT");
        const inserted = await client.query(
          `INSERT INTO auto_listing_source_image_assessments (
            account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id,source_ordinal,record_status,
            terminal_status,result_hash,error_code,accepted_at,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACCEPTED',$8,$9,$10,$11,$11)
          ON CONFLICT (account_id,job_id,item_id,analysis_run_id,source_asset_id) DO UPDATE SET
            source_ordinal=EXCLUDED.source_ordinal,record_status='ACCEPTED',
            terminal_status=EXCLUDED.terminal_status,result_hash=EXCLUDED.result_hash,
            error_code=EXCLUDED.error_code,accepted_at=EXCLUDED.accepted_at
          WHERE auto_listing_source_image_assessments.record_status='MATERIALIZED'
            AND auto_listing_source_image_assessments.source_ordinal=EXCLUDED.source_ordinal RETURNING *`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.expectedStatusVersion,
            input.sourceAssetId, input.sourceOrdinal, input.terminalStatus, resultHash, input.errorCode, at()],
        );
        let row = inserted.rows[0];
        if (!row) {
          const found = await client.query(
            `SELECT * FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
              AND analysis_run_id=$4 AND source_asset_id=$5`,
            [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceAssetId],
          );
          row = found.rows[0];
          if (row?.result_hash !== resultHash) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
        }
        await client.query(
          `UPDATE auto_listing_source_image_analysis_runs SET terminal_asset_count=(
            SELECT COUNT(*) FROM auto_listing_source_image_assessments WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED'
          ), status=CASE WHEN expected_asset_count=(SELECT COUNT(*) FROM auto_listing_source_image_assessments
            WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED') THEN 'RECONCILING' ELSE 'ANALYZING' END
          WHERE account_id=$1 AND id=$2`, [input.accountId, run.id],
        );
        return publicAssessment(mapAssessment(row));
      });
    },
    async recordBatchAssessments(rawInput) {
      const input = validateBatch(rawInput);
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, input); await lockCurrentItem(client, input, run);
        const oldBatch = await client.query(
          `SELECT analysis_batch_id,batch_input_hash,batch_result_hash,ARRAY_AGG(result_hash ORDER BY source_asset_id) hashes
            FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
              AND analysis_run_id=$4 AND analysis_batch_id=$5 GROUP BY analysis_batch_id,batch_input_hash,batch_result_hash`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.analysisBatchId],
        );
        const expectedHashes = input.assessments.slice().sort((a, b) => a.sourceAssetId.localeCompare(b.sourceAssetId)).map((entry) => entry.assessmentHash);
        if (oldBatch.rowCount) {
          const old = oldBatch.rows[0];
          if (old.batch_input_hash !== input.inputHash || old.batch_result_hash !== input.resultHash || !same(old.hashes, expectedHashes)) {
            throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_BATCH_CONFLICT");
          }
          return { status: "EXISTING_ACCEPTED", analysisBatchId: input.analysisBatchId, inputHash: input.inputHash,
            resultHash: input.resultHash, assessmentCount: input.assessments.length };
        }
        requireWritableRun(run);
        for (const entry of input.assessments) {
          const existing = await client.query(
            `SELECT record_status,result_hash,source_ordinal,object_key,content_hash FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2
              AND item_id=$3 AND analysis_run_id=$4 AND source_asset_id=$5 FOR UPDATE`,
            [input.accountId, input.jobId, input.itemId, input.analysisRunId, entry.sourceAssetId],
          );
          if (existing.rowCount && existing.rows[0].record_status === "ACCEPTED") {
            throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
          }
          if (existing.rowCount && (existing.rows[0].source_ordinal !== entry.sourceOrdinal
            || existing.rows[0].object_key !== entry.objectKey || existing.rows[0].content_hash !== entry.contentHash)) {
            throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
          }
          const ordinal = await client.query(
            `SELECT source_asset_id FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2
              AND item_id=$3 AND analysis_run_id=$4 AND source_ordinal=$5 AND source_asset_id<>$6`,
            [input.accountId, input.jobId, input.itemId, input.analysisRunId, entry.sourceOrdinal, entry.sourceAssetId],
          );
          if (ordinal.rowCount) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_ASSESSMENT_CONFLICT");
        }
        const createdAt = at();
        for (const entry of input.assessments) {
          await client.query(
            `INSERT INTO auto_listing_source_image_assessments (
              account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id,source_ordinal,
              record_status,object_key,content_hash,terminal_status,analysis_batch_id,batch_input_hash,batch_result_hash,
              input_hash,result_hash,assessment,accepted_at,created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACCEPTED',$8,$9,$10,$11,$12,$13,$12,$14,$15,$16,$16)
            ON CONFLICT (account_id,job_id,item_id,analysis_run_id,source_asset_id) DO UPDATE SET
              source_ordinal=EXCLUDED.source_ordinal,record_status='ACCEPTED',object_key=EXCLUDED.object_key,
              content_hash=EXCLUDED.content_hash,terminal_status=EXCLUDED.terminal_status,
              analysis_batch_id=EXCLUDED.analysis_batch_id,batch_input_hash=EXCLUDED.batch_input_hash,
              batch_result_hash=EXCLUDED.batch_result_hash,input_hash=EXCLUDED.input_hash,
              result_hash=EXCLUDED.result_hash,assessment=EXCLUDED.assessment,accepted_at=EXCLUDED.accepted_at
            WHERE auto_listing_source_image_assessments.record_status='MATERIALIZED'`,
            [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.expectedStatusVersion,
              entry.sourceAssetId, entry.sourceOrdinal, entry.objectKey, entry.contentHash, entry.terminalStatus,
              input.analysisBatchId, input.inputHash, input.resultHash, entry.assessmentHash, entry, createdAt],
          );
        }
        await client.query(
          `UPDATE auto_listing_source_image_analysis_runs SET terminal_asset_count=(SELECT COUNT(*)
            FROM auto_listing_source_image_assessments WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED'),
            status=CASE WHEN expected_asset_count=(SELECT COUNT(*) FROM auto_listing_source_image_assessments
              WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED') THEN 'RECONCILING' ELSE 'ANALYZING' END
            WHERE account_id=$1 AND id=$2`, [input.accountId, run.id],
        );
        return { status: "ACCEPTED", analysisBatchId: input.analysisBatchId, inputHash: input.inputHash,
          resultHash: input.resultHash, assessmentCount: input.assessments.length };
      });
    },
    async listRunAssessments(rawInput) {
      const input = validateScope(rawInput);
      return transaction(pool, async (client) => {
        await lockedRun(client, input);
        const rows = await client.query(
          `SELECT * FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND analysis_run_id=$4 AND record_status='ACCEPTED' ORDER BY source_ordinal NULLS LAST,source_asset_id`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId],
        );
        return rows.rows.map(mapAssessment).map(publicAssessment);
      });
    },
    async acceptSummary(rawInput) {
      const input = validateSummary(rawInput);
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, input);
        if (run.summaryHash !== null) {
          if (run.summaryHash !== input.summary.summaryHash || run.summaryInputHash !== input.inputHash) {
            throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_SUMMARY_CONFLICT");
          }
          return publicRun(run);
        }
        await lockCurrentItem(client, input, run);
        const counts = await client.query(
          `SELECT COUNT(*)::integer terminal_count
            FROM auto_listing_source_image_assessments WHERE account_id=$1 AND analysis_run_id=$2 AND record_status='ACCEPTED'`,
          [input.accountId, input.analysisRunId],
        );
        if (counts.rows[0].terminal_count !== run.expectedAssetCount) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_TERMINAL_COUNT_MISMATCH");
        const updated = await client.query(
          `UPDATE auto_listing_source_image_analysis_runs SET terminal_asset_count=$3,summary=$4,summary_hash=$5,
            summary_input_hash=$6,status=$7,completed_at=$8 WHERE account_id=$1 AND id=$2 AND summary_hash IS NULL RETURNING *`,
          [input.accountId, input.analysisRunId, counts.rows[0].terminal_count, input.summary, input.summary.summaryHash,
            input.inputHash, unresolvedConfirmations(input.summary, run.decisionSet) ? "CONFIRMATION_REQUIRED" : "ACCEPTED", at()],
        );
        return publicRun(mapRun(updated.rows[0]));
      });
    },
    async recordSourceImageDecision(rawInput) {
      const input = validateDecision(rawInput);
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${input.accountId}\u0001${input.idempotencyKey}`]);
        const replay = await client.query(
          `SELECT decision.* FROM auto_listing_source_image_decisions decision
            WHERE decision.account_id=$1 AND decision.idempotency_key=$2`, [input.accountId, input.idempotencyKey],
        );
        if (replay.rowCount) {
          const row = replay.rows[0];
          if (row.job_id !== input.jobId || row.item_id !== input.itemId || row.analysis_run_id !== input.analysisRunId
            || row.expected_status_version !== input.expectedStatusVersion || row.source_asset_id !== input.sourceAssetId
            || row.decision !== input.decision) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
          const derivedQuery = await client.query(
            `SELECT * FROM auto_listing_source_image_analysis_runs WHERE account_id=$1 AND parent_run_id=$2
              AND decision_set_hash=$3`, [input.accountId, input.analysisRunId, row.derived_decision_set_hash],
          );
          const derivedRun = mapRun(derivedQuery.rows[0]);
          if (!derivedRun) throw repositoryError();
          const outboxResult = await client.query(
            `SELECT phase,phase_target_id,expected_status_version,correlation_id,dedupe_key
               FROM auto_listing_ai_outbox WHERE account_id=$1 AND job_id=$2 AND item_id=$3
                 AND phase='RECONCILE_SOURCE_IMAGE_ANALYSIS' AND phase_target_id=$4
                 AND expected_status_version=$5`,
            [input.accountId, input.jobId, input.itemId, derivedRun.id, derivedRun.expectedStatusVersion],
          );
          const eventResult = await client.query(
            `SELECT event_type,from_status,to_status,transition_version,correlation_id
               FROM auto_listing_events WHERE account_id=$1 AND job_id=$2 AND item_id=$3
                 AND event_type='SOURCE_IMAGE_DECISION_ACCEPTED' AND transition_version=$4`,
            [input.accountId, input.jobId, input.itemId, derivedRun.expectedStatusVersion],
          );
          const outbox = outboxResult.rows[0]; const event = eventResult.rows[0];
          if (!outbox || !event) throw repositoryError();
          return {
            decision: publicDecision(mapDecision(row)), derivedRun: publicRun(derivedRun),
            item: { status: "PLANNING", statusVersion: derivedRun.expectedStatusVersion },
            event: { eventType: event.event_type, fromStatus: event.from_status, toStatus: event.to_status,
              transitionVersion: event.transition_version, correlationId: event.correlation_id },
            outbox: { phase: outbox.phase, analysisRunId: outbox.phase_target_id,
              expectedStatusVersion: outbox.expected_status_version, correlationId: outbox.correlation_id,
              dedupeKey: outbox.dedupe_key },
          };
        }
        const parent = await lockedDecisionRun(client, input);
        const item = await lockDecisionItem(client, input, parent);
        if (parent.status !== "CONFIRMATION_REQUIRED") throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
        const acceptedSummary = verifiedAcceptedSummary(parent);
        if (!confirmationAssetIds(acceptedSummary).has(input.sourceAssetId)) {
          throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
        }
        const target = await client.query(
          `SELECT 1 FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
            AND analysis_run_id=$4 AND source_asset_id=$5 AND record_status='ACCEPTED'`,
          [input.accountId, input.jobId, input.itemId, input.analysisRunId, input.sourceAssetId],
        );
        if (!target.rowCount) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_DECISION_CONFLICT");
        const createdAt = at(); const decisionId = createGenerated(createId, "source-image-decision");
        const decisionHash = digest({ analysisRunId: input.analysisRunId, expectedStatusVersion: input.expectedStatusVersion,
          sourceAssetId: input.sourceAssetId, decision: input.decision, idempotencyKey: input.idempotencyKey });
        const decisionSet = [...(parent.decisionSet || []), { sourceAssetId: input.sourceAssetId, decision: input.decision, decisionHash }]
          .sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId));
        const decisionSetHash = digest(decisionSet); const nextVersion = item.status_version + 1;
        validateVersion(nextVersion); createGenerated(createToken, "source-image-decision-token");
        const runId = createGenerated(createId, "source-image-run");
        const insertedRun = await client.query(
          `INSERT INTO auto_listing_source_image_analysis_runs (
            id,account_id,job_id,item_id,source_snapshot_id,expected_status_version,intelligence_contract_version,
            source_snapshot_hash,source_asset_set_hash,input_hash,prompt_template_version,profile_id,profile_version,
            model_name,expected_asset_count,terminal_asset_count,status,parent_run_id,derivation_kind,
            decision_set,decision_set_hash,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,'RECONCILING',$16,
            'MANUAL_DECISION',$17,$18,$19) RETURNING *`,
          [runId, input.accountId, input.jobId, input.itemId, parent.sourceSnapshotId, nextVersion,
            parent.contractVersion, parent.sourceSnapshotHash, parent.sourceAssetSetHash,
            digest({ parentInputHash: parent.inputHash, decisions: decisionSet }), parent.promptTemplateVersion,
            parent.profileId, parent.profileVersion, parent.modelName, parent.expectedAssetCount, parent.id,
            JSON.stringify(decisionSet), decisionSetHash, createdAt],
        );
        await client.query(
          `INSERT INTO auto_listing_source_image_assessments (
            account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id,source_ordinal,
            record_status,source_ref_hash,object_key,content_hash,content_type,size_bytes,materialized_at,
            terminal_status,analysis_batch_id,batch_input_hash,batch_result_hash,input_hash,result_hash,
            assessment,error_code,accepted_at,created_at
          ) SELECT account_id,job_id,item_id,$5,$6,source_asset_id,source_ordinal,record_status,source_ref_hash,
            object_key,content_hash,content_type,size_bytes,materialized_at,terminal_status,analysis_batch_id,
            batch_input_hash,batch_result_hash,input_hash,result_hash,assessment,error_code,accepted_at,$7
            FROM auto_listing_source_image_assessments WHERE account_id=$1 AND job_id=$2 AND item_id=$3
              AND analysis_run_id=$4 AND record_status='ACCEPTED'`,
          [input.accountId, input.jobId, input.itemId, parent.id, runId, nextVersion, createdAt],
        );
        const decisionRow = await client.query(
          `INSERT INTO auto_listing_source_image_decisions (
            id,account_id,job_id,item_id,analysis_run_id,expected_status_version,source_asset_id,decision,
            idempotency_key,decision_hash,derived_decision_set_hash,created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [decisionId, input.accountId, input.jobId, input.itemId, input.analysisRunId, input.expectedStatusVersion,
            input.sourceAssetId, input.decision, input.idempotencyKey, decisionHash, decisionSetHash, createdAt],
        );
        const switched = await client.query(
          `UPDATE auto_listing_job_items SET status='PLANNING',status_version=$4,
              current_source_image_analysis_run_id=$5,recovery_point=NULL,failure_code=NULL,
              failure_detail_safe=NULL,updated_at=$8
            WHERE account_id=$1 AND job_id=$2 AND id=$3 AND status_version=$6
              AND status='BLOCKED' AND failure_code='AUTO_LISTING_SOURCE_IMAGE_CONFIRMATION_REQUIRED'
              AND current_source_image_analysis_run_id=$7 RETURNING status,status_version`,
          [input.accountId, input.jobId, input.itemId, nextVersion, runId, input.expectedStatusVersion, parent.id, createdAt],
        );
        if (switched.rowCount !== 1) throw repositoryError("AUTO_LISTING_SOURCE_IMAGE_STALE");
        assertAutoListingTransition("BLOCKED", "SOURCE_IMAGE_DECISION_ACCEPTED", "PLANNING");
        const eventRow = await insertDecisionEvent(client, input, decisionHash, runId, nextVersion, createdAt);
        const outboxRow = await insertDecisionOutbox(client, input, runId, nextVersion, createdAt);
        return {
          decision: publicDecision(mapDecision(decisionRow.rows[0])), derivedRun: publicRun(mapRun(insertedRun.rows[0])),
          item: { status: switched.rows[0].status, statusVersion: switched.rows[0].status_version },
          event: { eventType: eventRow.event_type, fromStatus: eventRow.from_status, toStatus: eventRow.to_status,
            transitionVersion: eventRow.transition_version, correlationId: eventRow.correlation_id },
          outbox: { phase: outboxRow.phase, analysisRunId: outboxRow.phase_target_id,
            expectedStatusVersion: outboxRow.expected_status_version, correlationId: outboxRow.correlation_id,
            dedupeKey: outboxRow.dedupe_key },
        };
      });
    },
    async loadAcceptedSummary(rawInput) {
      const input = validateScope(rawInput);
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, input);
        return run.summaryHash === null ? null : publicRun(run);
      });
    },
  };
  return Object.freeze(api);
}
