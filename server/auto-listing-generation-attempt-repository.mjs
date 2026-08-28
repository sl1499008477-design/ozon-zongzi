import crypto from "node:crypto";
import { GENERATED_ASSET_OBJECT_KEY_VERSIONS, verifyGeneratedAssetObjectKey } from "./auto-listing-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/;
const scopeKeys = ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey"];
const clean = (value) => typeof value === "string" && value.trim() && value === value.trim()
  && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
const validGenerationSize = (value) => typeof value === "string" && /^[1-9][0-9]*x[1-9][0-9]*$/u.test(value);
const recoverableCheckerFailures = new Set([
  "CHECKER_UNAVAILABLE", "CHECKER_RESPONSE_INVALID", "CHECKER_EVIDENCE_INVALID",
]);
const CHANNEL_RELEASED = "AUTO_LISTING_IMAGE_CHANNEL_RELEASED";
const copy = (value) => structuredClone(value);
const keyOf = (input) => [...scopeKeys.map((key) => input[key]), input.expectedStatusVersion ?? "legacy"].join("\u0001");
function invalid() { const error = new Error("图片生成尝试无效"); error.code = "AUTO_LISTING_IMAGE_ATTEMPT_INVALID"; return error; }
function validGatewayProvenance(input) {
  if (!Object.hasOwn(input, "gatewayConnectionId") && !Object.hasOwn(input, "gatewayConnectionVersion")) return true;
  return (input.gatewayConnectionId === null && input.gatewayConnectionVersion === null)
    || (clean(input.gatewayConnectionId) && Number.isInteger(input.gatewayConnectionVersion)
      && input.gatewayConnectionVersion >= 1 && input.gatewayConnectionVersion <= 2_147_483_647);
}
function fence(input, hashKey = "attemptIdentityHash") {
  if (!input || !scopeKeys.every((key) => clean(input[key])) || !HASH.test(input[hashKey] || "")
    || (Object.hasOwn(input, "legacyAttemptIdentityHash")
      && (!HASH.test(input.legacyAttemptIdentityHash || "") || input.legacyAttemptIdentityHash === input.attemptIdentityHash))
    || !validGenerationSize(input.generationSize)
    || (Object.hasOwn(input, "expectedStatusVersion") && (!Number.isInteger(input.expectedStatusVersion)
      || input.expectedStatusVersion < 1 || input.expectedStatusVersion > 2_147_483_647))
    || !validGatewayProvenance(input)) throw invalid();
  return keyOf(input);
}

/**
 * Deterministic reference adapter for unit tests and non-PG composition.  It
 * defines the same account/job/item/plan/slot fence that the durable Task 6
 * adapter must enforce transactionally; it never crosses a caller's scope.
 */
