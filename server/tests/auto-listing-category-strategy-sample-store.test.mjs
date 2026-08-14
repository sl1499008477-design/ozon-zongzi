import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import sharp from "sharp";

import { createCategoryStrategySampleStore } from "../auto-listing-category-strategy-sample-store.mjs";
import { createExpectedHashObjectStorage } from "../object-storage.mjs";

const H = (value) => crypto.createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 2 * 1024 * 1024;
const CAPTURED_AT = "2026-08-15T00:00:00.000Z";
const EVIDENCE_KEYS = [
  "imageId", "role", "ordinal", "sourceUrlHost", "sourceRefHash", "sourceResponseHash",
  "sourceContentHash", "analysisObjectKey", "analysisContentHash", "thumbnailObjectKey",
  "thumbnailContentHash", "contentType", "width", "height", "capturedAt",
].sort();

let fixtureOrigin;
let fixtureServer;
let normalBytes;
let largePixelBytes;

test.before(async () => {
  normalBytes = await sharp({
    create: { width: 3200, height: 2400, channels: 3, background: "#7b4f2a" },
  }).jpeg({ quality: 92 }).toBuffer();
  largePixelBytes = await sharp({
    create: { width: 8000, height: 8000, channels: 3, background: "#112233" },
  }).jpeg({ quality: 70 }).toBuffer();
  fixtureServer = http.createServer((request, response) => {
    if (request.url === "/normal.jpg" || request.url === "/duplicate.jpg") {
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": normalBytes.length });
      response.end(normalBytes);
      return;
    }
    if (request.url === "/too-large.jpg") {
      const body = Buffer.alloc(MAX_BYTES + 1, 1);
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": body.length });
      response.end(body);
      return;
    }
    if (request.url === "/too-many-pixels.jpg") {
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": largePixelBytes.length });
      response.end(largePixelBytes);
      return;
    }
    if (request.url === "/html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not an image</html>");
      return;
    }
    if (request.url === "/broken.jpg") {
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end("not-jpeg");
      return;
    }
    if (request.url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
      return;
    }
    if (request.url === "/slow") return;
    response.writeHead(404).end();
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
});

test.after(async () => {
  fixtureServer.closeAllConnections?.();
  await new Promise((resolve) => fixtureServer.close(resolve));
});

function fixtureFetchImage() {
  return async ({ sourceUrl, signal, maxBytes, maxRedirects }) => {
    const requested = new URL(sourceUrl);
    if (requested.pathname === "/slow") {
      throw Object.assign(new Error("timeout"), { code: "IMAGE_FETCH_TIMEOUT" });
    }
    let target = `${fixtureOrigin}${requested.pathname}`;
    for (let redirectCount = 0; ; redirectCount += 1) {
      let response;
      try {
        response = await fetch(target, { redirect: "manual", signal });
      } catch (error) {
        if (signal.aborted) throw Object.assign(new Error("timeout"), { code: "IMAGE_FETCH_TIMEOUT" });
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount >= maxRedirects) {
          throw Object.assign(new Error("redirect loop"), { code: "IMAGE_FETCH_REDIRECT_LIMIT" });
        }
        target = new URL(response.headers.get("location"), target).href;
        continue;
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw Object.assign(new Error("too large"), { code: "IMAGE_FETCH_TOO_LARGE" });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, contentType: response.headers.get("content-type") || "" };
    }
  };
}

