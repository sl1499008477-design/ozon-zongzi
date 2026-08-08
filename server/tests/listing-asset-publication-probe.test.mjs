import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createListingAssetPublicationProbe } from "../listing-asset-publication-probe.mjs";

const policy = Object.freeze({
  origin: "https://media.example.com",
  baseUrl: "https://media.example.com/ozon/",
  prefix: "listing-media/v1",
  publicationVersion: "LISTING_MEDIA_V1",
});

function response({ status = 200, contentType = "application/octet-stream", bytes = Buffer.from("probe-bytes") } = {}) {
  return {
    status,
    headers: { get(name) { return name.toLowerCase() === "content-type" ? contentType : null; } },
    body: {
      getReader() {
        let done = false;
        return { async read() {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: bytes };
        }, cancel() {}, releaseLock() {} };
      },
    },
  };
}

function harness({ fetched = response(), removeError = null } = {}) {
  const calls = [];
  const probe = createListingAssetPublicationProbe({
    storage: {
      async putObjectFromBuffer(input) {
        calls.push(["put", input]);
        return { key: input.key, sha256: crypto.createHash("sha256").update(input.buffer).digest("hex"),
          contentType: input.contentType, size: input.buffer.length };
      },
      async removeObject(key) {
        calls.push(["remove", key]);
        if (removeError) throw removeError;
      },
    },
    async resolveHostname(hostname) {
      calls.push(["resolve", hostname]);
      return [{ address: "203.0.113.10", family: 4 }];
    },
    async requestPublicObject(url, init) {
      calls.push(["fetch", { url, init }]);
      return fetched;
    },
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
    randomBytes: () => Buffer.from("probe-bytes"),
    timers: { setTimeout() { return 7; }, clearTimeout() {} },
  });
  return { probe, calls };
}

test("probe explicitly publishes, reads exact HTTPS bytes without redirects, then removes the canary", async () => {
  const h = harness();
  const result = await h.probe(policy);
  assert.deepEqual(result, { ok: true, evidence: {
    probeKind: "PUBLIC_READBACK", httpStatus: 200, contentTypeMatched: true, bytesMatched: true,
  } });
  assert.deepEqual(h.calls.map(([kind]) => kind), ["put", "resolve", "fetch", "remove"]);
  assert.equal(h.calls[0][1].key,
    "listing-media/v1/health/123e4567-e89b-12d3-a456-426614174000.bin");
  assert.equal(h.calls[1][1], "media.example.com");
  assert.equal(h.calls[2][1].url,
    "https://media.example.com/ozon/listing-media/v1/health/123e4567-e89b-12d3-a456-426614174000.bin");
  assert.equal(h.calls[2][1].init.redirect, "manual");
  assert.equal(h.calls[2][1].init.method, "GET");
  assert.deepEqual(h.calls[2][1].init.address, { address: "203.0.113.10", family: 4 });
});

test("probe fails closed on wrong bytes, MIME, redirects, oversized responses, cleanup ambiguity, or unsafe policy", async () => {
  for (const options of [
    { fetched: response({ bytes: Buffer.from("wrong") }) },
    { fetched: response({ contentType: "text/html" }) },
    { fetched: response({ status: 302 }) },
    { fetched: response({ bytes: Buffer.alloc(2_000) }) },
    { removeError: new Error("unsafe storage detail") },
  ]) {
    const result = await harness(options).probe(policy);
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.evidence).sort(),
      ["bytesMatched", "contentTypeMatched", "httpStatus", "probeKind"].sort());
    assert.equal(JSON.stringify(result).includes("unsafe storage detail"), false);
  }
  const h = harness();
  await assert.rejects(h.probe({ ...policy, baseUrl: "https://127.0.0.1/ozon/" }), {
    code: "LISTING_ASSET_PUBLICATION_PROBE_INVALID",
  });
  assert.equal(h.calls.length, 0);
});

