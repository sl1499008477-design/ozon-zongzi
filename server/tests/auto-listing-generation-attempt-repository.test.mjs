import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAssetObjectKey } from "../auto-listing-asset-store.mjs";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "group-a", slotKey: "main" });
const attemptIdentityHash = "a".repeat(64);
const inputHash = "b".repeat(64);
const generationSize = "768x1024";
const complete = (lease, identity = attemptIdentityHash) => {
  const value = { ...scope, attemptIdentityHash: identity, inputHash, generationSize, ...lease, objectKeyVersion: "ATTEMPT_V2", contentHash: "c".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123, profileId: "profile-a", profileVersion: 1, modelName: "image-a", planHash: "d".repeat(64), sourceHash: "e".repeat(64), strategyHash: "f".repeat(64), configHash: "1".repeat(64), visualGroupsHash: "2".repeat(64), promptTemplateVersion: "v1", checkerEvidence: { ok: true }, sourceAssetEvidence: [] };
  value.objectKey = buildGeneratedAssetObjectKey(value);
  return value;
};

test("one preliminary identity owns the lease, binds final bytes, and reuses accepted work", async () => {
  let timestamp = 100; let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({ now: () => timestamp, leaseMs: 10, token: () => `lease-${++sequence}` });
  const first = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  assert.deepEqual(await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 }), { status: "IN_PROGRESS" });
  timestamp = 111;
  const retry = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  assert.deepEqual(retry, {
    status: "RESERVED", attemptNo: 2, leaseToken: "lease-2", generationSize,
    gatewayConnectionId: null, gatewayConnectionVersion: null,
  });
  assert.deepEqual(await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...retry }), {
    status: "BOUND", inputHash, gatewayConnectionId: null, gatewayConnectionVersion: null,
  });
  const accepted = await repository.completeGenerationAttempt(complete(retry));
  assert.equal(accepted.status, "ACCEPTED");
  const reused = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  assert.equal(reused.status, "EXISTING_ACCEPTED"); assert.equal(reused.record.attemptNo, 2);
});

test("a new identity reuses an accepted legacy identity without creating a duplicate attempt", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-legacy" });
  const legacyIdentity = "9".repeat(64);
  const currentIdentity = "8".repeat(64);
  const lease = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash: legacyIdentity, generationSize, maxAttempts: 3,
  });
  await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash: legacyIdentity, inputHash, ...lease,
  });
  await repository.completeGenerationAttempt(complete(lease, legacyIdentity));

  const replay = await repository.reserveGenerationAttempt({
    ...scope,
    attemptIdentityHash: currentIdentity,
    legacyAttemptIdentityHash: legacyIdentity,
    generationSize,
    maxAttempts: 3,
  });

  assert.equal(replay.status, "EXISTING_ACCEPTED");
  assert.equal(replay.record.attemptIdentityHash, legacyIdentity);
  assert.equal(repository.snapshot().length, 1);
});

test("reservation requires and persists the exact generation size before final input binding", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-size" });
  await assert.rejects(
    repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, maxAttempts: 3 }),
    (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID",
  );
  const reserved = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  assert.equal(reserved.generationSize, generationSize);
  assert.equal(repository.snapshot()[0].generationSize, generationSize);
});

test("new accepted attempts require an exact ATTEMPT_V2 object-key audit", async () => {
  for (const mutation of [
    (value) => { delete value.objectKeyVersion; },
    (value) => { value.objectKeyVersion = "LEGACY_V1"; },
    (value) => { value.objectKey = value.objectKey.replace("/attempt-1/", "/attempt-2/"); },
  ]) {
    const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-v2" });
    const lease = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
    await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...lease });
    const value = complete(lease);
    value.objectKeyVersion = "ATTEMPT_V2";
    value.objectKey = buildGeneratedAssetObjectKey(value);
    mutation(value);
    await assert.rejects(repository.completeGenerationAttempt(value), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
    assert.equal(repository.snapshot()[0].status, "GENERATING");
  }
});