function memoryStorage({ responseLossAt = -1 } = {}) {
  const objects = new Map();
  const metadata = new Map();
  const etags = new Map();
  let version = 0;
  const calls = { puts: [], reads: [], removes: [] };
  const raw = {
    async putObject(input) {
      calls.puts.push(input.key);
      if (input.ifNoneMatch === "*" && objects.has(input.key)) {
        throw Object.assign(new Error("already exists"), { code: "PreconditionFailed", statusCode: 412 });
      }
      if (input.ifMatch && etags.get(input.key) !== input.ifMatch) {
        throw Object.assign(new Error("etag changed"), { code: "PreconditionFailed", statusCode: 412 });
      }
      version += 1;
      objects.set(input.key, Buffer.from(input.buffer));
      metadata.set(input.key, { ...(input.metadata || {}) });
      etags.set(input.key, `etag-${version}`);
      if (calls.puts.length === responseLossAt) throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" });
      return {
        key: input.key, sha256: H(input.buffer), contentType: input.contentType, size: input.buffer.length,
        etag: etags.get(input.key),
      };
    },
    async getObjectBuffer(key) {
      calls.reads.push(key);
      if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return Buffer.from(objects.get(key));
    },
    async statObject(key) {
      if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      const buffer = objects.get(key);
      return { etag: etags.get(key), size: buffer.length, metaData: { ...metadata.get(key) } };
    },
    async removeObject(key) {
      calls.removes.push(key);
      if (!objects.delete(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      metadata.delete(key);
      etags.delete(key);
    },
  };
  return { objects, calls, raw, api: createExpectedHashObjectStorage(raw) };
}

function sourceReferences(pathname = "/normal.jpg", count = 7) {
  return Array.from({ length: count }, (_, ordinal) => ({
    imageId: `image-${ordinal}`,
    role: ordinal === 0 ? "MAIN" : "DETAIL",
    ordinal,
    sourceUrl: `https://cdn.example.test${pathname}?signature=must-not-persist`,
    sourceResponseHash: H(`response-${ordinal}`),
  }));
}

function request(overrides = {}) {
  return {
    accountId: "account-a",
    draftId: "draft-a",
    sampleSetId: "set-a",
    sampleId: "sample-a",
    correlationId: "correlation-a",
    sourceReferences: sourceReferences(),
    ...overrides,
  };
}

function service(storage, fetchImage = fixtureFetchImage()) {
  return createCategoryStrategySampleStore({
    fetchImage,
    objectStorage: storage,
    now: () => CAPTURED_AT,
    maxDownloadBytes: MAX_BYTES,
  });
}

test("stores only MAIN0 plus DETAIL1..5 as exact frozen Task3 evidence and deduplicates identical source bytes", async () => {
  const storage = memoryStorage();
  const store = service(storage.api);
  const first = await store.persistSampleImages(request());

  assert.equal(first.length, 6);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(storage.calls.puts.filter((key) => key.endsWith(".webp")).length, 2);
  for (const [ordinal, evidence] of first.entries()) {
    assert.deepEqual(Object.keys(evidence).sort(), EVIDENCE_KEYS);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(evidence.role, ordinal === 0 ? "MAIN" : "DETAIL");
    assert.equal(evidence.ordinal, ordinal);
    assert.equal(evidence.sourceUrlHost, "cdn.example.test");
    assert.equal(evidence.sourceRefHash, H(`https://cdn.example.test/normal.jpg?signature=must-not-persist`));
    assert.equal(evidence.sourceResponseHash, H(`response-${ordinal}`));
    assert.equal(evidence.sourceContentHash, H(normalBytes));
    assert.equal(evidence.contentType, "image/webp");
    assert.equal(evidence.width, 2048);
    assert.equal(evidence.height, 1536);
    assert.equal(evidence.capturedAt, CAPTURED_AT);
    for (const key of [evidence.analysisObjectKey, evidence.thumbnailObjectKey]) {
      assert.match(key, new RegExp(`^category-strategy/account-a/draft-a/set-a/sample-a/[a-f0-9]{64}/${evidence.sourceContentHash}/`));
      assert.doesNotMatch(key, /signature|credential|must-not-persist|https?:/u);
    }
    const analysis = await sharp(storage.objects.get(evidence.analysisObjectKey)).metadata();
    const thumbnail = await sharp(storage.objects.get(evidence.thumbnailObjectKey)).metadata();
    assert.deepEqual([analysis.width, analysis.height, analysis.format], [2048, 1536, "webp"]);
    assert.deepEqual([thumbnail.width, thumbnail.height, thumbnail.format], [256, 256, "webp"]);
  }
  assert.equal(new Set(first.map((entry) => entry.analysisObjectKey)).size, 1);
  assert.equal(new Set(first.map((entry) => entry.thumbnailObjectKey)).size, 1);
  assert.equal([...storage.objects.values()].some((bytes) => bytes.equals(normalBytes)), false);

  const replay = await store.persistSampleImages(request());
  assert.deepEqual(replay, first);
  assert.notEqual(replay, first);
  assert.notEqual(replay[0], first[0]);
  assert.equal(storage.calls.puts.filter((key) => key.endsWith(".webp")).length, 2);
});

test("maps SSRF, non-image, oversized, redirect, timeout, and decode failures to fixed safe codes", async () => {
  const cases = [
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_SSRF_BLOCKED", request({ sourceReferences: sourceReferences().map((entry) => ({ ...entry, sourceUrl: "http://127.0.0.1/private" })) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_SSRF_BLOCKED", request({ sourceReferences: sourceReferences().map((entry) => ({ ...entry, sourceUrl: "https://[2001:4860:4860::8888]/normal.jpg" })) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_MIME_BLOCKED", request({ sourceReferences: sourceReferences("/html", 1) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE", request({ sourceReferences: sourceReferences("/too-large.jpg", 1) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE", request({ sourceReferences: sourceReferences("/too-many-pixels.jpg", 1) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_REDIRECT_BLOCKED", request({ sourceReferences: sourceReferences("/loop", 1) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TIMEOUT", request({ sourceReferences: sourceReferences("/slow", 1) })],
    ["AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_DECODE_FAILED", request({ sourceReferences: sourceReferences("/broken.jpg", 1) })],
  ];
  for (const [code, input] of cases) {
    const storage = memoryStorage();
    await assert.rejects(service(storage.api).persistSampleImages(input), (error) => error?.code === code);
    assert.equal(storage.objects.size, 0, code);
  }
});

test("closed descriptor-safe input rejects accessors and credentials before download or storage", async () => {
  let getterCalls = 0;
  let proxyTrapCalls = 0;
  let fetchCalls = 0;
  const storage = memoryStorage();
  const store = service(storage.api, async () => { fetchCalls += 1; });
  const hostile = request();
  Object.defineProperty(hostile, "credential", { enumerable: true, get() { getterCalls += 1; return "secret"; } });
  await assert.rejects(store.persistSampleImages(hostile), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_STORE_INVALID",
  });
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(storage.objects.size, 0);

  const hostileProxy = new Proxy(request(), {
    getPrototypeOf() { proxyTrapCalls += 1; throw new Error("must not inspect proxy"); },
  });
  await assert.rejects(store.persistSampleImages(hostileProxy), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_STORE_INVALID",
  });
  assert.equal(proxyTrapCalls, 0);
});