test("probe validates storage acknowledgement before any public fetch", async () => {
  const calls = [];
  const probe = createListingAssetPublicationProbe({
    storage: {
      async putObjectFromBuffer(input) { calls.push("put"); return { ...input, key: "wrong/key" }; },
      async removeObject() { calls.push("remove"); },
    },
    async resolveHostname() { calls.push("resolve"); return [{ address: "203.0.113.10", family: 4 }]; },
    async requestPublicObject() { calls.push("fetch"); return response(); },
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
    randomBytes: () => Buffer.from("probe-bytes"),
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  assert.equal((await probe(policy)).ok, false);
  assert.deepEqual(calls, ["put", "remove"]);
});

test("an ambiguous canary write still performs deterministic cleanup and never fetches", async () => {
  const calls = [];
  const probe = createListingAssetPublicationProbe({
    storage: {
      async putObjectFromBuffer() { calls.push("put"); throw new Error("response lost"); },
      async removeObject() { calls.push("remove"); },
    },
    async resolveHostname() { calls.push("resolve"); return [{ address: "203.0.113.10", family: 4 }]; },
    async requestPublicObject() { calls.push("fetch"); return response(); },
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
    randomBytes: () => Buffer.from("probe-bytes"),
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  assert.equal((await probe(policy)).ok, false);
  assert.deepEqual(calls, ["put", "remove"]);
});

test("probe rejects a hostname resolving to a private address before any HTTPS request", async () => {
  const calls = [];
  const probe = createListingAssetPublicationProbe({
    storage: {
      async putObjectFromBuffer(input) {
        calls.push("put");
        return { key: input.key, sha256: crypto.createHash("sha256").update(input.buffer).digest("hex"),
          contentType: input.contentType, size: input.buffer.length };
      },
      async removeObject() { calls.push("remove"); },
    },
    async resolveHostname() { calls.push("resolve"); return [{ address: "169.254.169.254", family: 4 }]; },
    async requestPublicObject() { calls.push("fetch"); return response(); },
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
    randomBytes: () => Buffer.from("probe-bytes"),
  });
  assert.equal((await probe(policy)).ok, false);
  assert.deepEqual(calls, ["put", "resolve", "remove"]);
});

test("probe total timeout also aborts a response body that never finishes", async () => {
  let cancelled = false;
  const hanging = response();
  hanging.body.getReader = () => ({
    read: () => new Promise(() => {}),
    async cancel() { cancelled = true; },
    releaseLock() {},
  });
  const probe = createListingAssetPublicationProbe({
    storage: {
      async putObjectFromBuffer(input) {
        return { key: input.key, sha256: crypto.createHash("sha256").update(input.buffer).digest("hex"),
          contentType: input.contentType, size: input.buffer.length };
      },
      async removeObject() {},
    },
    async resolveHostname() { return [{ address: "203.0.113.10", family: 4 }]; },
    async requestPublicObject() { return hanging; },
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
    randomBytes: () => Buffer.from("probe-bytes"),
    timeoutMs: 20,
  });
  const result = await Promise.race([
    probe(policy),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.notEqual(result, "still-pending");
  assert.equal(result.ok, false);
  assert.equal(cancelled, true);
});

test("probe total timeout destroys a hanging async-iterator body and still removes the canary", async () => {
  const calls = [];
  let destroyed = false;
  let returned = false;
  const hanging = {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        async return() { returned = true; return { done: true }; },
      };
    },
    destroy() { destroyed = true; },
  };
  const probe = createListingAssetPublicationProbe({
    storage: {
      async putObjectFromBuffer(input) {
        calls.push(["put", input.key]);
        return { key: input.key, sha256: crypto.createHash("sha256").update(input.buffer).digest("hex"),
          contentType: input.contentType, size: input.buffer.length };
      },
      async removeObject(key) { calls.push(["remove", key]); },
    },
    async resolveHostname() { return [{ address: "203.0.113.10", family: 4 }]; },
    async requestPublicObject() { return hanging; },
    randomUUID: () => "123e4567-e89b-12d3-a456-426614174000",
    randomBytes: () => Buffer.from("probe-bytes"),
    timeoutMs: 20,
  });

  const result = await Promise.race([
    probe(policy),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);

  assert.notEqual(result, "still-pending");
  assert.equal(result.ok, false);
  assert.equal(destroyed, true);
  assert.equal(returned, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["put", "remove"]);
  assert.equal(calls[0][1], calls[1][1]);
});
