import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonAtomically } from "./json-state-writer.mjs";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const pathLocks = new Map();

export function createPricingIdempotencyState({ dataFile, fsApi = fs } = {}) {
  if (!dataFile) throw new Error("pricing idempotency dataFile required");
  const absoluteDataFile = path.resolve(dataFile);
  const scopeKey = ({ accountId = "", storeId = "", action = "", key = "" }) => [accountId, storeId, action, key].join(":");
  async function read() {
    try { return JSON.parse(await fsApi.readFile(absoluteDataFile, "utf8")); } catch (error) { if (error?.code === "ENOENT") return { records: {} }; throw error; }
  }
  async function run(scope, payloadHash, write) {
    const key = scopeKey(scope);
    if (!scope.accountId || !scope.storeId || scope.action !== "PRICING_SNAPSHOT" || !scope.key) throw new Error("PRICING_IDEMPOTENCY_SCOPE_REQUIRED");
    const lockKey = `${absoluteDataFile}:${key}`;
    if (pathLocks.has(lockKey)) return pathLocks.get(lockKey);
    const flight = (async () => {
      const state = await read();
      state.records ||= {};
      const now = Date.now();
      for (const [recordKey, record] of Object.entries(state.records)) {
        if (!record || !record.createdAt || record.expiresAt <= now) delete state.records[recordKey];
      }
      const existing = state.records?.[key];
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw Object.assign(new Error("幂等键已用于不同请求"), { status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
        return existing.response;
      }
      const response = await write();
      state.records[key] = { payloadHash, response, createdAt: now, expiresAt: now + RETENTION_MS };
      await writeJsonAtomically({ fsApi, dataDir: path.dirname(absoluteDataFile), dataFile: absoluteDataFile, value: state });
      return response;
    })();
    pathLocks.set(lockKey, flight);
    try { return await flight; } finally { pathLocks.delete(lockKey); }
  }
  return Object.freeze({ run });
}
