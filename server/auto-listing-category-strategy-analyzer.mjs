import crypto from "node:crypto";
import { types } from "node:util";

import {
  projectCategoryStrategyGuidanceV2,
  projectCategoryStrategyScope,
} from "./auto-listing-category-strategy-contract.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ROLES = Object.freeze([
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
]);
const TEXT_DENSITIES = new Set(["NONE", "LIGHT", "MEDIUM", "HEAVY"]);
const MAX_RAW_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_IMAGE_BYTES = 64 * 1024 * 1024;

function failure(code, status = 422, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function invalid() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYZER_INVALID", 400);
}

function closed(raw, keys, error = invalid) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw error();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (caught) {
    if (caught?.code) throw caught;
    throw error();
  }
}

function closedArray(raw, minimum, maximum, error = invalid) {
  try {
    if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
      || raw.length < minimum || raw.length > maximum) throw error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== raw.length + 1
      || descriptors.length?.value !== raw.length) throw error();
    return Array.from({ length: raw.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw error();
      return descriptor.value;
    });
  } catch (caught) {
    if (caught?.code) throw caught;
    throw error();
  }
}

function id(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(text) || text !== value) throw invalid();
  return text;
}

function text(value, maximum = 1_000) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  throw invalid();
}

function safeScope(raw, accountId) {
  let scope;
  try { scope = projectCategoryStrategyScope(raw); } catch { throw invalid(); }
  if (scope.accountId !== accountId) throw invalid();
  return scope;
}

function configuration(raw) {
  const value = closed(raw, new Set([
    "analyzerVersion", "promptVersion", "profileId", "profileVersion", "model",
  ]));
  return deepFreeze({
    analyzerVersion: id(value.analyzerVersion), promptVersion: id(value.promptVersion),
    profileId: id(value.profileId), profileVersion: positive(value.profileVersion), model: id(value.model),
  });
}

function safeGuidance() {
  return projectCategoryStrategyGuidanceV2({
    overallStyle: "NEEDS_REVIEW",
    prohibitedPatterns: ["manual review required"],
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      composition: "manual review required", background: "manual review required",
      textDensity: "NONE", layout: "manual review required",
    }])),
  });
}

function evidenceDto(raw, accountId, draftId) {
  const value = closed(raw, new Set([
    "accountId", "draftId", "draftVersion", "status", "scope", "sampleSetId", "sampleSetHash", "samples",
  ]));
  if (id(value.accountId) !== accountId || id(value.draftId) !== draftId
    || !["SAMPLES_READY", "ANALYZING", "DRAFT_READY", "NEEDS_REVIEW"].includes(value.status)
    || typeof value.sampleSetHash !== "string" || !HASH.test(value.sampleSetHash)) throw invalid();
  const scope = safeScope(value.scope, accountId);
  const samples = closedArray(value.samples, 5, 20).map((rawSample) => {
    const sample = closed(rawSample, new Set(["sampleId", "sku", "productFacts", "images"]));
    const sampleId = id(sample.sampleId);
    const sku = id(sample.sku);
    const facts = closed(sample.productFacts, new Set(["sku"]));
    if (id(facts.sku) !== sku) throw invalid();
    const images = closedArray(sample.images, 1, 6).map((rawImage, index) => {
      const image = closed(rawImage, new Set([
        "evidenceId", "state", "role", "ordinal", "analysisObjectKey", "analysisContentHash", "contentType",
      ]));
      const expectedRole = index === 0 ? "MAIN" : "DETAIL";
      const objectKey = typeof image.analysisObjectKey === "string" ? image.analysisObjectKey : "";
      if (image.state !== "READY" || image.role !== expectedRole || image.ordinal !== index
        || typeof image.analysisContentHash !== "string" || !HASH.test(image.analysisContentHash)
        || !["image/jpeg", "image/png", "image/webp"].includes(image.contentType)
        || objectKey.length < 1 || objectKey.length > 1_024
        || !objectKey.startsWith(`category-strategy/${accountId}/${draftId}/${value.sampleSetId}/${sampleId}/`)) {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
      }
      return deepFreeze({ evidenceId: id(image.evidenceId), role: expectedRole, ordinal: index,
        analysisObjectKey: objectKey, analysisContentHash: image.analysisContentHash,
        contentType: image.contentType });
    });
    return deepFreeze({ sampleId, sku, productFacts: { sku }, images });
  });
  if (new Set(samples.map((sample) => sample.sku)).size !== samples.length
    || new Set(samples.flatMap((sample) => sample.images.map((image) => image.evidenceId))).size
      !== samples.reduce((sum, sample) => sum + sample.images.length, 0)) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
  }
  return deepFreeze({ accountId, draftId, draftVersion: positive(value.draftVersion), status: value.status,
    scope, sampleSetId: id(value.sampleSetId), sampleSetHash: value.sampleSetHash, samples });
}

