import assert from "node:assert/strict";
import test from "node:test";

import { createListingAssetPublicationRuntime } from "../listing-asset-publication-runtime.mjs";

const config = Object.freeze({
  baseUrl: "https://media.example.com/ozon/",
  prefix: "listing-media/v1",
  publicationVersion: "LISTING_MEDIA_V1",
});

function harness({ readyEvidence = null, probe = null } = {}) {
  const calls = [];
  let publicationPorts;
  let cleanupPorts;
  const publicationRepository = { async findPublication() {}, async loadAcceptedAsset() {}, async recordPublication() {} };
  const cleanupRepository = {
    async recordCleanupRequired(input) { calls.push(["cleanup-record", input]); return input; },
    async listRunnableCleanupTasks(input) { calls.push(["cleanup-list", input]); return []; },
    async claimCleanup() {}, async completeCleanup() {}, async failCleanup() {},
  };
  const healthRepository = {
    async findReadyEvidence(input) { calls.push(["health-find", input]); return readyEvidence; },
    async recordEvidence(input) { calls.push(["health-record", input]); return { id: "health-a", ...input }; },
  };
  const runtime = createListingAssetPublicationRuntime({
    config,
    storage: {
      async putObjectFromBuffer(input) { calls.push(["storage-put", input]); return input; },
      async getObjectBuffer(key, options) { calls.push(["storage-get", { key, options }]); return Buffer.from("x"); },
      async removeObject(key) { calls.push(["storage-remove", key]); },
    },
    publicationRepository, cleanupRepository, healthRepository,
    probePublicPolicy: probe,
    createPublicationService(ports) {
      publicationPorts = ports;
      return { async publishListingAsset(input) { calls.push(["publish", input]); return input; } };
    },
    createCleanupWorker(ports) {
      cleanupPorts = ports;
      return { async processCleanup(input) { calls.push(["cleanup", input]); return input; } };
    },
    clock: () => new Date("2026-08-08T00:00:00Z"),
  });
  return { runtime, calls, publicationPorts, cleanupPorts };
}

test("runtime composes one publication boundary and dedicated public-prefix storage ports without side effects", async () => {
  const h = harness();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.runtime.publicationPolicy, {
    origin: "https://media.example.com", baseUrl: config.baseUrl, prefix: config.prefix,
    publicationVersion: config.publicationVersion,
  });
  assert.throws(() => h.publicationPorts.putPublicObject({ key: "other/key.png", buffer: Buffer.from("x") }), {
    code: "LISTING_ASSET_PUBLICATION_POLICY_BOUNDARY",
  });
  assert.throws(() => h.cleanupPorts.removePublicObject({ key: "other/key.png" }), {
    code: "LISTING_ASSET_PUBLICATION_POLICY_BOUNDARY",
  });
  assert.deepEqual(h.calls, []);
  await h.publicationPorts.putPublicObject({ key: "listing-media/v1/aa/file.png", buffer: Buffer.from("x") });
  await h.publicationPorts.readPublicObject({ key: "listing-media/v1/aa/file.png", maxBytes: 10 });
  assert.deepEqual(h.calls.map(([name]) => name), ["storage-put", "storage-get"]);
});

test("runtime cleanup batch polls durable obligations without exposing cross-account task data", async () => {
  const h = harness();
  const result = await h.runtime.runCleanupBatch({ workerId: "worker-a", limit: 25 });
  assert.deepEqual(result, { scanned: 0, cleaned: 0, referenced: 0, failed: 0 });
  assert.deepEqual(h.calls, [["cleanup-list", { limit: 25 }]]);
});

test("DIRECT remains fail-closed until unexpired exact-policy health evidence exists", async () => {
  const missing = harness();
  await assert.rejects(missing.runtime.assertDirectReady({ accountId: "account-a" }), {
    code: "LISTING_ASSET_PUBLICATION_NOT_READY",
  });
  const wrong = harness({ readyEvidence: {
    id: "health-old", accountId: "account-a", publicationVersion: "LISTING_MEDIA_V1",
    publicBaseUrl: "https://old.example.com/", publicPrefix: config.prefix,
    outcome: "PASSED", expiresAt: "2026-08-08T00:05:00.000Z",
  } });
  await assert.rejects(wrong.runtime.assertDirectReady({ accountId: "account-a" }), {
    code: "LISTING_ASSET_PUBLICATION_NOT_READY",
  });
  const valid = harness({ readyEvidence: {
    id: "health-a", accountId: "account-a", publicationVersion: config.publicationVersion,
    publicBaseUrl: config.baseUrl, publicPrefix: config.prefix,
    outcome: "PASSED", expiresAt: "2026-08-08T00:05:00.000Z",
  } });
  assert.deepEqual(await valid.runtime.assertDirectReady({ accountId: "account-a" }), {
    ready: true, evidenceId: "health-a", publicationVersion: config.publicationVersion,
    expiresAt: "2026-08-08T00:05:00.000Z",
  });
});

test("health check records only bounded non-secret probe evidence and does not run at construction", async () => {
  let probes = 0;
  const h = harness({ probe: async (policy) => {
    probes += 1;
    assert.deepEqual(policy, h.runtime.publicationPolicy);
    return { ok: true, evidence: { probeKind: "PUBLIC_READBACK", httpStatus: 200, contentTypeMatched: true, bytesMatched: true } };
  } });
  assert.equal(probes, 0);
  const result = await h.runtime.checkPublicationHealth({ accountId: "account-a", checkedByAccountId: "account-a" });
  assert.equal(probes, 1);
  assert.equal(result.outcome, "PASSED");
  const record = h.calls.find(([name]) => name === "health-record")[1];
  assert.deepEqual(record.evidence, { probeKind: "PUBLIC_READBACK", httpStatus: 200, contentTypeMatched: true, bytesMatched: true });
  assert.equal(JSON.stringify(record).includes("secret"), false);
  assert.equal(Object.hasOwn(record.evidence, "url"), false);
});
