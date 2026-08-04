import crypto from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const scopeKeys = ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey"];
const clean = (value) => typeof value === "string" && value.trim() && value === value.trim() ? value : "";
const copy = (value) => structuredClone(value);
const keyOf = (input) => scopeKeys.map((key) => input[key]).join("\u0001");
function invalid() { const error = new Error("图片生成尝试无效"); error.code = "AUTO_LISTING_IMAGE_ATTEMPT_INVALID"; return error; }
function fence(input) {
  if (!input || !scopeKeys.every((key) => clean(input[key])) || !HASH.test(input.inputHash || "")) throw invalid();
  return keyOf(input);
}

/**
 * Deterministic reference adapter for unit tests and non-PG composition.  It
 * defines the same account/job/item/plan/slot fence that the durable Task 6
 * adapter must enforce transactionally; it never crosses a caller's scope.
 */
export function createMemoryGenerationAttemptRepository({ now = () => Date.now(), leaseMs = 60_000, token = () => crypto.randomUUID() } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || typeof now !== "function" || typeof token !== "function") throw invalid();
  const rows = [];
  const matching = (input) => rows.filter((row) => keyOf(row) === keyOf(input) && row.inputHash === input.inputHash);
  const own = (input) => {
    const row = rows.find((candidate) => candidate.attemptNo === input.attemptNo && keyOf(candidate) === keyOf(input) && candidate.inputHash === input.inputHash);
    if (!row || row.leaseToken !== input.leaseToken || row.status !== "GENERATING") throw invalid();
    return row;
  };
  return Object.freeze({
    async reserveGenerationAttempt(input) {
      fence(input);
      if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3) throw invalid();
      const current = matching(input);
      const accepted = current.find((row) => row.status === "ACCEPTED");
      if (accepted) return { status: "EXISTING_ACCEPTED", record: copy(accepted) };
      const timestamp = now();
      const active = current.find((row) => row.status === "GENERATING" && row.leaseExpiresAt > timestamp);
      if (active) return { status: "IN_PROGRESS" };
      for (const row of current) if (row.status === "GENERATING" && row.leaseExpiresAt <= timestamp) { row.status = "FAILED"; row.errorCode = "LEASE_EXPIRED"; row.errorRetryable = true; row.leaseToken = null; row.leaseExpiresAt = null; }
      const attemptNo = current.reduce((maximum, row) => Math.max(maximum, row.attemptNo), 0) + 1;
      if (attemptNo > input.maxAttempts) return { status: "ATTEMPTS_EXHAUSTED" };
      const leaseToken = clean(token()); if (!leaseToken) throw invalid();
      rows.push({ ...Object.fromEntries(scopeKeys.map((key) => [key, input[key]])), inputHash: input.inputHash, attemptNo, status: "GENERATING", leaseToken, leaseExpiresAt: timestamp + leaseMs });
      return { status: "RESERVED", attemptNo, leaseToken };
    },
    async recordStoredGenerationAsset(input) { const row = own(input); Object.assign(row, copy({ objectKey: input.objectKey, contentHash: input.contentHash, contentType: input.contentType, width: input.width, height: input.height, size: input.size })); },
    async completeGenerationAttempt(input) { const row = own(input); Object.assign(row, copy(input), { status: "ACCEPTED", leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async rejectGenerationAttempt(input) { const row = own(input); Object.assign(row, copy(input), { status: "REJECTED", leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async failGenerationAttempt(input) { const row = own(input); Object.assign(row, copy(input), { status: "FAILED", leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async releaseGenerationLease(input) { const row = own(input); Object.assign(row, { status: "FAILED", errorCode: clean(input.errorCode) || "AUTO_LISTING_IMAGE_FAILED", errorRetryable: true, leaseToken: null, leaseExpiresAt: null }); return copy(row); },
    async findStoredGenerationAsset(input) { fence(input); const row = matching(input).find((candidate) => candidate.contentHash === input.contentHash && clean(candidate.objectKey)); return row ? copy(row) : null; },
    snapshot() { return copy(rows); },
  });
}