test("a later memory attempt reuses generated bytes after a checker contract failure", async () => {
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({ token: () => `lease-${++sequence}` });
  const first = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...first });
  const stored = complete(first);
  await repository.failGenerationAttempt({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...first,
    role: "MAIN", code: "CHECKER_RESPONSE_INVALID", retryable: true,
    gatewayRequestId: "gateway-1", checkerRequestId: "checker-2",
    objectKeyVersion: stored.objectKeyVersion, objectKey: stored.objectKey, contentHash: stored.contentHash,
    contentType: stored.contentType, width: stored.width, height: stored.height, size: stored.size,
    modelEvidence: { requestedImageModel: "image-a" },
    checkerEvidence: { version: "CHECKER_FAILURE_V1", failureCode: "CHECKER_RESPONSE_INVALID" },
  });

  const retry = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
  const bound = await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...retry });

  assert.equal(bound.status, "BOUND");
  assert.equal(bound.recoveryRecord.errorCode, "CHECKER_RESPONSE_INVALID");
  assert.equal(bound.recoveryRecord.objectKey, stored.objectKey);
  assert.equal(bound.recoveryRecord.checkerRequestId, "checker-2");
});

test("memory channel release reclaims the same attempt with stored-image parity and never spends business attempts", async () => {
  let timestamp = 100;
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({
    now: () => timestamp,
    leaseMs: 20,
    token: () => `channel-lease-${++sequence}`,
  });
  let owner = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  });
  await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...owner,
  });
  const stored = complete(owner);
  await repository.recordStoredGenerationAsset(stored);

  for (let index = 0; index < 4; index += 1) {
    const released = await repository.releaseGenerationLease({
      ...scope, attemptIdentityHash, inputHash, generationSize, ...owner,
      errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
      role: "MAIN", profileId: "profile-a", profileVersion: 1, modelName: "image-a",
      gatewayRequestId: "gateway-1", checkerRequestId: index === 0 ? "checker-1" : null,
      modelEvidence: { requestedImageModel: "image-a" },
    });
    assert.equal(released.status, "GENERATING");
    assert.equal(released.attemptNo, 1);
    assert.equal(released.leaseToken, "AUTO_LISTING_IMAGE_CHANNEL_RELEASED");
    timestamp += 1;
    owner = await repository.reserveGenerationAttempt({
      ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    });
    assert.equal(owner.status, "RESERVED");
    assert.equal(owner.attemptNo, 1);
    const rebound = await repository.bindGenerationAttemptInput({
      ...scope, attemptIdentityHash, inputHash, generationSize, ...owner,
    });
    assert.equal(rebound.status, "BOUND");
    assert.equal(rebound.recoveryRecord.objectKey, stored.objectKey);
    assert.equal(rebound.recoveryRecord.gatewayRequestId, "gateway-1");
  }
  assert.equal(repository.snapshot().length, 1);
});

test("memory channel release matches PostgreSQL when image delivery has no request or model evidence", async () => {
  let timestamp = 100;
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({
    now: () => timestamp,
    leaseMs: 20,
    token: () => `not-sent-${++sequence}`,
  });
  const owner = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  });
  await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...owner,
  });

  await repository.releaseGenerationLease({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...owner,
    errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
    role: "MAIN", profileId: "profile-a", profileVersion: 1, modelName: "image-a",
    gatewayRequestId: null, checkerRequestId: null, modelEvidence: null,
  });
  timestamp += 1;
  const reclaimed = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  });
  const rebound = await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...reclaimed,
  });

  assert.equal(reclaimed.attemptNo, 1);
  assert.equal(rebound.status, "BOUND");
  assert.equal(Object.hasOwn(rebound, "recoveryRecord"), false);
});

test("memory ordinary expiry and business failures still advance and exhaust the three-attempt budget", async () => {
  let timestamp = 100;
  let sequence = 0;
  const expired = createMemoryGenerationAttemptRepository({
    now: () => timestamp, leaseMs: 10, token: () => `expiry-${++sequence}`,
  });
  assert.equal((await expired.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  })).attemptNo, 1);
  timestamp = 111;
  assert.equal((await expired.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  })).attemptNo, 2);

  const business = createMemoryGenerationAttemptRepository({ token: () => `business-${++sequence}` });
  for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
    const lease = await business.reserveGenerationAttempt({
      ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    });
    assert.equal(lease.attemptNo, attemptNo);
    await business.bindGenerationAttemptInput({
      ...scope, attemptIdentityHash, inputHash, generationSize, ...lease,
    });
    await business.failGenerationAttempt({
      ...scope, attemptIdentityHash, inputHash, generationSize, ...lease,
      role: "MAIN", code: "AUTO_LISTING_IMAGE_BUSINESS_FAILED", retryable: true,
      gatewayRequestId: null, checkerRequestId: null,
    });
  }
  assert.deepEqual(await business.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
  }), { status: "ATTEMPTS_EXHAUSTED" });
});

