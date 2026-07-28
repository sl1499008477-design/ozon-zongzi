import assert from "node:assert/strict";
import test from "node:test";
import { savePricingSnapshot } from "../pricing-config-service.mjs";

const cached = { id: "pcs_first", accountId: "acct_a", storeId: "store_a" };
function cachedPool(hash = "same") {
  const calls = [];
  return {
    calls,
    pool: { async connect() { return { async query(sql) {
      calls.push(String(sql));
      if (String(sql).startsWith("SELECT payload_hash")) return { rows: [{ payload_hash: hash, response_json: cached }] };
      return { rows: [], rowCount: 0 };
    }, release() {} }; } },
  };
}
const base = { accountId: "acct_a", storeId: "store_a", input: {}, result: { mode: "profit" }, config: { id: "cfg" }, idempotencyKey: "key-a", payloadHash: "same" };
test("same snapshot scope/key/payload replays first result without writes", async () => {
  const fixture = cachedPool();
  assert.deepEqual(await savePricingSnapshot({ ...base, transactionPool: fixture.pool }), cached);
  assert.equal(fixture.calls.some((sql) => sql.startsWith("INSERT INTO pricing_calculation_snapshots")), false);
});
test("same snapshot key with different payload fails closed", async () => {
  const fixture = cachedPool("other");
  await assert.rejects(() => savePricingSnapshot({ ...base, transactionPool: fixture.pool }), (error) => error?.status === 409 && error?.code === "IDEMPOTENCY_KEY_REUSED");
});
