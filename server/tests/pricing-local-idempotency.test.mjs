import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPricingIdempotencyState } from "../pricing-idempotency-state.mjs";
import { savePricingSnapshot } from "../pricing-config-service.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pricing-idem-"));
const adapter = createPricingIdempotencyState({ dataFile: path.join(dir, "state.json") });
const scope = { accountId: "a", storeId: "s", action: "PRICING_SNAPSHOT", key: "k" };
let writes = 0;
const first = await adapter.run(scope, "hash-a", async () => ({ id: "snapshot-" + (++writes) }));
const replay = await adapter.run(scope, "hash-a", async () => ({ id: "snapshot-" + (++writes) }));
assert.deepEqual(replay, first); assert.equal(writes, 1);
await assert.rejects(() => adapter.run(scope, "hash-b", async () => ({})), (e) => e?.status === 409 && e?.code === "IDEMPOTENCY_KEY_REUSED");
assert.notDeepEqual(await adapter.run({ ...scope, storeId: "s2" }, "hash-a", async () => ({ id: "snapshot-" + (++writes) })), first);
const adapterTwo = createPricingIdempotencyState({ dataFile: path.join(dir, "state.json") });
const concurrent = await Promise.all([
  adapter.run({ ...scope, key: "shared" }, "same", async () => ({ id: "shared-" + (++writes) })),
  adapterTwo.run({ ...scope, key: "shared" }, "same", async () => ({ id: "shared-" + (++writes) })),
]);
assert.deepEqual(concurrent[0], concurrent[1]);
const args = { accountId: "local-a", storeId: "local-s", input: {}, result: { mode: "profit" }, config: { id: "cfg" }, idempotencyKey: "local-key", payloadHash: "local-hash", localIdempotencyAdapter: adapter };
const saved = await savePricingSnapshot(args);
assert.deepEqual(await savePricingSnapshot(args), saved);
await assert.rejects(() => savePricingSnapshot({ ...args, payloadHash: "different" }), (e) => e?.code === "IDEMPOTENCY_KEY_REUSED");
console.log("pricing local idempotency tests passed");
