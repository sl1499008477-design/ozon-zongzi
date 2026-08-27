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
const copy = (value) => structuredClone(value);
const keyOf = (input) => [...scopeKeys.map((key) => input[key]), input.expectedStatusVersion ?? "legacy"].join("\u0001");
function invalid() { const error = new Error("图片生成尝试无效"); error.code = "AUTO_LISTING_IMAGE_ATTEMPT_INVALID"; return error; }
function fence(input, hashKey = "attemptIdentityHash") {
  if (!input || !scopeKeys.every((key) => clean(input[key])) || !HASH.test(input[hashKey] || "")
    || (Object.hasOwn(input, "legacyAttemptIdentityHash")
      && (!HASH.test(input.legacyAttemptIdentityHash || "") || input.legacyAttemptIdentityHash === input.attemptIdentityHash))
    || !validGenerationSize(input.generationSize)
    || (Object.hasOwn(input, "expectedStatusVersion") && (!Number.isInteger(input.expectedStatusVersion)
      || input.expectedStatusVersion < 1 || input.expectedStatusVersion > 2_147_483_647))) throw invalid();
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
    let state;
    try {
      state = readItemState === null
        ? { status: "GENERATING", statusVersion: input.expectedStatusVersion, activeContentPlanId: input.planId }
        : await readItemState(Object.freeze({
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
  const own = (input) => {
    fence(input);
    const row = rows.find((candidate) => candidate.attemptNo === input.attemptNo && keyOf(candidate) === keyOf(input)
      && candidate.attemptIdentityHash === input.attemptIdentityHash);
    if (!row || row.leaseToken !== input.leaseToken || row.status !== "GENERATING"
      || row.generationSize !== input.generationSize) throw invalid();
    if (row.finalInputBoundAt !== null && input.inputHash !== row.inputHash) throw invalid();
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
      for (const row of current) if (row.status === "GENERATING" && row.leaseExpiresAt <= timestamp) { row.status = "FAILED"; row.errorCode = "LEASE_EXPIRED"; row.errorRetryable = true; row.leaseToken = null; row.leaseExpiresAt = null; }
      const attemptNo = current.reduce((maximum, row) => Math.max(maximum, row.attemptNo), 0) + 1;
      if (attemptNo > input.maxAttempts) return { status: "ATTEMPTS_EXHAUSTED" };
      const leaseToken = clean(token()); if (!leaseToken) throw invalid();
      rows.push({ ...Object.fromEntries(scopeKeys.map((key) => [key, input[key]])),
        ...(Object.hasOwn(input, "expectedStatusVersion") ? { expectedStatusVersion: input.expectedStatusVersion } : {}),
        attemptIdentityHash: input.attemptIdentityHash, inputHash: input.attemptIdentityHash,
        generationSize: input.generationSize, finalInputBoundAt: null, attemptNo, status: "GENERATING",
        leaseToken, leaseExpiresAt: timestamp + leaseMs });
      return { status: "RESERVED", attemptNo, leaseToken, generationSize: input.generationSize };
    },
    async bindGenerationAttemptInput(input) {
      if (!HASH.test(input?.inputHash || "")) throw invalid();
      const row = own(input);
      if (row.finalInputBoundAt !== null) return { status: "BOUND", inputHash: row.inputHash };
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
      return { status: "BOUND", inputHash: input.inputHash,
        ...(recoveryRecord ? { recoveryRecord: copy(recoveryRecord) } : {}) };
    },
    async recordStoredGenerationAsset(input) {
      const row = own(input);
      if (row.finalInputBoundAt === null || input.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        || !verifyGeneratedAssetObjectKey(input)) throw invalid();
      Object.assign(row, copy({ objectKeyVersion: input.objectKeyVersion, objectKey: input.objectKey, contentHash: input.contentHash, contentType: input.contentType, width: input.width, height: input.height, size: input.size }));
      return copy(row);
    },
    async completeGenerationAttempt(input) {
      const row = own(input);
      if (row.finalInputBoundAt === null || input.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        || !verifyGeneratedAssetObjectKey(input)) throw invalid();
      Object.assign(row, copy(input), { status: "ACCEPTED", leaseToken: null, leaseExpiresAt: null });
      return copy(row);
    },
    async rejectGenerationAttempt(input) { const row = own(input); if (row.finalInputBoundAt === null) throw invalid(); Object.assign(row, copy(input), { status: "REJECTED", leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async failGenerationAttempt(input) {
      const row = own(input);
      Object.assign(row, copy(input), {
        status: "FAILED", errorCode: input.code, errorRetryable: input.retryable,
        leaseToken: null, leaseExpiresAt: null,
      });
      return copy(row);
    },
    async releaseGenerationLease(input) { const row = own(input); Object.assign(row, { status: "FAILED", errorCode: clean(input.errorCode) || "AUTO_LISTING_IMAGE_FAILED", errorRetryable: true, leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async findStoredGenerationAsset(input) {
      fence(input, "inputHash");
      if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3) throw invalid();
      const row = rows.find((candidate) => keyOf(candidate) === keyOf(input)
        && candidate.attemptIdentityHash === input.attemptIdentityHash && candidate.attemptNo === input.attemptNo
        && candidate.inputHash === input.inputHash && candidate.generationSize === input.generationSize
        && candidate.contentHash === input.contentHash && candidate.objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
        && verifyGeneratedAssetObjectKey(candidate));
      return row ? copy(row) : null;
    },
    snapshot() { return copy(rows); },
  });
}