test("every generation-attempt owner transition rejects a missing or changed generation size", async () => {
  const operations = [
    ["bind", async (repository, value) => repository.bindGenerationAttemptInput(value)],
    ["store", async (repository, value) => repository.recordStoredGenerationAsset({ ...value, objectKey: "auto-listing/a.png", contentHash: "c".repeat(64), contentType: "image/png", width: 768, height: 1024, size: 123 })],
    ["complete", async (repository, value) => repository.completeGenerationAttempt(complete(value))],
    ["reject", async (repository, value) => repository.rejectGenerationAttempt({ ...value, code: "POLICY", retryable: false })],
    ["fail", async (repository, value) => repository.failGenerationAttempt({ ...value, code: "GATEWAY", retryable: true })],
  ];
  for (const [name, operation] of operations) {
    for (const changed of [undefined, "900x1200"]) {
      const repository = createMemoryGenerationAttemptRepository({ token: () => `lease-${name}` });
      const lease = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 3 });
      const value = { ...scope, attemptIdentityHash, inputHash, ...lease, generationSize: changed };
      if (["store", "complete", "reject"].includes(name)) {
        await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...lease });
      }
      await assert.rejects(operation(repository, value), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID", `${name}:${changed}`);
      assert.equal(repository.snapshot()[0].status, "GENERATING", `${name}:${changed}`);
    }
  }
});

test("CAS terminal transitions reject wrong scope or lease and do not mutate another item", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-a" });
  const lease = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash, generationSize, maxAttempts: 2 });
  await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash, inputHash, ...lease });
  await assert.rejects(repository.completeGenerationAttempt(complete({ ...lease, accountId: "account-b" })), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  await assert.rejects(repository.rejectGenerationAttempt({ ...scope, attemptIdentityHash, inputHash, ...lease, leaseToken: "wrong", code: "POLICY" }), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  assert.equal(repository.snapshot()[0].status, "GENERATING");
});

test("an exact gateway connection pair owns every memory attempt transition", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-connection-a" });
  const connectionA = { gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4 };
  const connectionB = { gatewayConnectionId: "connection-b", gatewayConnectionVersion: 5 };
  const lease = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3, ...connectionA,
  });
  await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...lease, ...connectionA,
  });
  const before = repository.snapshot();

  await assert.rejects(
    repository.completeGenerationAttempt({ ...complete(lease), ...connectionB }),
    (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID",
  );
  assert.deepEqual(repository.snapshot(), before);

  const accepted = await repository.completeGenerationAttempt({ ...complete(lease), ...connectionA });
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.gatewayConnectionId, connectionA.gatewayConnectionId);
  assert.equal(accepted.gatewayConnectionVersion, connectionA.gatewayConnectionVersion);
});

test("memory channel reclaim transfers ownership to only the newly reserved exact connection pair", async () => {
  let timestamp = 100;
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({
    now: () => timestamp, leaseMs: 20, token: () => `lease-pair-${++sequence}`,
  });
  const connectionA = { gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4 };
  const connectionB = { gatewayConnectionId: "connection-b", gatewayConnectionVersion: 5 };
  const first = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3, ...connectionA,
  });
  await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...first, ...connectionA,
  });
  await repository.releaseGenerationLease({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...first, ...connectionA,
    errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
    role: "MAIN", profileId: "profile-a", profileVersion: 1, modelName: "image-a",
    gatewayRequestId: null, checkerRequestId: null, modelEvidence: null,
  });
  timestamp += 1;
  const reclaimed = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3, ...connectionB,
  });
  const ownerB = {
    ...scope, attemptIdentityHash, inputHash, generationSize, ...reclaimed, ...connectionB,
  };
  await repository.bindGenerationAttemptInput(ownerB);
  const before = repository.snapshot();

  await assert.rejects(
    repository.failGenerationAttempt({ ...ownerB, ...connectionA, code: "STALE_OWNER", retryable: true }),
    (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID",
  );
  assert.deepEqual(repository.snapshot(), before);
  assert.equal((await repository.failGenerationAttempt({
    ...ownerB, code: "CURRENT_OWNER", retryable: true,
  })).status, "FAILED");
});

