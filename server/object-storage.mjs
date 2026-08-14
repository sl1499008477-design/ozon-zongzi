import crypto from "node:crypto";
import { Readable } from "node:stream";
import { types as utilTypes } from "node:util";

let clientPromise = null;
let bucketReady = false;

const EXPECTED_HASH = /^[a-f0-9]{64}$/u;
const SAFE_ACCOUNT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const SAFE_EXPECTED_KEY = /^[A-Za-z0-9._/-]+$/u;
const EXPECTED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MANIFEST_MAX_BYTES = 64 * 1024;
const META_STATE = "category-state";
const META_OWNER = "category-owner";
const META_GENERATION = "category-generation";
const META_CLAIM_ETAG = "category-claim-etag";
const META_MANIFEST = "category-manifest-key";
const META_HASH = "category-content-sha256";
const CREDENTIAL_MARKER = /(?:credential|password|passwd|secret|bearer|authorization|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token)/iu;

function expectedStorageError(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function closedExpectedStorageInput(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || utilTypes.isProxy(raw) || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const ownKeys = Reflect.ownKeys(raw);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (String(error?.code || "").startsWith("EXPECTED_HASH_OBJECT_STORAGE_")) throw error;
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
  }
}

function closedExpectedStorageArray(raw, maxLength) {
  try {
    if (utilTypes.isProxy(raw) || !Array.isArray(raw)) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(descriptors);
    if (!Number.isInteger(descriptors.length?.value) || descriptors.length.value > maxLength
      || keys.length !== descriptors.length.value + 1) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    return Array.from({ length: descriptors.length.value }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
      }
      return descriptor.value;
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("EXPECTED_HASH_OBJECT_STORAGE_")) throw error;
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
  }
}

function validateExpectedScope(accountId, key) {
  if (typeof accountId !== "string" || !SAFE_ACCOUNT_SEGMENT.test(accountId)
    || CREDENTIAL_MARKER.test(accountId) || typeof key !== "string" || Buffer.byteLength(key, "utf8") > 1024
    || !SAFE_EXPECTED_KEY.test(key) || key.includes("..") || CREDENTIAL_MARKER.test(key)
    || !key.startsWith(`category-strategy/${accountId}/`)) {
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_SCOPE_INVALID");
  }
}

function validateExpectedRead(input) {
  validateExpectedScope(input.accountId, input.key);
  if (!EXPECTED_HASH.test(input.expectedSha256 || "")
    || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 64 * 1024 * 1024) {
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
  }
}

function isObjectNotFound(error) {
  return ["NoSuchKey", "NoSuchObject", "NotFound", "ENOENT"].includes(error?.code)
    || Number(error?.statusCode) === 404 || Number(error?.status) === 404;
}

function exactExpectedBytes(bytes, expectedSha256, maxBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maxBytes
    || crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_HASH_MISMATCH");
  }
  return bytes;
}

export function createVersionFencedObjectRemover(raw = {}) {
  const ports = closedExpectedStorageInput(raw, ["statObject", "removeVersion"]);
  if (typeof ports.statObject !== "function" || typeof ports.removeVersion !== "function") {
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
  }
  return async function removeVersionFenced(key, expectedEtag) {
    if (typeof key !== "string" || !key || typeof expectedEtag !== "string" || !expectedEtag) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    const current = await ports.statObject(key);
    if (current?.etag !== expectedEtag) {
      const error = new Error("对象已被替换");
      error.code = "PreconditionFailed";
      error.statusCode = 412;
      throw error;
    }
    if (typeof current.versionId !== "string" || !current.versionId || current.versionId === "null") {
      const error = new Error("对象存储未提供可安全删除的不可变版本标识");
      error.code = "OBJECT_STORAGE_CONDITIONAL_DELETE_UNSUPPORTED";
      error.statusCode = 409;
      throw error;
    }
    await ports.removeVersion(key, current.versionId);
  };
}

/**
 * Closed integrity API layered over the legacy object-storage exports. The
 * injected form keeps the response-loss/idempotency behavior independently
 * testable without a live MinIO instance.
 */