function outputError(code = "AUTO_LISTING_CATEGORY_STRATEGY_AI_OUTPUT_INVALID") {
  return failure(code, 422);
}

function outputText(value) {
  try { return text(value); } catch { throw outputError(); }
}

function outputArray(raw, minimum, maximum) {
  return closedArray(raw, minimum, maximum, outputError);
}

function outputClosed(raw, keys) {
  return closed(raw, keys, outputError);
}

function bilingualText(raw) {
  const value = outputClosed(raw, new Set(["ru", "zh"]));
  return deepFreeze({ ru: outputText(value.ru), zh: outputText(value.zh) });
}

function evidenceReferences(raw, evidenceToSku, { aggregate }) {
  const ids = outputArray(raw, 1, 20).map((entry) => {
    try { return id(entry); } catch { throw outputError("AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_INVALID"); }
  });
  if (new Set(ids).size !== ids.length || ids.some((entry) => !evidenceToSku.has(entry))) {
    throw outputError("AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_INVALID");
  }
  if (aggregate && new Set(ids.map((entry) => evidenceToSku.get(entry))).size < 2) {
    throw outputError("AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_INSUFFICIENT");
  }
  return deepFreeze(ids);
}

function confidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw outputError();
  return value;
}

function projectAiOutput(raw, evidenceToSku) {
  const value = outputClosed(raw, new Set([
    "schemaVersion", "style", "roleGuidance", "commonPatterns", "differences", "cautions",
  ]));
  if (value.schemaVersion !== 3) throw outputError();
  const roles = outputClosed(value.roleGuidance, new Set(ROLES));
  const guidanceRolesRu = {};
  const guidanceRolesZh = {};
  const roleEvidence = {};
  for (const roleName of ROLES) {
    const role = outputClosed(roles[roleName], new Set([
      "composition", "background", "textDensity", "layout", "evidenceIds", "confidence",
    ]));
    if (!TEXT_DENSITIES.has(role.textDensity)) throw outputError();
    const composition = bilingualText(role.composition);
    const background = bilingualText(role.background);
    const layout = bilingualText(role.layout);
    guidanceRolesRu[roleName] = {
      composition: composition.ru, background: background.ru,
      textDensity: role.textDensity, layout: layout.ru,
    };
    guidanceRolesZh[roleName] = {
      composition: composition.zh, background: background.zh,
      textDensity: role.textDensity, layout: layout.zh,
    };
    roleEvidence[roleName] = {
      evidenceIds: evidenceReferences(role.evidenceIds, evidenceToSku, { aggregate: true }),
      confidence: confidence(role.confidence),
    };
  }
  const commonPatterns = outputArray(value.commonPatterns, 0, 50).map((rawPattern) => {
    const pattern = outputClosed(rawPattern, new Set(["pattern", "evidenceIds", "confidence"]));
    const localized = bilingualText(pattern.pattern);
    return deepFreeze({ ru: localized.ru, zh: localized.zh,
      evidenceIds: evidenceReferences(pattern.evidenceIds, evidenceToSku, { aggregate: true }),
      confidence: confidence(pattern.confidence) });
  });
  const differences = outputArray(value.differences, 0, 50).map((rawDifference) => {
    const difference = outputClosed(rawDifference, new Set(["pattern", "evidenceIds"]));
    const localized = bilingualText(difference.pattern);
    return deepFreeze({ ru: localized.ru, zh: localized.zh,
      evidenceIds: evidenceReferences(difference.evidenceIds, evidenceToSku, { aggregate: false }) });
  });
  const cautions = outputArray(value.cautions, 0, 50).map(bilingualText);
  const style = bilingualText(value.style);
  let guidance;
  let managementGuidance;
  try {
    guidance = projectCategoryStrategyGuidanceV2({
      overallStyle: style.ru, prohibitedPatterns: cautions.map((entry) => entry.ru), roles: guidanceRolesRu,
    });
    managementGuidance = projectCategoryStrategyGuidanceV2({
      overallStyle: style.zh, prohibitedPatterns: cautions.map((entry) => entry.zh), roles: guidanceRolesZh,
    });
  } catch { throw outputError(); }
  return deepFreeze({ guidance, evidenceSummary: {
    roleEvidence,
    commonPatterns: commonPatterns.map((entry) => ({
      pattern: entry.ru, evidenceIds: entry.evidenceIds, confidence: entry.confidence,
    })),
    differences: differences.map((entry) => ({ pattern: entry.ru, evidenceIds: entry.evidenceIds })),
    cautions: cautions.map((entry) => entry.ru),
    managementZh: {
      guidance: managementGuidance,
      commonPatterns: commonPatterns.map((entry) => entry.zh),
      differences: differences.map((entry) => entry.zh),
      cautions: cautions.map((entry) => entry.zh),
    },
  } });
}