test("memory reclaim keeps producer A when connection B reuses A's stored paid image", async () => {
  let timestamp = 100;
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({
    now: () => timestamp, leaseMs: 20, token: () => `producer-${++sequence}`,
  });
  const connectionA = { gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4 };
  const connectionB = { gatewayConnectionId: "connection-b", gatewayConnectionVersion: 5 };
  const first = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3, ...connectionA,
  });
  const ownerA = { ...scope, attemptIdentityHash, inputHash, generationSize, ...first, ...connectionA };
  await repository.bindGenerationAttemptInput(ownerA);
  const stored = complete(ownerA);
  await repository.recordStoredGenerationAsset(stored);
  await repository.releaseGenerationLease({
    ...ownerA, errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
    role: "MAIN", profileId: "profile-a", profileVersion: 1, modelName: "image-a",
    gatewayRequestId: "gateway-a", checkerRequestId: null,
    modelEvidence: { requestedImageModel: "image-a" },
  });
  timestamp += 1;
  const reclaimed = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3, ...connectionB,
  });

  assert.equal(reclaimed.gatewayConnectionId, "connection-a");
  assert.equal(reclaimed.gatewayConnectionVersion, 4);
  const rebound = await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...reclaimed,
    gatewayConnectionId: reclaimed.gatewayConnectionId,
    gatewayConnectionVersion: reclaimed.gatewayConnectionVersion,
  });
  assert.equal(rebound.recoveryRecord.gatewayConnectionId, "connection-a");
});

test("legacy memory attempts retain exact null gateway provenance compatibility", async () => {
  const repository = createMemoryGenerationAttemptRepository({ token: () => "lease-legacy-null" });
  const lease = await repository.reserveGenerationAttempt({
    ...scope, attemptIdentityHash, generationSize, maxAttempts: 3,
    gatewayConnectionId: null, gatewayConnectionVersion: null,
  });
  await repository.bindGenerationAttemptInput({
    ...scope, attemptIdentityHash, inputHash, generationSize, ...lease,
    gatewayConnectionId: null, gatewayConnectionVersion: null,
  });
  const accepted = await repository.completeGenerationAttempt({
    ...complete(lease), gatewayConnectionId: null, gatewayConnectionVersion: null,
  });
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.gatewayConnectionId, null);
  assert.equal(accepted.gatewayConnectionVersion, null);
});

test("final input binding returns accepted reuse or a stable conflict before duplicate side effects", async () => {
  let sequence = 0;
  const repository = createMemoryGenerationAttemptRepository({ token: () => `lease-${++sequence}` });
  const firstIdentity = "3".repeat(64);
  const secondIdentity = "4".repeat(64);
  const first = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: firstIdentity, generationSize, maxAttempts: 3 });
  const second = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: secondIdentity, generationSize, maxAttempts: 3 });
  assert.deepEqual(await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash: firstIdentity, inputHash, ...first }), {
    status: "BOUND", inputHash, gatewayConnectionId: null, gatewayConnectionVersion: null,
  });
  assert.deepEqual(await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash: secondIdentity, inputHash, ...second }), { status: "VERSION_CONFLICT" });
  await repository.completeGenerationAttempt(complete(first, firstIdentity));
  const thirdIdentity = "5".repeat(64);
  const third = await repository.reserveGenerationAttempt({ ...scope, attemptIdentityHash: thirdIdentity, generationSize, maxAttempts: 3 });
  const reused = await repository.bindGenerationAttemptInput({ ...scope, attemptIdentityHash: thirdIdentity, inputHash, ...third });
  assert.equal(reused.status, "EXISTING_ACCEPTED");
  assert.equal(reused.record.inputHash, inputHash);
});