export function createExpectedHashObjectStorage(dependencies) {
  let ports;
  if (dependencies === undefined) {
    ports = { putObject: putObjectFromBuffer, getObjectBuffer, statObject, removeObject };
  } else {
    ports = closedExpectedStorageInput(dependencies, ["putObject", "getObjectBuffer", "statObject", "removeObject"]);
  }
  if (![ports.putObject, ports.getObjectBuffer, ports.statObject, ports.removeObject].every((value) => typeof value === "function")) {
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
  }

  async function readObjectExpected(raw = {}) {
    const input = closedExpectedStorageInput(raw, ["accountId", "key", "expectedSha256", "maxBytes"]);
    validateExpectedRead(input);
    let bytes;
    try {
      bytes = await ports.getObjectBuffer(input.key, { maxBytes: input.maxBytes });
    } catch (error) {
      if (isObjectNotFound(error)) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_NOT_FOUND");
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
    }
    return Buffer.from(exactExpectedBytes(bytes, input.expectedSha256, input.maxBytes));
  }

  async function existingExpected(input) {
    try {
      return await readObjectExpected({
        accountId: input.accountId,
        key: input.key,
        expectedSha256: input.expectedSha256,
        maxBytes: input.maxBytes,
      });
    } catch (error) {
      if (error?.code === "EXPECTED_HASH_OBJECT_STORAGE_NOT_FOUND") return null;
      throw error;
    }
  }

  async function removeCreatedAfterFailedVerification(input) {
    try {
      await ports.removeObject(input.key, { accountId: input.accountId });
      return;
    } catch {
      try {
        await ports.getObjectBuffer(input.key, { maxBytes: input.maxBytes });
      } catch (error) {
        if (isObjectNotFound(error)) return;
      }
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_CLEANUP_FAILED", true);
    }
  }

  async function verifyNewPut(input, { created, recovered }) {
    try {
      const persisted = await existingExpected(input);
      if (!persisted) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
      return Object.freeze({
        key: input.key, contentType: input.contentType, size: persisted.length,
        sha256: input.expectedSha256, created, recovered,
      });
    } catch (error) {
      if (created) await removeCreatedAfterFailedVerification(input);
      throw error;
    }
  }

  async function putObjectExpected(raw = {}) {
    const input = closedExpectedStorageInput(raw, [
      "accountId", "key", "contentType", "buffer", "expectedSha256", "maxBytes",
    ]);
    validateExpectedRead(input);
    if (!EXPECTED_CONTENT_TYPES.has(input.contentType) || !Buffer.isBuffer(input.buffer)
      || input.buffer.length < 1 || input.buffer.length > input.maxBytes
      || crypto.createHash("sha256").update(input.buffer).digest("hex") !== input.expectedSha256) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    const existing = await existingExpected(input);
    if (existing) {
      return Object.freeze({
        key: input.key, contentType: input.contentType, size: existing.length,
        sha256: input.expectedSha256, created: false, recovered: false,
      });
    }

    let response;
    let putError;
    try {
      response = await ports.putObject({
        key: input.key,
        name: input.key.slice(input.key.lastIndexOf("/") + 1),
        contentType: input.contentType,
        buffer: input.buffer,
        maxBytes: input.maxBytes,
        ifNoneMatch: "*",
      });
    } catch (error) {
      putError = error;
    }
    const responseValid = response?.key === input.key && response?.sha256 === input.expectedSha256
      && response?.contentType === input.contentType && response?.size === input.buffer.length;
    if (!putError && responseValid) {
      return verifyNewPut(input, { created: true, recovered: false });
    }
    try {
      return await verifyNewPut(input, { created: false, recovered: true });
    } catch (error) {
      if (["EXPECTED_HASH_OBJECT_STORAGE_HASH_MISMATCH", "EXPECTED_HASH_OBJECT_STORAGE_CLEANUP_FAILED"].includes(error?.code)) throw error;
    }
    throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
  }

  async function removeObjectExpected(raw = {}) {
    const input = closedExpectedStorageInput(raw, ["accountId", "key", "expectedSha256", "maxBytes"]);
    validateExpectedRead(input);
    const verifiedStat = await statExpected(input.key);
    if (!verifiedStat) {
      return Object.freeze({ key: input.key, sha256: input.expectedSha256, removed: false, recovered: false });
    }
    try {
      await readObjectExpected(input);
    } catch (error) {
      if (error?.code === "EXPECTED_HASH_OBJECT_STORAGE_NOT_FOUND") {
        return Object.freeze({ key: input.key, sha256: input.expectedSha256, removed: false, recovered: false });
      }
      throw error;
    }
    try {
      await ports.removeObject(input.key, { accountId: input.accountId, expectedEtag: verifiedStat.etag });
      const latest = await statExpected(input.key);
      if (latest?.etag === verifiedStat.etag) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_CLEANUP_FAILED", true);
      }
      return Object.freeze({ key: input.key, sha256: input.expectedSha256, removed: true, recovered: false });
    } catch {
      const latest = await statExpected(input.key);
      if (!latest) {
        return Object.freeze({ key: input.key, sha256: input.expectedSha256, removed: true, recovered: true });
      }
      if (latest.etag !== verifiedStat.etag) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_CLEANUP_FAILED", true);
      }
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
    }
  }

  function metadataValue(metadata, key) {
    if (!metadata || typeof metadata !== "object") return "";
    return String(metadata[key] ?? metadata[`x-amz-meta-${key}`] ?? metadata[key.toLowerCase()] ?? "");
  }

  async function statExpected(key) {
    try {
      const value = await ports.statObject(key);
      const metadata = value?.metaData ?? value?.metadata;
      if (!value || typeof value.etag !== "string" || !value.etag || !metadata || typeof metadata !== "object") {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
      }
      return { etag: value.etag, size: Number(value.size), metadata };
    } catch (error) {
      if (isObjectNotFound(error)) return null;
      if (String(error?.code || "").startsWith("EXPECTED_HASH_OBJECT_STORAGE_")) throw error;
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
    }
  }

  async function readStatBytes(key, stat, maxBytes) {
    const expectedSha256 = metadataValue(stat.metadata, META_HASH);
    if (!EXPECTED_HASH.test(expectedSha256) || !Number.isInteger(stat.size)
      || stat.size < 1 || stat.size > maxBytes) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_HASH_MISMATCH");
    }
    let bytes;
    try { bytes = await ports.getObjectBuffer(key, { maxBytes }); } catch (error) {
      if (isObjectNotFound(error)) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_NOT_FOUND");
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
    }
    return { bytes: Buffer.from(exactExpectedBytes(bytes, expectedSha256, maxBytes)), expectedSha256 };
  }

  function manifestReadInput(raw) {
    const input = closedExpectedStorageInput(raw, ["accountId", "key", "maxBytes"]);
    validateExpectedScope(input.accountId, input.key);
    if (!input.key.includes("/manifests/") || !input.key.endsWith(".json")
      || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MANIFEST_MAX_BYTES) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    return input;
  }

  async function getManifestExpected(raw = {}) {
    const input = manifestReadInput(raw);
    const stat = await statExpected(input.key);
    if (!stat) return null;
    const state = metadataValue(stat.metadata, META_STATE);
    const ownerToken = metadataValue(stat.metadata, META_OWNER);
    const generation = metadataValue(stat.metadata, META_GENERATION);
    if (!["PREPARING", "DONE", "ABORTED"].includes(state)
      || !SAFE_ACCOUNT_SEGMENT.test(ownerToken) || !SAFE_ACCOUNT_SEGMENT.test(generation)) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_MANIFEST_INVALID");
    }
    const read = await readStatBytes(input.key, stat, input.maxBytes);
    return Object.freeze({
      state, ownerToken, generation, etag: stat.etag,
      sha256: read.expectedSha256, buffer: read.bytes,
    });
  }

  function manifestWriteInput(raw, keys) {
    const input = closedExpectedStorageInput(raw, keys);
    validateExpectedScope(input.accountId, input.key);
    if (!input.key.includes("/manifests/") || !input.key.endsWith(".json")
      || !SAFE_ACCOUNT_SEGMENT.test(input.ownerToken || "") || !SAFE_ACCOUNT_SEGMENT.test(input.generation || "")
      || !Buffer.isBuffer(input.buffer)
      || !EXPECTED_HASH.test(input.expectedSha256 || "") || sha256Buffer(input.buffer) !== input.expectedSha256
      || !Number.isInteger(input.maxBytes) || input.maxBytes < input.buffer.length
      || input.maxBytes > MANIFEST_MAX_BYTES) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    return input;
  }

  function ownedGenerationPrefix(manifestKey, generation) {
    const marker = "/manifests/";
    const markerIndex = manifestKey.indexOf(marker);
    const manifestName = manifestKey.slice(markerIndex + marker.length, -".json".length);
    if (markerIndex < 1 || !EXPECTED_HASH.test(manifestName)) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    return `${manifestKey.slice(0, markerIndex)}/${manifestName}/${generation}/`;
  }

  async function claimManifestExpected(raw = {}) {
    const input = manifestWriteInput(raw, [
      "accountId", "key", "ownerToken", "generation", "buffer", "expectedSha256", "maxBytes",
    ]);
    let putError = null;
    try {
      await ports.putObject({
        key: input.key, name: "manifest.json", contentType: "application/json", buffer: input.buffer,
        maxBytes: input.maxBytes, ifNoneMatch: "*", metadata: {
          [META_STATE]: "PREPARING", [META_OWNER]: input.ownerToken,
          [META_GENERATION]: input.generation, [META_HASH]: input.expectedSha256,
        },
      });
    } catch (error) { putError = error; }
    const manifest = await getManifestExpected({ accountId: input.accountId, key: input.key, maxBytes: input.maxBytes });
    if (!manifest) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
    if (manifest.state === "DONE") return Object.freeze({ status: "DONE", ...manifest });
    if (manifest.state === "ABORTED") {
      return Object.freeze({ status: "IN_PROGRESS", ownerToken: null, generation: null, etag: manifest.etag });
    }
    if (manifest.ownerToken !== input.ownerToken || manifest.generation !== input.generation
      || manifest.sha256 !== input.expectedSha256
      || !manifest.buffer.equals(input.buffer)) {
      return Object.freeze({ status: "IN_PROGRESS", ownerToken: null, generation: null, etag: manifest.etag });
    }
    return Object.freeze({
      status: "OWNED", ownerToken: input.ownerToken, generation: input.generation, etag: manifest.etag,
      recovered: Boolean(putError),
    });
  }

  async function finalizeManifestExpected(raw = {}) {
    const input = manifestWriteInput(raw, [
      "accountId", "key", "ownerToken", "generation", "expectedEtag", "buffer", "expectedSha256", "maxBytes",
    ]);
    if (typeof input.expectedEtag !== "string" || !input.expectedEtag) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    const before = await getManifestExpected({ accountId: input.accountId, key: input.key, maxBytes: input.maxBytes });
    if (before?.state === "DONE") {
      if (before.ownerToken !== input.ownerToken || before.generation !== input.generation
        || before.sha256 !== input.expectedSha256 || !before.buffer.equals(input.buffer)) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_MANIFEST_INVALID");
      }
      return Object.freeze({ status: "DONE", etag: before.etag, recovered: true, buffer: before.buffer });
    }
    if (!before || before.state !== "PREPARING" || before.ownerToken !== input.ownerToken
      || before.generation !== input.generation
      || before.etag !== input.expectedEtag) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    let putError = null;
    try {
      await ports.putObject({
        key: input.key, name: "manifest.json", contentType: "application/json", buffer: input.buffer,
        maxBytes: input.maxBytes, ifMatch: input.expectedEtag, metadata: {
          [META_STATE]: "DONE", [META_OWNER]: input.ownerToken,
          [META_GENERATION]: input.generation, [META_HASH]: input.expectedSha256,
        },
      });
    } catch (error) { putError = error; }
    const after = await getManifestExpected({ accountId: input.accountId, key: input.key, maxBytes: input.maxBytes });
    if (!after || after.state !== "DONE" || after.ownerToken !== input.ownerToken
      || after.generation !== input.generation
      || after.sha256 !== input.expectedSha256 || !after.buffer.equals(input.buffer)) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE", true);
    }
    return Object.freeze({ status: "DONE", etag: after.etag, recovered: Boolean(putError), buffer: after.buffer });
  }

  async function putOwnedObjectExpected(raw = {}) {
    const input = closedExpectedStorageInput(raw, [
      "accountId", "key", "contentType", "buffer", "expectedSha256", "maxBytes", "manifestKey", "ownerToken",
      "generation", "manifestEtag",
    ]);
    validateExpectedRead(input);
    validateExpectedScope(input.accountId, input.manifestKey);
    if (!EXPECTED_CONTENT_TYPES.has(input.contentType) || !Buffer.isBuffer(input.buffer)
      || input.buffer.length < 1 || input.buffer.length > input.maxBytes
      || sha256Buffer(input.buffer) !== input.expectedSha256 || !SAFE_ACCOUNT_SEGMENT.test(input.ownerToken || "")
      || !SAFE_ACCOUNT_SEGMENT.test(input.generation || "") || typeof input.manifestEtag !== "string"
      || !input.manifestEtag || !input.key.startsWith(ownedGenerationPrefix(input.manifestKey, input.generation))) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    const manifest = await getManifestExpected({ accountId: input.accountId, key: input.manifestKey, maxBytes: MANIFEST_MAX_BYTES });
    if (!manifest || manifest.state !== "PREPARING" || manifest.ownerToken !== input.ownerToken
      || manifest.generation !== input.generation || manifest.etag !== input.manifestEtag) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    let putError = null;
    try {
      await ports.putObject({
        key: input.key, name: input.key.slice(input.key.lastIndexOf("/") + 1), contentType: input.contentType,
        buffer: input.buffer, maxBytes: input.maxBytes, ifNoneMatch: "*", metadata: {
          [META_STATE]: "PREPARING", [META_OWNER]: input.ownerToken,
          [META_GENERATION]: input.generation, [META_CLAIM_ETAG]: input.manifestEtag,
          [META_MANIFEST]: input.manifestKey, [META_HASH]: input.expectedSha256,
        },
      });
    } catch (error) { putError = error; }
    const stat = await statExpected(input.key);
    if (!stat || metadataValue(stat.metadata, META_OWNER) !== input.ownerToken
      || metadataValue(stat.metadata, META_GENERATION) !== input.generation
      || metadataValue(stat.metadata, META_CLAIM_ETAG) !== input.manifestEtag
      || metadataValue(stat.metadata, META_MANIFEST) !== input.manifestKey
      || metadataValue(stat.metadata, META_HASH) !== input.expectedSha256) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    const read = await readStatBytes(input.key, stat, input.maxBytes);
    if (!read.bytes.equals(input.buffer)) throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_HASH_MISMATCH");
    const latestManifest = await getManifestExpected({
      accountId: input.accountId, key: input.manifestKey, maxBytes: MANIFEST_MAX_BYTES,
    });
    if (latestManifest?.state === "ABORTED" && latestManifest.ownerToken === input.ownerToken
      && latestManifest.generation === input.generation) {
      await removeOwnedKey(input);
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    if (!latestManifest || latestManifest.ownerToken !== input.ownerToken
      || latestManifest.generation !== input.generation
      || (latestManifest.state === "PREPARING" && latestManifest.etag !== input.manifestEtag)
      || !["PREPARING", "DONE"].includes(latestManifest.state)) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    return Object.freeze({
      key: input.key, contentType: input.contentType, size: input.buffer.length,
      sha256: input.expectedSha256, created: true, recovered: Boolean(putError),
    });
  }

  async function removeOwnedKey(input) {
    const stat = await statExpected(input.key);
    if (!stat) return;
    if (metadataValue(stat.metadata, META_OWNER) !== input.ownerToken
      || metadataValue(stat.metadata, META_GENERATION) !== input.generation
      || metadataValue(stat.metadata, META_CLAIM_ETAG) !== input.manifestEtag
      || metadataValue(stat.metadata, META_MANIFEST) !== input.manifestKey
      || metadataValue(stat.metadata, META_HASH) !== input.expectedSha256) return false;
    try {
      await ports.removeObject(input.key, { accountId: input.accountId, expectedEtag: stat.etag });
    } catch (error) {
      const latest = await statExpected(input.key);
      if (!latest) return true;
      if (latest.etag !== stat.etag) return false;
      if (error?.code === "OBJECT_STORAGE_CONDITIONAL_DELETE_UNSUPPORTED") return false;
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_CLEANUP_FAILED", true);
    }
    return !(await statExpected(input.key));
  }

  async function cleanupOwnedManifestExpected(raw = {}) {
    const input = closedExpectedStorageInput(raw, [
      "accountId", "key", "ownerToken", "generation", "expectedEtag", "objects",
    ]);
    validateExpectedScope(input.accountId, input.key);
    if (!SAFE_ACCOUNT_SEGMENT.test(input.ownerToken || "") || !SAFE_ACCOUNT_SEGMENT.test(input.generation || "")
      || typeof input.expectedEtag !== "string" || !input.expectedEtag) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
    }
    const objects = closedExpectedStorageArray(input.objects, 12);
    const validatedObjects = objects.map((rawObject) => {
      const object = closedExpectedStorageInput(rawObject, ["key", "expectedSha256", "maxBytes"]);
      validateExpectedRead({ accountId: input.accountId, ...object });
      if (!object.key.startsWith(ownedGenerationPrefix(input.key, input.generation))) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_INPUT_INVALID");
      }
      return object;
    });
    const manifest = await getManifestExpected({ accountId: input.accountId, key: input.key, maxBytes: MANIFEST_MAX_BYTES });
    if (manifest?.state === "DONE") return Object.freeze({ status: "DONE" });
    if (!manifest || manifest.ownerToken !== input.ownerToken || manifest.generation !== input.generation) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    const abortBuffer = Buffer.from(JSON.stringify({
      schemaVersion: 1, state: "ABORTED", ownerToken: input.ownerToken,
      generation: input.generation, preparingEtag: input.expectedEtag,
      expectedObjects: validatedObjects,
    }), "utf8");
    const abortHash = sha256Buffer(abortBuffer);
    let aborted = manifest;
    if (manifest.state === "PREPARING") {
      if (manifest.etag !== input.expectedEtag) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
      }
      try {
        await ports.putObject({
          key: input.key, name: "manifest.json", contentType: "application/json", buffer: abortBuffer,
          maxBytes: MANIFEST_MAX_BYTES, ifMatch: input.expectedEtag, metadata: {
            [META_STATE]: "ABORTED", [META_OWNER]: input.ownerToken,
            [META_GENERATION]: input.generation, [META_HASH]: abortHash,
          },
        });
      } catch { /* response loss or a competing terminal CAS is reconciled below */ }
      aborted = await getManifestExpected({ accountId: input.accountId, key: input.key, maxBytes: MANIFEST_MAX_BYTES });
      if (aborted?.state === "DONE") return Object.freeze({ status: "DONE" });
      if (!aborted || aborted.state !== "ABORTED" || aborted.ownerToken !== input.ownerToken
        || aborted.generation !== input.generation || aborted.sha256 !== abortHash
        || !aborted.buffer.equals(abortBuffer)) {
        throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
      }
    } else if (manifest.state !== "ABORTED" || manifest.sha256 !== abortHash
      || !manifest.buffer.equals(abortBuffer)) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    let retainedObjects = false;
    for (const object of validatedObjects) {
      const removed = await removeOwnedKey({
        accountId: input.accountId, key: object.key, expectedSha256: object.expectedSha256,
        manifestKey: input.key, ownerToken: input.ownerToken, generation: input.generation,
        manifestEtag: input.expectedEtag,
      });
      if (!removed && await statExpected(object.key)) retainedObjects = true;
    }
    const latest = await getManifestExpected({ accountId: input.accountId, key: input.key, maxBytes: MANIFEST_MAX_BYTES });
    if (!latest || latest.state !== "ABORTED" || latest.ownerToken !== input.ownerToken
      || latest.generation !== input.generation || latest.etag !== aborted.etag) {
      throw expectedStorageError("EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS", true);
    }
    return Object.freeze({ status: "ABORTED", retainedObjects });
  }

  return Object.freeze({
    putObjectExpected, readObjectExpected, removeObjectExpected,
    getManifestExpected, claimManifestExpected, finalizeManifestExpected,
    putOwnedObjectExpected, cleanupOwnedManifestExpected,
  });
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function minioPort() {
  return Number(process.env.MINIO_PORT || 9000);
}

