import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonAtomically } from "./json-state-writer.mjs";

export function createPricingIdempotencyState({ dataFile, fsApi = fs } = {}) {
  if (!dataFile) throw new Error("pricing idempotency dataFile required");
  const locks = new Map();
  const scopeKey = ({ accountId = "", storeId = "", action = "", key = "" }) => [accountId, storeId, action, key].join(":");
  async function read() {
    try { return JSON.parse(await fsApi.readFile(dataFile, "utf8")); } catch (error) { if (error?.code === "ENOENT") return { records: {} }; throw error; }
  }
  async function run(scope, payloadHash, write) {
    const key = scopeKey(scope);
    if (!scope.accountId || !scope.storeId || scope.action !== "PRICING_SNAPSHOT" || !scope.key) throw new Error("PRICING_IDEMPOTENCY_SCOPE_REQUIRED");
    if (locks.has(key)) return locks.get(key);
    const flight = (async () => {
      const state = await read();
      const existing = state.records?.[key];
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw Object.assign(new Error("幂等键已用于不同请求"), { status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
        return existing.response;
      }
      const response = await write();
      state.records ||= {};
      state.records[key] = { payloadHash, response };
      await writeJsonAtomically({ fsApi, dataDir: path.dirname(dataFile), dataFile, value: state });
      return response;
    })();
    locks.set(key, flight);
    try { return await flight; } finally { locks.delete(key); }
  }
  return Object.freeze({ run });
}