function cloneBounded(raw, state = { nodes: 0 }, depth = 0) {
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_RAW_BYTES) throw outputError();
    return raw;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw outputError();
    return raw;
  }
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || depth > 32 || ++state.nodes > 20_000) {
    throw outputError();
  }
  if (Array.isArray(raw)) {
    const entries = closedArray(raw, 0, 1_000, outputError);
    return entries.map((entry) => cloneBounded(entry, state, depth + 1));
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw outputError();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 1_000 || keys.some((key) => typeof key !== "string" || key.length > 1_024
    || ["__proto__", "constructor", "prototype"].includes(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw outputError();
  return Object.fromEntries(keys.map((key) => [key, cloneBounded(descriptors[key].value, state, depth + 1)]));
}

function rawEnvelope(raw, validationStatus, safeCode) {
  try {
    const response = cloneBounded(raw);
    const envelope = { validationStatus, safeCode, response };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_RAW_BYTES) throw outputError();
    return deepFreeze(envelope);
  } catch {
    return deepFreeze({ validationStatus: "REJECTED", safeCode, responseRetained: false });
  }
}

function analysisResult(raw) {
  const value = closed(raw, new Set([
    "attemptId", "resultId", "status", "draftVersion", "duplicate", "safeCode", "guidance",
    "evidenceSummary", "editedBy", "editedAt", "baseAnalysisAttemptId",
  ]));
  if (!["DRAFT_READY", "NEEDS_REVIEW"].includes(value.status)
    || typeof value.duplicate !== "boolean"
    || !(value.safeCode === null || (typeof value.safeCode === "string" && value.safeCode.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_")))) {
    throw invalid();
  }
  let guidance;
  try { guidance = projectCategoryStrategyGuidanceV2(value.guidance); } catch { throw invalid(); }
  return deepFreeze({
    attemptId: id(value.attemptId), resultId: id(value.resultId), status: value.status,
    draftVersion: positive(value.draftVersion), duplicate: value.duplicate, safeCode: value.safeCode,
    guidance, evidenceSummary: value.evidenceSummary,
    editedBy: value.editedBy, editedAt: value.editedAt, baseAnalysisAttemptId: value.baseAnalysisAttemptId,
  });
}

function dependency(error, unknownAllowed = false) {
  if (unknownAllowed && (error?.code === "AI_RESPONSE_UNKNOWN" || error?.code === "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN")) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_AI_RESPONSE_UNKNOWN", 409, true);
  }
  if (typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_")) throw error;
  throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_FAILED", 503, Boolean(error?.retryable));
}

export function createCategoryStrategyAnalyzer(rawOptions = {}) {
  const options = closed(rawOptions,
    new Set(["repository", "objectStorage", "aiAdapter", "configurationResolver"]));
  const { repository, objectStorage, aiAdapter, configurationResolver } = options;
  if (!["getAnalysisReplay", "loadAnalysisEvidence", "reserveAnalysisAttempt", "completeAnalysisAttempt", "appendManualAnalysisResult"]
    .every((method) => typeof repository?.[method] === "function")
    || typeof objectStorage?.readObjectExpected !== "function"
    || typeof aiAdapter?.analyze !== "function" || typeof aiAdapter?.recover !== "function"
    || typeof configurationResolver?.resolve !== "function") {
    throw new TypeError("Category strategy analyzer dependencies are required");
  }

  return Object.freeze({
    async analyze(raw = {}) {
      const input = closed(raw, new Set([
        "accountId", "actorId", "draftId", "costConfirmed", "idempotencyKey", "correlationId",
      ]));
      if (input.costConfirmed !== true) {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_COST_CONFIRMATION_REQUIRED", 409);
      }
      const accountId = id(input.accountId);
      if (id(input.actorId) !== accountId) throw invalid();
      const draftId = id(input.draftId);
      const idempotencyKey = id(input.idempotencyKey);
      const correlationId = id(input.correlationId);
      const loadEvidence = async () => {
        try {
          return evidenceDto(await repository.loadAnalysisEvidence({
            accountId, actorId: accountId, draftId,
          }), accountId, draftId);
        } catch (error) {
          if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY") throw error;
          if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_ANALYZER_INVALID") {
            throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
          }
          dependency(error);
        }
      };
      let durable;
      try {
        durable = await repository.getAnalysisReplay({ accountId, actorId: accountId, draftId,
          idempotencyKey, correlationId });
      } catch (error) { dependency(error); }
      let config;
      let evidence;
      let analysisInputHash;
      let reservation;
      const assertAiReady = async () => {
        try {
          if (typeof aiAdapter.assertReady === "function") {
            await aiAdapter.assertReady({ accountId, configuration: config });
          }
        } catch (error) { dependency(error); }
      };
      if (durable !== null) {
        const replay = closed(durable, new Set([
          "attemptId", "analysisInputHash", "modelConfigSnapshot", "sampleSetId", "sampleSetHash", "result",
        ]));
        const attemptId = id(replay.attemptId);
        if (replay.result !== null) return analysisResult(replay.result);
        analysisInputHash = typeof replay.analysisInputHash === "string" && HASH.test(replay.analysisInputHash)
          ? replay.analysisInputHash : (() => { throw invalid(); })();
        config = configuration(replay.modelConfigSnapshot);
        await assertAiReady();
        evidence = await loadEvidence();
        if (id(replay.sampleSetId) !== evidence.sampleSetId || replay.sampleSetHash !== evidence.sampleSetHash) {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY", 409);
        }
        reservation = { attemptId, duplicate: true, result: null };
      } else {
        try { config = configuration(await configurationResolver.resolve({ accountId })); }
        catch (error) { dependency(error); }
        await assertAiReady();
        evidence = await loadEvidence();
        const identity = canonical({ accountId, draftId, sampleSetHash: evidence.sampleSetHash,
          analyzerVersion: config.analyzerVersion, model: config.model, promptVersion: config.promptVersion,
          profileId: config.profileId, profileVersion: config.profileVersion,
          evidence: evidence.samples.map((sample) => ({ sampleId: sample.sampleId, sku: sample.sku,
            images: sample.images.map((image) => ({ evidenceId: image.evidenceId,
              analysisContentHash: image.analysisContentHash, role: image.role, ordinal: image.ordinal })) })),
        });
        analysisInputHash = sha(JSON.stringify(identity));
        try {
          reservation = closed(await repository.reserveAnalysisAttempt({ accountId, actorId: accountId, draftId,
            expectedDraftVersion: evidence.draftVersion, sampleSetId: evidence.sampleSetId,
            sampleSetHash: evidence.sampleSetHash, analysisInputHash,
            modelConfigSnapshot: config, modelConfigHash: sha(JSON.stringify(canonical(config))),
            costConfirmed: true, idempotencyKey, correlationId }),
          new Set(["attemptId", "duplicate", "result"]));
        } catch (error) { dependency(error); }
      }
      const attemptId = id(reservation.attemptId);
      if (typeof reservation.duplicate !== "boolean") throw invalid();
      if (reservation.result !== null) return analysisResult(reservation.result);
      const execution = deepFreeze({ accountId, analyzerVersion: config.analyzerVersion,
        promptVersion: config.promptVersion, profileId: config.profileId,
        profileVersion: config.profileVersion, model: config.model });
      let rawOutput;
      let preflightSafeCode = null;
      try {
        if (reservation.duplicate) {
          rawOutput = await aiAdapter.recover({ attemptId, requestKey: analysisInputHash, execution });
        } else {
          const loadedImages = [];
          let totalImageBytes = 0;
          try {
            for (const sample of evidence.samples) {
              for (const image of sample.images) {
                const bytes = await objectStorage.readObjectExpected({ accountId,
                  key: image.analysisObjectKey, expectedSha256: image.analysisContentHash,
                  maxBytes: MAX_IMAGE_BYTES });
                totalImageBytes += Buffer.byteLength(bytes);
                if (totalImageBytes > MAX_REQUEST_IMAGE_BYTES) throw new Error("image budget exceeded");
                loadedImages.push(deepFreeze({ evidenceId: image.evidenceId, sampleId: sample.sampleId,
                  sku: sample.sku, role: image.role, ordinal: image.ordinal, contentType: image.contentType,
                  bytesBase64: Buffer.from(bytes).toString("base64") }));
              }
            }
          } catch { preflightSafeCode = "AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_NOT_READY"; }
          if (preflightSafeCode === null) {
            const request = deepFreeze({
              attemptId,
              requestKey: analysisInputHash,
              execution,
              scope: { taxonomyScope: evidence.scope.taxonomyScope,
                descriptionCategoryId: evidence.scope.descriptionCategoryId, typeId: evidence.scope.typeId },
              productFacts: evidence.samples.map((sample) => ({ sampleId: sample.sampleId, sku: sample.sku })),
              images: loadedImages,
              contract: {
                schemaVersion: 3, roles: [...ROLES],
                aggregateEvidenceMinimumDistinctSkus: 2,
                prohibited: ["image counts", "role counts", "copying brand claims", "future generation references"],
              },
            });
            rawOutput = await aiAdapter.analyze(request);
          }
        }
      } catch (error) {
        if (error?.code === "AI_RESPONSE_UNKNOWN" || error?.code === "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN") {
          dependency(error, true);
        }
        preflightSafeCode = "AUTO_LISTING_CATEGORY_STRATEGY_AI_CALL_FAILED";
      }
      const evidenceToSku = new Map();
      for (const sample of evidence.samples) {
        for (const image of sample.images) evidenceToSku.set(image.evidenceId, sample.sku);
      }
      let normalized;
      let outcome = preflightSafeCode === null ? "ACCEPTED" : "REJECTED";
      let safeCode = preflightSafeCode;
      try {
        normalized = preflightSafeCode === null
          ? projectAiOutput(rawOutput, evidenceToSku)
          : { guidance: safeGuidance(), evidenceSummary: null };
      } catch (error) {
        outcome = "REJECTED";
        safeCode = typeof error?.code === "string" && error.code.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_AI_")
          ? error.code : "AUTO_LISTING_CATEGORY_STRATEGY_AI_OUTPUT_INVALID";
        normalized = { guidance: safeGuidance(), evidenceSummary: null };
      }
      const rawResponse = rawEnvelope(rawOutput, outcome === "ACCEPTED" ? "ACCEPTED" : "REJECTED",
        safeCode);
      const persistedRawResponse = { ...rawResponse, evidenceSummary: normalized.evidenceSummary };
      try {
        return analysisResult(await repository.completeAnalysisAttempt({ accountId, actorId: accountId,
          draftId, attemptId, expectedDraftVersion: reservation.duplicate
            ? evidence.draftVersion : evidence.draftVersion + 1,
          analysisInputHash, outcome, safeCode, rawResponse,
          rawResponseHash: sha(JSON.stringify(canonical(persistedRawResponse))),
          guidance: normalized.guidance,
          guidanceHash: sha(JSON.stringify(canonical(normalized.guidance))),
          evidenceSummary: normalized.evidenceSummary,
          idempotencyKey, correlationId }));
      } catch (error) { dependency(error); }
    },

    async editGuidance(raw = {}) {
      const input = closed(raw, new Set([
        "accountId", "actorId", "draftId", "expectedDraftVersion", "baseAnalysisAttemptId",
        "guidance", "idempotencyKey", "correlationId",
      ]));
      const accountId = id(input.accountId);
      if (id(input.actorId) !== accountId) throw invalid();
      let guidance;
      try { guidance = projectCategoryStrategyGuidanceV2(input.guidance); } catch { throw invalid(); }
      try {
        return analysisResult(await repository.appendManualAnalysisResult({ accountId, actorId: accountId,
          draftId: id(input.draftId), expectedDraftVersion: positive(input.expectedDraftVersion),
          baseAnalysisAttemptId: id(input.baseAnalysisAttemptId), guidance,
          guidanceHash: sha(JSON.stringify(canonical(guidance))),
          idempotencyKey: id(input.idempotencyKey), correlationId: id(input.correlationId) }));
      } catch (error) { dependency(error); }
    },
  });
}