function minioUseSsl() {
  const value = String(process.env.MINIO_USE_SSL || "false").toLowerCase();
  return value === "1" || value === "true";
}

export function objectStorageInfo() {
  return {
    endpoint: process.env.MINIO_ENDPOINT || "127.0.0.1",
    port: minioPort(),
    useSSL: minioUseSsl(),
    bucket: process.env.MINIO_BUCKET || "sonli-local-files",
  };
}

function bucketName() {
  return objectStorageInfo().bucket;
}

async function getClient() {
  if (!clientPromise) {
    const required = ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET"];
    const missing = required.filter((name) => !String(process.env[name] || "").trim());
    if (missing.length) {
      throw new Error(`MinIO 文件存储缺少配置：${missing.join("、")}`);
    }
    clientPromise = import("minio")
      .then(({ Client }) => new Client({
        endPoint: process.env.MINIO_ENDPOINT,
        port: minioPort(),
        useSSL: minioUseSsl(),
        accessKey: process.env.MINIO_ACCESS_KEY,
        secretKey: process.env.MINIO_SECRET_KEY,
      }))
      .catch((error) => {
        throw new Error(`MinIO 依赖未安装或不可用，请先执行 pnpm install。原始错误: ${error.message}`);
      });
  }
  return clientPromise;
}

