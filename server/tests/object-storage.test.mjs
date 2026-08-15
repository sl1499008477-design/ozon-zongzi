import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createExpectedHashObjectStorage, createVersionFencedObjectRemover, readObjectStreamBounded,
} from "../object-storage.mjs";

const H = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("bounded object reads return exact bytes and destroy an overflowing stream", async () => {
  const bytes = await readObjectStreamBounded(Readable.from([Buffer.from("abc"), Buffer.from("def")]), { maxBytes: 6 });
  assert.equal(bytes.toString(), "abcdef");

  const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(3)]);
  let destroyed = false;
  const destroy = stream.destroy.bind(stream);
  stream.destroy = (...args) => { destroyed = true; return destroy(...args); };
  await assert.rejects(readObjectStreamBounded(stream, { maxBytes: 6 }), /对象超过读取限制/);
  assert.equal(destroyed, true);
});

test("bounded object reads reject invalid limits before consuming bytes", async () => {
  let reads = 0;
  const stream = new Readable({ read() { reads += 1; this.push(null); } });
  await assert.rejects(readObjectStreamBounded(stream, { maxBytes: 0 }), /对象读取大小限制无效/);
  assert.equal(reads, 0);
});

test("version-fenced deletion rejects the mutable null version before any remove call", async () => {
  let removes = 0;
  const remove = createVersionFencedObjectRemover({
    async statObject() { return { etag: "etag-a", versionId: "null" }; },
    async removeVersion() { removes += 1; },
  });
  await assert.rejects(remove("category-strategy/account-a/object.webp", "etag-a"), {
    code: "OBJECT_STORAGE_CONDITIONAL_DELETE_UNSUPPORTED",
  });
  assert.equal(removes, 0);
});