test("the versioned memory adapter matches the production stale/cancelled/active-plan fence before writes", async () => {
  for (const [state, expected] of [
    [{ status: "CANCELLED", statusVersion: 7, activeContentPlanId: scope.planId }, "CANCELLED"],
    [{ status: "GENERATING", statusVersion: 8, activeContentPlanId: scope.planId }, "STALE"],
    [{ status: "GENERATING", statusVersion: 7, activeContentPlanId: "plan-b" }, "STALE"],
  ]) {
    const repository = createMemoryGenerationAttemptRepository({ readItemState: async () => state });
    assert.deepEqual(await repository.reserveGenerationAttempt({
      ...scope, expectedStatusVersion: 7, attemptIdentityHash, generationSize, maxAttempts: 3,
    }), { status: expected });
    assert.deepEqual(repository.snapshot(), []);
  }
});

test("a versioned memory claim requires the live item-state reader instead of assuming CURRENT", async () => {
  const repository = createMemoryGenerationAttemptRepository();
  await assert.rejects(repository.reserveGenerationAttempt({
    ...scope, expectedStatusVersion: 7, attemptIdentityHash, generationSize, maxAttempts: 3,
  }), (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
  assert.deepEqual(repository.snapshot(), []);
});

test("every memory owner operation rejects expired, stale, cancelled, wrong-plan, stale-token, and cross-scope claims without mutation", async (t) => {
  const operations = {
    bind: async ({ repository, owner }) => repository.bindGenerationAttemptInput(owner),
    store: async ({ repository, owner, stored }) => repository.recordStoredGenerationAsset({ ...stored, ...owner }),
    complete: async ({ repository, owner }) => repository.completeGenerationAttempt(complete(owner)),
    reject: async ({ repository, owner }) => repository.rejectGenerationAttempt({ ...owner, code: "POLICY", retryable: false }),
    fail: async ({ repository, owner }) => repository.failGenerationAttempt({ ...owner, code: "GATEWAY", retryable: true }),
    release: async ({ repository, owner }) => repository.releaseGenerationLease({
      ...owner, errorCode: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED",
      role: "MAIN", profileId: "profile-a", profileVersion: 1, modelName: "image-a",
      gatewayRequestId: null, checkerRequestId: null, modelEvidence: null,
    }),
    revert: async ({ repository, owner, stored }) => repository.revertStoredGenerationAsset({ ...stored, ...owner }),
    find: async ({ repository, owner, stored }) => repository.findStoredGenerationAsset({ ...owner, contentHash: stored.contentHash }),
  };
  const fences = {
    expired: ({ setTimestamp }) => setTimestamp(111),
    stale_version: ({ itemState }) => { itemState.statusVersion = 8; },
    cancelled: ({ itemState }) => { itemState.status = "CANCELLED"; },
    wrong_plan: ({ itemState }) => { itemState.activeContentPlanId = "plan-b"; },
    stale_token: ({ owner }) => { owner.leaseToken = "stale-token"; },
    cross_scope: ({ owner }) => { owner.itemId = "item-b"; },
  };
  for (const [operationName, operation] of Object.entries(operations)) {
    for (const [fenceName, applyFence] of Object.entries(fences)) {
      await t.test(`${operationName}:${fenceName}`, async () => {
        let timestamp = 100;
        const itemState = { status: "GENERATING", statusVersion: 7, activeContentPlanId: scope.planId };
        const repository = createMemoryGenerationAttemptRepository({
          now: () => timestamp,
          leaseMs: 10,
          token: () => "lease-table",
          readItemState: async () => ({ ...itemState }),
        });
        const lease = await repository.reserveGenerationAttempt({
          ...scope, expectedStatusVersion: 7, attemptIdentityHash, generationSize, maxAttempts: 3,
        });
        const owner = {
          ...scope, expectedStatusVersion: 7, attemptIdentityHash, inputHash,
          generationSize, attemptNo: lease.attemptNo, leaseToken: lease.leaseToken,
        };
        if (operationName !== "bind") {
          await repository.bindGenerationAttemptInput(owner);
        }
        const stored = complete(owner);
        if (["revert", "find"].includes(operationName)) {
          await repository.recordStoredGenerationAsset({ ...owner, ...stored });
        }
        applyFence({ owner, itemState, setTimestamp(value) { timestamp = value; } });
        const before = repository.snapshot();

        await assert.rejects(operation({ repository, owner, stored }),
          (error) => error?.code === "AUTO_LISTING_IMAGE_ATTEMPT_INVALID");
        assert.deepEqual(repository.snapshot(), before);
      });
    }
  }
});