async function ensureBucket() {
  if (bucketReady) return;
  const client = await getClient();
  const bucket = bucketName();
  const exists = await client.bucketExists(bucket);
  if (!exists) await client.makeBucket(bucket);
  bucketReady = true;
}

function safeFileName(name) {
  const fallback = "file";
  return String(name || fallback)
    .trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

function decodeBase64Payload(payload) {
  const raw = String(payload || "");
  const [, dataUrlType, dataUrlBody] = raw.match(/^data:([^;]+);base64,(.*)$/s) || [];
  const base64 = dataUrlBody || raw;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    const err = new Error("文件内容为空");
    err.status = 400;
    throw err;
  }
  const maxBytes = Number(process.env.LOCAL_FILE_MAX_BYTES || 50 * 1024 * 1024);
  if (buffer.length > maxBytes) {
    const err = new Error(`文件超过本地上传限制 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    err.status = 413;
    throw err;
  }
  return { buffer, dataUrlType };
}

export function buildObjectKey(name) {
  const date = new Date().toISOString().slice(0, 10);
  return `local/${date}/${crypto.randomUUID()}-${safeFileName(name)}`;
}

export async function putObjectFromBase64({ key, name, contentType, base64 }) {
  const { buffer, dataUrlType } = decodeBase64Payload(base64);
  return putObjectFromBuffer({ key, name, contentType: contentType || dataUrlType, buffer });
}

export async function putObjectFromBuffer({ key, name, contentType, buffer, maxBytes = Number(process.env.LOCAL_FILE_MAX_BYTES || 50 * 1024 * 1024), ifNoneMatch, ifMatch, metadata = {} }) {
  await ensureBucket();
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!content.length) {
    const error = new Error("文件内容为空");
    error.status = 400;
    throw error;
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    const error = new Error("文件大小限制无效");
    error.status = 400;
    throw error;
  }
  if ((ifNoneMatch !== undefined && ifNoneMatch !== "*") || (ifMatch !== undefined && (typeof ifMatch !== "string" || !ifMatch))) {
    const error = new Error("对象条件写入参数无效");
    error.status = 400;
    throw error;
  }
  if (content.length > maxBytes) {
    const error = new Error(`文件超过本地上传限制 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    error.status = 413;
    throw error;
  }
  const objectKey = key || buildObjectKey(name);
  const type = contentType || "application/octet-stream";
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const client = await getClient();
  await client.putObject(
    bucketName(),
    objectKey,
    Readable.from(content),
    content.length,
    {
      "Content-Type": type,
      "X-Amz-Meta-Original-Name": String(name || ""),
      ...metadata,
      ...(ifNoneMatch === "*" ? { "If-None-Match": "*" } : {}),
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
    }
  );
  return {
    key: objectKey,
    bucket: bucketName(),
    contentType: type,
    size: content.length,
    sha256,
  };
}

export async function getObjectStream(key) {
  const client = await getClient();
  return client.getObject(bucketName(), String(key || ""));
}

export async function readObjectStreamBounded(stream, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("对象读取大小限制无效");
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.from(chunk); size += value.length;
    if (size > maxBytes) { stream.destroy?.(); throw new Error("对象超过读取限制"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function getObjectBuffer(key, options = {}) {
  return readObjectStreamBounded(await getObjectStream(key), options);
}

export async function statObject(key) {
  const client = await getClient();
  return client.statObject(bucketName(), String(key || ""));
}

export async function removeObject(key, options = {}) {
  const client = await getClient();
  const objectKey = String(key || "");
  const expectedEtag = options?.expectedEtag;
  if (expectedEtag !== undefined) {
    if (typeof expectedEtag !== "string" || !expectedEtag) {
      const error = new Error("对象条件删除参数无效");
      error.status = 400;
      throw error;
    }
    const removeVersionFenced = createVersionFencedObjectRemover({
      statObject: (candidateKey) => client.statObject(bucketName(), candidateKey),
      removeVersion: (candidateKey, versionId) => client.removeObject(bucketName(), candidateKey, { versionId }),
    });
    await removeVersionFenced(objectKey, expectedEtag);
    return;
  }
  await client.removeObject(bucketName(), objectKey);
}

export async function objectStorageHealth() {
  await ensureBucket();
  return {
    ok: true,
    ...objectStorageInfo(),
  };
}