function rawMemoryStorage({ losePutResponse = false, loseRemoveResponse = false } = {}) {
  const objects = new Map();
  const calls = { puts: 0, reads: 0, removes: 0 };
  return {
    objects,
    calls,
    dependencies: {
      async putObject(input) {
        calls.puts += 1;
        if (input.ifNoneMatch === "*" && objects.has(input.key)) {
          throw Object.assign(new Error("already exists"), { code: "PreconditionFailed", statusCode: 412 });
        }
        objects.set(input.key, Buffer.from(input.buffer));
        if (losePutResponse) throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
        return { key: input.key, sha256: H(input.buffer), contentType: input.contentType, size: input.buffer.length };
      },
      async getObjectBuffer(key) {
        calls.reads += 1;
        if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
        return Buffer.from(objects.get(key));
      },
      async statObject(key) {
        if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
        const buffer = objects.get(key);
        return { etag: H(buffer), size: buffer.length, metaData: {} };
      },
      async removeObject(key, options = {}) {
        calls.removes += 1;
        if (options.expectedEtag && objects.has(key) && H(objects.get(key)) !== options.expectedEtag) {
          throw Object.assign(new Error("etag changed"), { code: "PreconditionFailed", statusCode: 412 });
        }
        if (!objects.delete(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
        if (loseRemoveResponse) throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
      },
    },
  };
}

const expectedPut = (buffer = Buffer.from("normalized-image")) => ({
  accountId: "account-a",
  key: `category-strategy/account-a/draft-a/set-a/sample-a/${H(buffer)}/analysis-${H(buffer)}.webp`,
  contentType: "image/webp",
  buffer,
  expectedSha256: H(buffer),
  maxBytes: 1024,
});

test("expected-hash put recovers response loss and exact replay performs no duplicate write", async () => {
  const raw = rawMemoryStorage({ losePutResponse: true });
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const input = expectedPut();
  const first = await storage.putObjectExpected(input);
  assert.deepEqual(first, {
    key: input.key, contentType: input.contentType, size: input.buffer.length,
    sha256: input.expectedSha256, created: false, recovered: true,
  });
  const replay = await storage.putObjectExpected(input);
  assert.equal(replay.created, false);
  assert.equal(replay.recovered, false);
  assert.equal(raw.calls.puts, 1);
  assert.equal(Object.isFrozen(first), true);
});

test("expected-hash API rejects wrong account prefixes before any storage call", async () => {
  const raw = rawMemoryStorage();
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const input = expectedPut();
  await assert.rejects(storage.putObjectExpected({ ...input, accountId: "account-b" }), {
    code: "EXPECTED_HASH_OBJECT_STORAGE_SCOPE_INVALID",
  });
  await assert.rejects(storage.readObjectExpected({
    accountId: "account-b", key: input.key, expectedSha256: input.expectedSha256, maxBytes: 1024,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_SCOPE_INVALID" });
  assert.deepEqual(raw.calls, { puts: 0, reads: 0, removes: 0 });
});

test("expected-hash API accepts a 1024-character key and rejects 1025 before storage", async () => {
  const raw = rawMemoryStorage();
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const prefix = "category-strategy/account-a/";
  const key1024 = `${prefix}${"a".repeat(1024 - prefix.length)}`;
  await assert.rejects(storage.readObjectExpected({
    accountId: "account-a", key: key1024, expectedSha256: "a".repeat(64), maxBytes: 1,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_NOT_FOUND" });
  assert.equal(raw.calls.reads, 1);

  const key1025 = `${key1024}a`;
  await assert.rejects(storage.readObjectExpected({
    accountId: "account-a", key: key1025, expectedSha256: "a".repeat(64), maxBytes: 1,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_SCOPE_INVALID" });
  assert.deepEqual(raw.calls, { puts: 0, reads: 1, removes: 0 });
});

test("cleanup removes only exact account-scoped expected bytes and recovers a lost response", async () => {
  const raw = rawMemoryStorage({ loseRemoveResponse: true });
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const input = expectedPut();
  await storage.putObjectExpected(input);
  const removed = await storage.removeObjectExpected({
    accountId: input.accountId, key: input.key, expectedSha256: input.expectedSha256, maxBytes: 1024,
  });
  assert.deepEqual(removed, { key: input.key, sha256: input.expectedSha256, removed: true, recovered: true });
  assert.equal(raw.objects.size, 0);

  const other = expectedPut(Buffer.from("other"));
  raw.objects.set(other.key, Buffer.from("different"));
  await assert.rejects(storage.removeObjectExpected({
    accountId: other.accountId, key: other.key, expectedSha256: other.expectedSha256, maxBytes: 1024,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_HASH_MISMATCH" });
  assert.equal(raw.objects.has(other.key), true);
});

test("expected cleanup retains a replacement installed after verification and before delete", async () => {
  const raw = rawMemoryStorage();
  const input = expectedPut();
  const replacement = Buffer.from("replacement-owned-by-another-writer");
  const originalRemove = raw.dependencies.removeObject;
  raw.dependencies.removeObject = async (key, options = {}) => {
    raw.objects.set(key, replacement);
    if (options.expectedEtag && H(raw.objects.get(key)) !== options.expectedEtag) {
      throw Object.assign(new Error("etag changed"), { code: "PreconditionFailed", statusCode: 412 });
    }
    return originalRemove(key, options);
  };
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  await storage.putObjectExpected(input);

  await assert.rejects(storage.removeObjectExpected({
    accountId: input.accountId, key: input.key, expectedSha256: input.expectedSha256, maxBytes: 1024,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_CLEANUP_FAILED", retryable: true });
  assert.deepEqual(raw.objects.get(input.key), replacement);
});

test("expected-hash put verifies bounded persisted bytes and removes a corrupt object from this attempt", async () => {
  const raw = rawMemoryStorage();
  const originalPut = raw.dependencies.putObject;
  raw.dependencies.putObject = async (input) => {
    const reply = await originalPut(input);
    raw.objects.set(input.key, Buffer.from("corrupt"));
    return reply;
  };
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  await assert.rejects(storage.putObjectExpected(expectedPut()), {
    code: "EXPECTED_HASH_OBJECT_STORAGE_HASH_MISMATCH",
  });
  assert.equal(raw.objects.size, 0);
  assert.equal(raw.calls.removes, 1);
});

test("concurrent expected-hash puts use create-if-absent so only one call owns cleanup", async () => {
  const raw = rawMemoryStorage();
  const originalRead = raw.dependencies.getObjectBuffer;
  let missingReads = 0;
  let releaseMissingReads;
  const bothMissing = new Promise((resolve) => { releaseMissingReads = resolve; });
  raw.dependencies.getObjectBuffer = async (...args) => {
    if (!raw.objects.has(args[0]) && missingReads < 2) {
      missingReads += 1;
      if (missingReads === 2) releaseMissingReads();
      await bothMissing;
    }
    return originalRead(...args);
  };
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const [first, second] = await Promise.all([
    storage.putObjectExpected(expectedPut()),
    storage.putObjectExpected(expectedPut()),
  ]);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(raw.calls.puts, 2);
  assert.equal(raw.objects.size, 1);
});

function ownershipMemoryStorage() {
  const objects = new Map();
  let version = 0;
  const loseResponses = new Set();
  const beforePut = new Map();
  const beforeRemove = new Map();
  const puts = [];
  const dependencies = {
    async putObject(input) {
      puts.push(input);
      await beforePut.get(input.key)?.(input);
      const current = objects.get(input.key);
      if (input.ifNoneMatch === "*" && current) {
        throw Object.assign(new Error("already exists"), { code: "PreconditionFailed", statusCode: 412 });
      }
      if (input.ifMatch && current?.etag !== input.ifMatch) {
        throw Object.assign(new Error("etag changed"), { code: "PreconditionFailed", statusCode: 412 });
      }
      version += 1;
      const etag = `etag-${version}`;
      objects.set(input.key, {
        buffer: Buffer.from(input.buffer), contentType: input.contentType,
        metadata: { ...(input.metadata || {}) }, etag,
      });
      if (loseResponses.delete(input.key)) throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
      return { key: input.key, sha256: H(input.buffer), contentType: input.contentType, size: input.buffer.length, etag };
    },
    async getObjectBuffer(key) {
      const value = objects.get(key);
      if (!value) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return Buffer.from(value.buffer);
    },
    async statObject(key) {
      const value = objects.get(key);
      if (!value) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return { etag: value.etag, size: value.buffer.length, metaData: { ...value.metadata } };
    },
    async removeObject(key, options = {}) {
      await beforeRemove.get(key)?.(key, options);
      const current = objects.get(key);
      if (options.expectedEtag && current?.etag !== options.expectedEtag) {
        throw Object.assign(new Error("etag changed"), { code: "PreconditionFailed", statusCode: 412 });
      }
      if (!objects.delete(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
    },
  };
  return { objects, dependencies, loseResponses, beforePut, beforeRemove, puts };
}

function manifestInput(ownerToken, generation = "generation-a") {
  const buffer = Buffer.from(JSON.stringify({ state: "PREPARING", inputHash: "a".repeat(64), generation }));
  return {
    accountId: "account-a",
    key: `category-strategy/account-a/draft-a/set-a/sample-a/manifests/${"a".repeat(64)}.json`,
    ownerToken,
    generation,
    buffer,
    expectedSha256: H(buffer),
    maxBytes: 64 * 1024,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("cleanup loses the PREPARING CAS to finalize and cannot delete DONE assets", async () => {
  const raw = ownershipMemoryStorage();
  const cleanupStorage = createExpectedHashObjectStorage(raw.dependencies);
  const finalizeStorage = createExpectedHashObjectStorage(raw.dependencies);
  const preparing = manifestInput("owner-finalize-wins");
  const claim = await cleanupStorage.claimManifestExpected(preparing);
  const bytes = Buffer.from("published-analysis");
  const objectKey = `category-strategy/account-a/draft-a/set-a/sample-a/${"a".repeat(64)}/${preparing.generation}/${H(bytes)}.webp`;
  await cleanupStorage.putOwnedObjectExpected({
    accountId: "account-a", key: objectKey, contentType: "image/webp", buffer: bytes,
    expectedSha256: H(bytes), maxBytes: 1024, manifestKey: preparing.key,
    ownerToken: preparing.ownerToken, generation: preparing.generation, manifestEtag: claim.etag,
  });

  const abortEntered = deferred();
  const releaseAbort = deferred();
  raw.beforePut.set(preparing.key, async (input) => {
    if (input.metadata?.["category-state"] === "ABORTED") {
      abortEntered.resolve();
      await releaseAbort.promise;
    }
  });
  const cleanup = cleanupStorage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: preparing.key, ownerToken: preparing.ownerToken,
    generation: preparing.generation, expectedEtag: claim.etag,
    objects: [{ key: objectKey, expectedSha256: H(bytes), maxBytes: 1024 }],
  });
  await abortEntered.promise;
  const doneBuffer = Buffer.from(JSON.stringify({ state: "DONE", inputHash: "a".repeat(64), generation: preparing.generation, evidence: [] }));
  const finalized = await finalizeStorage.finalizeManifestExpected({
    accountId: "account-a", key: preparing.key, ownerToken: preparing.ownerToken,
    generation: preparing.generation, expectedEtag: claim.etag,
    buffer: doneBuffer, expectedSha256: H(doneBuffer), maxBytes: 64 * 1024,
  });
  releaseAbort.resolve();

  assert.equal(finalized.status, "DONE");
  assert.equal((await cleanup).status, "DONE");
  assert.equal(raw.objects.has(objectKey), true);
  assert.equal((await cleanupStorage.getManifestExpected({
    accountId: "account-a", key: preparing.key, maxBytes: 64 * 1024,
  })).state, "DONE");
});

test("a delayed owned PUT after abort removes only its generation object and leaves ABORTED fail-closed", async () => {
  const raw = ownershipMemoryStorage();
  const writerStorage = createExpectedHashObjectStorage(raw.dependencies);
  const cleanupStorage = createExpectedHashObjectStorage(raw.dependencies);
  const preparing = manifestInput("owner-late-put", "generation-late-put");
  const claim = await writerStorage.claimManifestExpected(preparing);
  const bytes = Buffer.from("late-analysis");
  const objectKey = `category-strategy/account-a/draft-a/set-a/sample-a/${"a".repeat(64)}/${preparing.generation}/${H(bytes)}.webp`;
  const putEntered = deferred();
  const releasePut = deferred();
  raw.beforePut.set(objectKey, async () => {
    putEntered.resolve();
    await releasePut.promise;
  });
  const delayedPut = writerStorage.putOwnedObjectExpected({
    accountId: "account-a", key: objectKey, contentType: "image/webp", buffer: bytes,
    expectedSha256: H(bytes), maxBytes: 1024, manifestKey: preparing.key,
    ownerToken: preparing.ownerToken, generation: preparing.generation, manifestEtag: claim.etag,
  });
  await putEntered.promise;
  const cleaned = await cleanupStorage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: preparing.key, ownerToken: preparing.ownerToken,
    generation: preparing.generation, expectedEtag: claim.etag,
    objects: [{ key: objectKey, expectedSha256: H(bytes), maxBytes: 1024 }],
  });
  releasePut.resolve();

  assert.equal(cleaned.status, "ABORTED");
  await assert.rejects(delayedPut, { code: "EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS" });
  assert.equal(raw.objects.has(objectKey), false);
  const tombstone = await cleanupStorage.getManifestExpected({
    accountId: "account-a", key: preparing.key, maxBytes: 64 * 1024,
  });
  assert.equal(tombstone.state, "ABORTED");
  const replayClaim = await writerStorage.claimManifestExpected(manifestInput("other-owner", "other-generation"));
  assert.equal(replayClaim.status, "IN_PROGRESS");
  assert.equal((await cleanupStorage.getManifestExpected({
    accountId: "account-a", key: preparing.key, maxBytes: 64 * 1024,
  })).etag, tombstone.etag);
});

test("ABORTED cleanup retains an object replaced between ownership verification and conditional delete", async () => {
  const raw = ownershipMemoryStorage();
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const preparing = manifestInput("owner-replaced", "generation-replaced");
  const claim = await storage.claimManifestExpected(preparing);
  const bytes = Buffer.from("owned-before-replacement");
  const replacement = Buffer.from("replacement-from-another-writer");
  const objectKey = `category-strategy/account-a/draft-a/set-a/sample-a/${"a".repeat(64)}/${preparing.generation}/${H(bytes)}.webp`;
  await storage.putOwnedObjectExpected({
    accountId: "account-a", key: objectKey, contentType: "image/webp", buffer: bytes,
    expectedSha256: H(bytes), maxBytes: 1024, manifestKey: preparing.key,
    ownerToken: preparing.ownerToken, generation: preparing.generation, manifestEtag: claim.etag,
  });
  raw.beforeRemove.set(objectKey, async () => {
    raw.objects.set(objectKey, {
      buffer: replacement, contentType: "image/webp", etag: "replacement-etag",
      metadata: {
        "category-state": "DONE",
        "category-owner": "other-owner",
        "category-generation": "other-generation",
        "category-claim-etag": "other-etag",
        "category-manifest-key": preparing.key,
        "category-content-sha256": H(replacement),
      },
    });
    raw.beforeRemove.delete(objectKey);
  });

  const cleaned = await storage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: preparing.key, ownerToken: preparing.ownerToken,
    generation: preparing.generation, expectedEtag: claim.etag,
    objects: [{ key: objectKey, expectedSha256: H(bytes), maxBytes: 1024 }],
  });
  assert.deepEqual(cleaned, { status: "ABORTED", retainedObjects: true });
  assert.deepEqual(raw.objects.get(objectKey).buffer, replacement);
  assert.equal((await storage.getManifestExpected({
    accountId: "account-a", key: preparing.key, maxBytes: 64 * 1024,
  })).state, "ABORTED");
});

test("null-version cleanup retains a replacement committed after delete verification", async () => {
  const raw = ownershipMemoryStorage();
  const originalRemove = raw.dependencies.removeObject;
  let objectKey;
  const replacement = Buffer.from("replacement-in-mutable-null-version");
  raw.dependencies.removeObject = async (key, options = {}) => {
    if (key !== objectKey) return originalRemove(key, options);
    const removeVersionFenced = createVersionFencedObjectRemover({
      async statObject(candidateKey) {
        const current = raw.objects.get(candidateKey);
        queueMicrotask(() => {
          raw.objects.set(candidateKey, {
            buffer: replacement, contentType: "image/webp", etag: "replacement-null-etag",
            metadata: {
              "category-state": "DONE",
              "category-owner": "replacement-owner",
              "category-generation": "replacement-generation",
              "category-claim-etag": "replacement-claim",
              "category-manifest-key": manifestInput("owner-null-version").key,
              "category-content-sha256": H(replacement),
            },
          });
        });
        return { etag: current.etag, versionId: "null" };
      },
      async removeVersion(candidateKey) { raw.objects.delete(candidateKey); },
    });
    return removeVersionFenced(key, options.expectedEtag);
  };
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const preparing = manifestInput("owner-null-version", "generation-null-version");
  const claim = await storage.claimManifestExpected(preparing);
  const bytes = Buffer.from("owned-null-version");
  objectKey = `category-strategy/account-a/draft-a/set-a/sample-a/${"a".repeat(64)}/${preparing.generation}/${H(bytes)}.webp`;
  await storage.putOwnedObjectExpected({
    accountId: "account-a", key: objectKey, contentType: "image/webp", buffer: bytes,
    expectedSha256: H(bytes), maxBytes: 1024, manifestKey: preparing.key,
    ownerToken: preparing.ownerToken, generation: preparing.generation, manifestEtag: claim.etag,
  });

  const cleaned = await storage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: preparing.key, ownerToken: preparing.ownerToken,
    generation: preparing.generation, expectedEtag: claim.etag,
    objects: [{ key: objectKey, expectedSha256: H(bytes), maxBytes: 1024 }],
  });
  assert.deepEqual(cleaned, { status: "ABORTED", retainedObjects: true });
  assert.deepEqual(raw.objects.get(objectKey).buffer, replacement);
  assert.equal((await storage.getManifestExpected({
    accountId: "account-a", key: preparing.key, maxBytes: 64 * 1024,
  })).state, "ABORTED");
});

test("finalize from an absent or ABORTED manifest never recreates DONE", async () => {
  const absentRaw = ownershipMemoryStorage();
  const absentStorage = createExpectedHashObjectStorage(absentRaw.dependencies);
  const absentPreparing = manifestInput("owner-absent", "generation-absent");
  const absentClaim = await absentStorage.claimManifestExpected(absentPreparing);
  await absentRaw.dependencies.removeObject(absentPreparing.key);
  const doneBuffer = Buffer.from(JSON.stringify({ state: "DONE", generation: absentPreparing.generation }));
  const putsBeforeFinalize = absentRaw.puts.length;
  await assert.rejects(absentStorage.finalizeManifestExpected({
    accountId: "account-a", key: absentPreparing.key, ownerToken: absentPreparing.ownerToken,
    generation: absentPreparing.generation, expectedEtag: absentClaim.etag,
    buffer: doneBuffer, expectedSha256: H(doneBuffer), maxBytes: 64 * 1024,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS" });
  assert.equal(absentRaw.puts.length, putsBeforeFinalize);
  assert.equal(absentRaw.objects.has(absentPreparing.key), false);

  const abortedRaw = ownershipMemoryStorage();
  const abortedStorage = createExpectedHashObjectStorage(abortedRaw.dependencies);
  const abortedPreparing = manifestInput("owner-aborted", "generation-aborted");
  const abortedClaim = await abortedStorage.claimManifestExpected(abortedPreparing);
  await abortedStorage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: abortedPreparing.key, ownerToken: abortedPreparing.ownerToken,
    generation: abortedPreparing.generation, expectedEtag: abortedClaim.etag, objects: [],
  });
  const abortedPuts = abortedRaw.puts.length;
  await assert.rejects(abortedStorage.finalizeManifestExpected({
    accountId: "account-a", key: abortedPreparing.key, ownerToken: abortedPreparing.ownerToken,
    generation: abortedPreparing.generation, expectedEtag: abortedClaim.etag,
    buffer: doneBuffer, expectedSha256: H(doneBuffer), maxBytes: 64 * 1024,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS" });
  assert.equal(abortedRaw.puts.length, abortedPuts);
  assert.equal((await abortedStorage.getManifestExpected({
    accountId: "account-a", key: abortedPreparing.key, maxBytes: 64 * 1024,
  })).state, "ABORTED");
});

test("two independent factories share one conditional manifest owner and expose only DONE replay", async () => {
  const raw = ownershipMemoryStorage();
  const firstStorage = createExpectedHashObjectStorage(raw.dependencies);
  const secondStorage = createExpectedHashObjectStorage(raw.dependencies);
  const [first, second] = await Promise.all([
    firstStorage.claimManifestExpected(manifestInput("owner-a")),
    secondStorage.claimManifestExpected(manifestInput("owner-b")),
  ]);
  const owner = first.status === "OWNED" ? first : second;
  const waiting = first.status === "OWNED" ? second : first;
  const ownerStorage = first.status === "OWNED" ? firstStorage : secondStorage;
  assert.equal(waiting.status, "IN_PROGRESS");

  const imageBytes = Buffer.from("owned-analysis");
  const preparing = manifestInput(owner.ownerToken, owner.generation);
  const imageKey = `category-strategy/account-a/draft-a/set-a/sample-a/${"a".repeat(64)}/${owner.generation}/${H(imageBytes)}.webp`;
  await ownerStorage.putOwnedObjectExpected({
    accountId: "account-a", key: imageKey, contentType: "image/webp", buffer: imageBytes,
    expectedSha256: H(imageBytes), maxBytes: 1024, manifestKey: preparing.key,
    ownerToken: owner.ownerToken, generation: owner.generation, manifestEtag: owner.etag,
  });
  const doneBuffer = Buffer.from(JSON.stringify({ state: "DONE", inputHash: "a".repeat(64), evidence: [] }));
  raw.loseResponses.add(manifestInput(owner.ownerToken).key);
  const done = await ownerStorage.finalizeManifestExpected({
    accountId: "account-a",
    key: manifestInput(owner.ownerToken).key,
    ownerToken: owner.ownerToken,
    generation: owner.generation,
    expectedEtag: owner.etag,
    buffer: doneBuffer,
    expectedSha256: H(doneBuffer),
    maxBytes: 64 * 1024,
  });
  assert.equal(done.status, "DONE");
  assert.equal(done.recovered, true);
  const replay = await secondStorage.getManifestExpected({
    accountId: "account-a", key: manifestInput("owner-b").key, maxBytes: 64 * 1024,
  });
  assert.equal(replay.state, "DONE");
  assert.deepEqual(replay.buffer, doneBuffer);
  const refusedCleanup = await ownerStorage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: manifestInput(owner.ownerToken).key,
    ownerToken: owner.ownerToken, generation: owner.generation, expectedEtag: owner.etag,
    objects: [{ key: imageKey, expectedSha256: H(imageBytes), maxBytes: 1024 }],
  });
  assert.equal(refusedCleanup.status, "DONE");
  assert.equal(raw.objects.has(imageKey), true);
});

test("response-loss ownership is recovered by creator metadata and failed PREPARING cleanup leaves no orphan", async () => {
  const raw = ownershipMemoryStorage();
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const claim = await storage.claimManifestExpected(manifestInput("owner-response-loss"));
  assert.equal(claim.status, "OWNED");
  const bytes = Buffer.from("analysis-bytes");
  const objectKey = `category-strategy/account-a/draft-a/set-a/sample-a/${"a".repeat(64)}/${claim.generation}/${H(bytes)}.webp`;
  raw.loseResponses.add(objectKey);
  const stored = await storage.putOwnedObjectExpected({
    accountId: "account-a", key: objectKey, contentType: "image/webp", buffer: bytes,
    expectedSha256: H(bytes), maxBytes: 1024, manifestKey: manifestInput("owner-response-loss").key,
    ownerToken: "owner-response-loss", generation: claim.generation, manifestEtag: claim.etag,
  });
  assert.equal(stored.created, true);
  assert.equal(stored.recovered, true);
  const cleaned = await storage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: manifestInput("owner-response-loss").key,
    ownerToken: "owner-response-loss", generation: claim.generation, expectedEtag: claim.etag,
    objects: [{ key: objectKey, expectedSha256: H(bytes), maxBytes: 1024 }],
  });
  assert.equal(cleaned.status, "ABORTED");
  assert.equal(cleaned.retainedObjects, false);
  assert.equal(raw.objects.size, 1);
  const tombstone = await storage.getManifestExpected({
    accountId: "account-a", key: manifestInput("owner-response-loss").key, maxBytes: 64 * 1024,
  });
  assert.equal(tombstone.state, "ABORTED");
  assert.deepEqual(JSON.parse(tombstone.buffer), {
    schemaVersion: 1,
    state: "ABORTED",
    ownerToken: "owner-response-loss",
    generation: claim.generation,
    preparingEtag: claim.etag,
    expectedObjects: [{ key: objectKey, expectedSha256: H(bytes), maxBytes: 1024 }],
  });
});

test("manifest cleanup rejects hostile object arrays without invoking proxy traps", async () => {
  const raw = ownershipMemoryStorage();
  const storage = createExpectedHashObjectStorage(raw.dependencies);
  const claim = await storage.claimManifestExpected(manifestInput("owner-hostile"));
  let traps = 0;
  const hostile = new Proxy([], { get() { traps += 1; throw new Error("must not run"); } });
  await assert.rejects(storage.cleanupOwnedManifestExpected({
    accountId: "account-a", key: manifestInput("owner-hostile").key,
    ownerToken: "owner-hostile", generation: claim.generation, expectedEtag: claim.etag, objects: hostile,
  }), { code: "EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID" });
  assert.equal(traps, 0);
});
