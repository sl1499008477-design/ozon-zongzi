import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPricingIdempotencyState } from "../pricing-idempotency-state.mjs";
import { savePricingSnapshot } from "../pricing-config-service.mjs";

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousPostgresHost = process.env.POSTGRES_HOST;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

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
const writesBeforeSharedReplay = writes;
const concurrent = await Promise.all([
  adapter.run({ ...scope, key: "shared" }, "same", async () => ({ id: "shared-" + (++writes) })),
  adapterTwo.run({ ...scope, key: "shared" }, "same", async () => ({ id: "shared-" + (++writes) })),
]);
assert.deepEqual(concurrent[0], concurrent[1]);
assert.equal(writes, writesBeforeSharedReplay + 1, "same key and payload must execute one business write");

const differentKeyFile = path.join(dir, "different-keys.json");
const differentKeyAdapterA = createPricingIdempotencyState({ dataFile: differentKeyFile });
const differentKeyAdapterB = createPricingIdempotencyState({ dataFile: path.join(dir, ".", "different-keys.json") });
await Promise.all([
  differentKeyAdapterA.run({ ...scope, key: "key-a" }, "hash-a", async () => ({ id: "snapshot-a" })),
  differentKeyAdapterB.run({ ...scope, key: "key-b" }, "hash-b", async () => ({ id: "snapshot-b" })),
]);
const differentKeyState = JSON.parse(await fs.readFile(differentKeyFile, "utf8"));
assert.deepEqual(
  Object.values(differentKeyState.records).map((record) => record.response.id).sort(),
  ["snapshot-a", "snapshot-b"],
  "different business keys in one state file must survive concurrent read-modify-write",
);

let conflictingWrites = 0;
const conflictingFile = path.join(dir, "conflicting.json");
const conflictResults = await Promise.allSettled([
  createPricingIdempotencyState({ dataFile: conflictingFile }).run(
    { ...scope, key: "conflict" },
    "payload-a",
    async () => ({ id: `conflict-${++conflictingWrites}` }),
  ),
  createPricingIdempotencyState({ dataFile: conflictingFile }).run(
    { ...scope, key: "conflict" },
    "payload-b",
    async () => ({ id: `conflict-${++conflictingWrites}` }),
  ),
]);
assert.equal(conflictingWrites, 1, "one idempotency key may execute only one business write");
assert.equal(conflictResults.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(conflictResults.filter((result) => result.status === "rejected" && result.reason?.code === "IDEMPOTENCY_KEY_REUSED").length, 1);

const retentionFile = path.join(dir, "retention.json");
await fs.writeFile(retentionFile, JSON.stringify({
  records: {
    expired: {
      payloadHash: "expired",
      response: { id: "expired" },
      createdAt: 1,
      expiresAt: 2,
    },
    retained: {
      payloadHash: "retained",
      response: { id: "retained" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  },
}));
await createPricingIdempotencyState({ dataFile: retentionFile }).run(
  { ...scope, key: "fresh" },
  "fresh",
  async () => ({ id: "fresh" }),
);
const retainedState = JSON.parse(await fs.readFile(retentionFile, "utf8"));
assert.equal(retainedState.records.expired, undefined);
assert.equal(retainedState.records.retained.response.id, "retained");
assert.equal(retainedState.records["a:s:PRICING_SNAPSHOT:fresh"].response.id, "fresh");

const args = { accountId: "local-a", storeId: "local-s", input: {}, result: { mode: "profit" }, config: { id: "cfg" }, idempotencyKey: "local-key", payloadHash: "local-hash", localIdempotencyAdapter: adapter };
const saved = await savePricingSnapshot(args);
assert.deepEqual(await savePricingSnapshot(args), saved);
await assert.rejects(() => savePricingSnapshot({ ...args, payloadHash: "different" }), (e) => e?.code === "IDEMPOTENCY_KEY_REUSED");

const defaultStateFile = path.join(dir, "default-save-pricing-snapshot.json");
const previousStateFile = process.env.PRICING_IDEMPOTENCY_STATE_FILE;
process.env.PRICING_IDEMPOTENCY_STATE_FILE = defaultStateFile;
try {
  const defaultBase = {
    accountId: "default-account",
    storeId: "default-store",
    input: {},
    result: { mode: "profit" },
    config: { id: "default-config" },
  };
  await Promise.all([
    savePricingSnapshot({ ...defaultBase, idempotencyKey: "default-a", payloadHash: "default-hash-a" }),
    savePricingSnapshot({ ...defaultBase, idempotencyKey: "default-b", payloadHash: "default-hash-b" }),
  ]);
  const defaultDifferentKeyState = JSON.parse(await fs.readFile(defaultStateFile, "utf8"));
  assert.equal(Object.keys(defaultDifferentKeyState.records).length, 2, "default production wiring must serialize the shared file");

  const defaultSameKey = await Promise.all([
    savePricingSnapshot({ ...defaultBase, idempotencyKey: "default-same", payloadHash: "same" }),
    savePricingSnapshot({ ...defaultBase, idempotencyKey: "default-same", payloadHash: "same" }),
  ]);
  assert.equal(defaultSameKey[0].id, defaultSameKey[1].id, "same key must replay the first default-wired snapshot");
  const defaultSameKeyState = JSON.parse(await fs.readFile(defaultStateFile, "utf8"));
  assert.equal(Object.keys(defaultSameKeyState.records).length, 3, "same default-wired key must persist one record");

  const defaultConflict = await Promise.allSettled([
    savePricingSnapshot({ ...defaultBase, idempotencyKey: "default-conflict", payloadHash: "left" }),
    savePricingSnapshot({ ...defaultBase, idempotencyKey: "default-conflict", payloadHash: "right" }),
  ]);
  assert.equal(defaultConflict.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(defaultConflict.filter((result) => result.status === "rejected" && result.reason?.code === "IDEMPOTENCY_KEY_REUSED").length, 1);
} finally {
  if (previousStateFile === undefined) delete process.env.PRICING_IDEMPOTENCY_STATE_FILE;
  else process.env.PRICING_IDEMPOTENCY_STATE_FILE = previousStateFile;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousPostgresHost === undefined) delete process.env.POSTGRES_HOST;
  else process.env.POSTGRES_HOST = previousPostgresHost;
}
console.log("pricing local idempotency tests passed");