test("rejects identities that would exceed Task3's 1024-byte object-key contract before external work", async () => {
  let fetchCalls = 0;
  const storage = memoryStorage();
  const store = service(storage.api, async () => { fetchCalls += 1; });
  const long = "a".repeat(240);
  await assert.rejects(store.persistSampleImages(request({
    accountId: `1${long.slice(1)}`,
    draftId: `2${long.slice(1)}`,
    sampleSetId: `3${long.slice(1)}`,
    sampleId: `4${long.slice(1)}`,
  })), { code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_STORE_INVALID" });
  assert.equal(fetchCalls, 0);
  assert.equal(storage.objects.size, 0);
});

test("a later failure cleans a response-loss-owned object and manifest without partial evidence or orphans", async () => {
  const storage = memoryStorage({ responseLossAt: 2 });
  const originalPut = storage.api.putOwnedObjectExpected;
  let calls = 0;
  const failingStorage = {
    ...storage.api,
    async putOwnedObjectExpected(input) {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("offline"), { code: "EXPECTED_HASH_OBJECT_STORAGE_UNAVAILABLE" });
      return originalPut(input);
    },
  };
  await assert.rejects(service(failingStorage).persistSampleImages(request({ sourceReferences: sourceReferences("/normal.jpg", 2) })), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED",
  });
  assert.equal(storage.objects.size, 0);
  assert.equal(storage.calls.removes.length, 2);
});

test("two independent factories expose only IN_PROGRESS or exact DONE replay for one concurrent sample scope", async () => {
  const storage = memoryStorage();
  const delegate = fixtureFetchImage();
  let active = 0;
  let maxActive = 0;
  const fetchImage = async (input) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try { return await delegate(input); } finally { active -= 1; }
  };
  const firstStore = service(createExpectedHashObjectStorage(storage.raw), fetchImage);
  const secondStore = service(createExpectedHashObjectStorage(storage.raw), fetchImage);
  const input = request({ sourceReferences: sourceReferences("/normal.jpg", 1) });
  const outcomes = await Promise.allSettled([
    firstStore.persistSampleImages(input),
    secondStore.persistSampleImages(input),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.ok(fulfilled.length >= 1);
  assert.ok(rejected.every((outcome) => outcome.reason?.code === "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_IN_PROGRESS"
    && outcome.reason?.retryable === true));
  assert.equal(maxActive, 2);
  const replay = await secondStore.persistSampleImages(input);
  assert.deepEqual(replay, fulfilled[0].value);
  assert.equal(storage.calls.puts.filter((key) => key.endsWith(".webp")).length, 2);
});

test("DONE replay fails closed when a manifest-referenced object is no longer readable", async () => {
  const storage = memoryStorage();
  const store = service(storage.api);
  const input = request({ sourceReferences: sourceReferences("/normal.jpg", 1) });
  const evidence = await store.persistSampleImages(input);
  await storage.raw.removeObject(evidence[0].analysisObjectKey);
  await assert.rejects(store.persistSampleImages(input), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED",
  });
});