export function createMemoryGenerationAttemptRepository({ now = () => Date.now(), leaseMs = 60_000, token = () => crypto.randomUUID(), readItemState = null } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || typeof now !== "function" || typeof token !== "function"
    || !(readItemState === null || typeof readItemState === "function")) throw invalid();
  const rows = [];
  const stateDisposition = async (input) => {
    if (!Object.hasOwn(input, "expectedStatusVersion")) return "CURRENT";
    if (readItemState === null) throw invalid();
    let state;
    try {
      state = await readItemState(Object.freeze({
        accountId: input.accountId, jobId: input.jobId, itemId: input.itemId,
        planId: input.planId, expectedStatusVersion: input.expectedStatusVersion,
      }));
    } catch { throw invalid(); }
    if (!state || typeof state.status !== "string" || !Number.isInteger(state.statusVersion)) throw invalid();
    if (state.status === "CANCELLED") return "CANCELLED";
    if (state.status !== "GENERATING" || state.statusVersion !== input.expectedStatusVersion
      || state.activeContentPlanId !== input.planId) return "STALE";
    return "CURRENT";
  };
  const matching = (input) => {
    const compatibleIdentities = new Set([input.attemptIdentityHash, input.legacyAttemptIdentityHash].filter(Boolean));
    return rows.filter((row) => keyOf(row) === keyOf(input) && compatibleIdentities.has(row.attemptIdentityHash));
  };
  const own = async (input, { allowFinalInputBinding = false } = {}) => {
    fence(input);
    if (await stateDisposition(input) !== "CURRENT") throw invalid();
    const row = rows.find((candidate) => candidate.attemptNo === input.attemptNo && keyOf(candidate) === keyOf(input)
      && candidate.attemptIdentityHash === input.attemptIdentityHash);
    if (!row || row.leaseToken !== input.leaseToken || row.status !== "GENERATING"
      || row.leaseExpiresAt <= now() || row.generationSize !== input.generationSize
      || (row.gatewayConnectionId ?? null) !== (input.gatewayConnectionId ?? null)
      || (row.gatewayConnectionVersion ?? null) !== (input.gatewayConnectionVersion ?? null)
      || !HASH.test(input.inputHash || "")
      || ((!allowFinalInputBinding || row.finalInputBoundAt !== null) && input.inputHash !== row.inputHash)) throw invalid();
    return row;
  };
  return Object.freeze({
    async reserveGenerationAttempt(input) {
      fence(input);
      if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3) throw invalid();
      const disposition = await stateDisposition(input);
      if (disposition !== "CURRENT") return { status: disposition };
      const current = matching(input);
      if (current.some((row) => row.generationSize !== input.generationSize)) throw invalid();
      const accepted = current.find((row) => row.status === "ACCEPTED");
      if (accepted) return { status: "EXISTING_ACCEPTED", record: copy(accepted) };
      const timestamp = now();
      const active = current.find((row) => row.status === "GENERATING" && row.leaseExpiresAt > timestamp);
      if (active) return { status: "IN_PROGRESS" };
      for (const row of current) if (row.status === "GENERATING" && row.leaseExpiresAt <= timestamp
        && row.leaseToken !== CHANNEL_RELEASED) { row.status = "FAILED"; row.errorCode = "LEASE_EXPIRED"; row.errorRetryable = true; row.leaseToken = null; row.leaseExpiresAt = null; }
      const reclaimable = current.filter((row) => row.status === "GENERATING"
        && row.leaseExpiresAt <= timestamp && row.leaseToken === CHANNEL_RELEASED);
      if (reclaimable.length > 1) throw invalid();
      if (reclaimable.length === 1) {
        const leaseToken = clean(token()); if (!leaseToken) throw invalid();
        const reusableProducer = reclaimable[0].objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
          && verifyGeneratedAssetObjectKey(reclaimable[0]) && clean(reclaimable[0].gatewayRequestId)
          && reclaimable[0].modelEvidence;
        Object.assign(reclaimable[0], {
          leaseToken, leaseExpiresAt: timestamp + leaseMs, checkerRequestId: null,
          checkerConnectionId: null, checkerConnectionVersion: null,
          errorCode: null, errorRetryable: null,
          gatewayConnectionId: reusableProducer
            ? reclaimable[0].gatewayConnectionId ?? null : input.gatewayConnectionId ?? null,
          gatewayConnectionVersion: reusableProducer
            ? reclaimable[0].gatewayConnectionVersion ?? null : input.gatewayConnectionVersion ?? null,
        });
        return {
          status: "RESERVED", attemptNo: reclaimable[0].attemptNo,
          leaseToken, generationSize: input.generationSize,
          gatewayConnectionId: reclaimable[0].gatewayConnectionId ?? null,
          gatewayConnectionVersion: reclaimable[0].gatewayConnectionVersion ?? null,
        };
      }
      const attemptNo = current.reduce((maximum, row) => Math.max(maximum, row.attemptNo), 0) + 1;
      if (attemptNo > input.maxAttempts) return { status: "ATTEMPTS_EXHAUSTED" };
      const leaseToken = clean(token()); if (!leaseToken) throw invalid();
      rows.push({ ...Object.fromEntries(scopeKeys.map((key) => [key, input[key]])),
        ...(Object.hasOwn(input, "expectedStatusVersion") ? { expectedStatusVersion: input.expectedStatusVersion } : {}),
        attemptIdentityHash: input.attemptIdentityHash, inputHash: input.attemptIdentityHash,
        generationSize: input.generationSize, finalInputBoundAt: null, attemptNo, status: "GENERATING",
        leaseToken, leaseExpiresAt: timestamp + leaseMs,
        gatewayConnectionId: input.gatewayConnectionId ?? null,
        gatewayConnectionVersion: input.gatewayConnectionVersion ?? null });
      return { status: "RESERVED", attemptNo, leaseToken, generationSize: input.generationSize,
        gatewayConnectionId: input.gatewayConnectionId ?? null,
        gatewayConnectionVersion: input.gatewayConnectionVersion ?? null };
    },
    async bindGenerationAttemptInput(input) {
      if (!HASH.test(input?.inputHash || "")) throw invalid();
      const row = await own(input, { allowFinalInputBinding: true });
      if (row.finalInputBoundAt !== null) {
        const reusable = row.objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
          && verifyGeneratedAssetObjectKey(row) && clean(row.gatewayRequestId) && row.modelEvidence;
        return { status: "BOUND", inputHash: row.inputHash,
          gatewayConnectionId: row.gatewayConnectionId ?? null,
          gatewayConnectionVersion: row.gatewayConnectionVersion ?? null,
          ...(reusable ? { recoveryRecord: copy(row) } : {}) };
      }
      const conflict = rows.find((candidate) => candidate !== row && keyOf(candidate) === keyOf(input)
        && candidate.inputHash === input.inputHash && ["GENERATING", "ACCEPTED"].includes(candidate.status));
      if (conflict?.status === "ACCEPTED") {
        Object.assign(row, { status: "FAILED", errorCode: "FINAL_INPUT_REUSED", errorRetryable: false, leaseToken: null, leaseExpiresAt: null });
        return { status: "EXISTING_ACCEPTED", record: copy(conflict) };
      }
      if (conflict) {
        Object.assign(row, { status: "FAILED", errorCode: "FINAL_INPUT_VERSION_CONFLICT", errorRetryable: true, leaseToken: null, leaseExpiresAt: null });
        return { status: "VERSION_CONFLICT" };
      }
      row.inputHash = input.inputHash;
      row.finalInputBoundAt = now();
      const recoveryRecord = rows.find((candidate) => candidate !== row
        && scopeKeys.every((key) => candidate[key] === input[key])
        && candidate.attemptIdentityHash === input.attemptIdentityHash
        && candidate.inputHash === input.inputHash && candidate.generationSize === input.generationSize
        && candidate.status === "FAILED" && recoverableCheckerFailures.has(candidate.errorCode)
        && candidate.errorRetryable === true && candidate.finalInputBoundAt !== null
        && candidate.objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        && verifyGeneratedAssetObjectKey(candidate) && candidate.modelEvidence);
      if (recoveryRecord) {
        row.gatewayConnectionId = recoveryRecord.gatewayConnectionId ?? null;
        row.gatewayConnectionVersion = recoveryRecord.gatewayConnectionVersion ?? null;
      }
      return { status: "BOUND", inputHash: input.inputHash,
        gatewayConnectionId: row.gatewayConnectionId ?? null,
        gatewayConnectionVersion: row.gatewayConnectionVersion ?? null,
        ...(recoveryRecord ? { recoveryRecord: copy(recoveryRecord) } : {}) };
    },
    async recordStoredGenerationAsset(input) {
      const row = await own(input);
      if (row.finalInputBoundAt === null || input.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        || !verifyGeneratedAssetObjectKey(input)) throw invalid();
      Object.assign(row, copy({ objectKeyVersion: input.objectKeyVersion, objectKey: input.objectKey, contentHash: input.contentHash, contentType: input.contentType, width: input.width, height: input.height, size: input.size }));
      return copy(row);
    },
    async completeGenerationAttempt(input) {
      const row = await own(input);
      if (row.finalInputBoundAt === null || input.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        || !verifyGeneratedAssetObjectKey(input)) throw invalid();
      Object.assign(row, copy(input), { status: "ACCEPTED", leaseToken: null, leaseExpiresAt: null });
      return copy(row);
    },
    async rejectGenerationAttempt(input) { const row = await own(input); if (row.finalInputBoundAt === null) throw invalid(); Object.assign(row, copy(input), { status: "REJECTED", leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async failGenerationAttempt(input) {
      const row = await own(input);
      Object.assign(row, copy(input), {
        status: "FAILED", errorCode: input.code, errorRetryable: input.retryable,
        leaseToken: null, leaseExpiresAt: null,
      });
      return copy(row);
    },
    async releaseGenerationLease(input) {
      if (input?.errorCode !== CHANNEL_RELEASED || !clean(input.role) || !clean(input.profileId)
        || !Number.isInteger(input.profileVersion) || input.profileVersion < 1 || !clean(input.modelName)
        || !(input.gatewayRequestId === null || clean(input.gatewayRequestId))
        || !(input.checkerRequestId === null || clean(input.checkerRequestId))
        || !(input.modelEvidence === null || (input.modelEvidence && typeof input.modelEvidence === "object"
          && !Array.isArray(input.modelEvidence) && Object.keys(input.modelEvidence).length > 0))
        || !validGatewayProvenance({
          gatewayConnectionId: input.checkerConnectionId ?? null,
          gatewayConnectionVersion: input.checkerConnectionVersion ?? null,
        })) throw invalid();
      const row = await own(input);
      if (row.finalInputBoundAt === null) throw invalid();
      Object.assign(row, copy({
        role: input.role, profileId: input.profileId, profileVersion: input.profileVersion,
        modelName: input.modelName, gatewayRequestId: input.gatewayRequestId,
        ...(input.checkerRequestId === null ? {} : { checkerRequestId: input.checkerRequestId }),
        modelEvidence: input.modelEvidence,
        checkerConnectionId: input.checkerConnectionId ?? null,
        checkerConnectionVersion: input.checkerConnectionVersion ?? null,
      }), {
        status: "GENERATING", errorCode: null, errorRetryable: null,
        leaseToken: CHANNEL_RELEASED, leaseExpiresAt: now(),
      });
      return copy(row);
    },
    async replaceUnusableGenerationEvidence(input) {
      if (!validGatewayProvenance({
        gatewayConnectionId: input?.replacementGatewayConnectionId,
        gatewayConnectionVersion: input?.replacementGatewayConnectionVersion,
      })) throw invalid();
      const row = await own(input);
      if (row.finalInputBoundAt === null) throw invalid();
      for (const key of ["objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height", "size",
        "gatewayRequestId", "checkerRequestId", "modelEvidence", "checkerConnectionId", "checkerConnectionVersion"]) {
        row[key] = null;
      }
      row.gatewayConnectionId = input.replacementGatewayConnectionId ?? null;
      row.gatewayConnectionVersion = input.replacementGatewayConnectionVersion ?? null;
      return Object.freeze({
        gatewayConnectionId: row.gatewayConnectionId,
        gatewayConnectionVersion: row.gatewayConnectionVersion,
      });
    },
    async revertStoredGenerationAsset(input) {
      const row = await own(input);
      if (row.finalInputBoundAt === null) throw invalid();
      const storedKeys = ["objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height", "size"];
      const absent = storedKeys.every((key) => row[key] == null);
      if (absent) return { disposition: "ABSENT" };
      if (input.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        || !verifyGeneratedAssetObjectKey(input)
        || storedKeys.some((key) => row[key] !== input[key])) throw invalid();
      for (const key of storedKeys) row[key] = null;
      return { disposition: "REVERTED" };
    },
    async findStoredGenerationAsset(input) {
      const row = await own(input);
      if (row.finalInputBoundAt === null) throw invalid();
      if (row.contentHash !== input.contentHash
        || row.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        || !verifyGeneratedAssetObjectKey(row)) return null;
      return copy(row);
    },
    snapshot() { return copy(rows); },
  });
}
