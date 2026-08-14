import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAutoListingCategoryStrategyService } from "../auto-listing-category-strategy-service.mjs";

const HASH = "a".repeat(64);
const SCOPE = Object.freeze({
  accountId: "account-a", taxonomyScope: "OZON:DEFAULT",
  descriptionCategoryId: 17028922, typeId: 91542,
});
const ACTOR = Object.freeze({ id: "account-a", role: "admin" });

function draft(overrides = {}) {
  return {
    draftId: "draft-a", accountId: "account-a", scope: SCOPE,
    draftVersion: 1, status: "COLLECTING", sampleCount: 0,
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
    browserUrl: "https://www.ozon.ru/category/17028922/",
    ...overrides,
  };
}

function selectedSamples(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    sku: `sku-${index + 1}`, sourceProductId: 4_862_904_234 + index,
    sourceProductRef: `product-${index + 1}`,
  }));
}

function factFor(input) {
  return {
    sku: input.sku,
    sourceProductId: input.sourceProductId,
    sourceProductRef: input.sourceProductRef,
    sourceProductResponseHash: crypto.createHash("sha256").update(input.sku).digest("hex"),
    pageScope: { taxonomyScope: SCOPE.taxonomyScope,
      descriptionCategoryId: SCOPE.descriptionCategoryId, typeId: SCOPE.typeId },
    productScope: { taxonomyScope: SCOPE.taxonomyScope,
      descriptionCategoryId: SCOPE.descriptionCategoryId, typeId: SCOPE.typeId },
    sourceReferences: [{
      imageId: `image-${input.sku}`, role: "MAIN", ordinal: 0,
      sourceUrl: `https://cdn.ozon.test/${input.sku}.jpg`, sourceResponseHash: HASH,
    }],
  };
}

function imageEvidence(reference, sampleId, sampleSetId) {
  const prefix = `category-strategy/account-a/draft-a/${sampleSetId}/${sampleId}`;
  return {
    imageId: reference.imageId, role: reference.role, ordinal: reference.ordinal,
    sourceUrlHost: "cdn.ozon.test", sourceRefHash: HASH,
    sourceResponseHash: reference.sourceResponseHash, sourceContentHash: HASH,
    analysisObjectKey: `${prefix}/analysis.webp`, analysisContentHash: HASH,
    thumbnailObjectKey: `${prefix}/thumbnail.webp`, thumbnailContentHash: HASH,
    contentType: "image/webp", width: 1200, height: 1600,
    capturedAt: "2026-08-15T00:00:00.000Z",
  };
}

function harness({ currentDraft = draft(), verify = factFor, persistFailure = null,
  commitFailure = null, publicationExtra = false, repositoryTransform = (_method, value) => value,
  handoffFailure = null, handoffWait = null, sessionValidationFailure = null,
  draftReplay = null, sessionReplay = null, committedReplay = null,
  policyMode = "REQUIRE_EXACT_STRATEGY",
  publicationFailure = null,
  publicationOverrides = {},
  now = new Date("2026-08-15T00:00:00.000Z") } = {}) {
  const calls = { read: 0, verify: 0, persist: 0, commit: 0, policy: 0,
    handoff: 0, publish: 0, rollback: 0 };
  const records = { session: [], handoff: [], persist: [], commit: [], identity: [] };
  let currentPolicyMode = policyMode;
  let storedSession = sessionReplay;
  const repository = {
    async getDraftReplay(input) {
      assert.deepEqual(Object.keys(input).sort(), ["accountId", "actorId", "correlationId", "expectedSourceVersion",
        "idempotencyKey", "scope", "sourceCollectItemId"].sort());
      return draftReplay;
    },
    async getSamplingSessionReplay(input) {
      assert.deepEqual(Object.keys(input).sort(), ["accountId", "actorId", "correlationId", "draftId",
        "expectedDraftVersion", "idempotencyKey", "sessionId", "sessionSecretHash"].sort());
      return storedSession;
    },
    async getCommittedSampleSetReplay(input) {
      assert.deepEqual(Object.keys(input).sort(), ["accountId", "actorId", "correlationId", "draftId",
        "expectedDraftVersion", "idempotencyKey", "selections", "sessionId", "sessionSecretHash"].sort());
      return committedReplay;
    },
    async validateSamplingSession(input) {
      assert.deepEqual(Object.keys(input).sort(), ["accountId", "actorId", "draftId",
        "expectedDraftVersion", "sessionId", "sessionSecretHash"].sort());
      if (sessionValidationFailure) throw sessionValidationFailure;
      return { sessionId: "session-a", draftId: "draft-a", accountId: "account-a",
        state: "ACTIVE", createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (2 * 60 * 60 * 1000)).toISOString(), duplicate: false };
    },
    async createDraft(input) { return repositoryTransform("createDraft",
      { draftId: currentDraft.draftId, accountId: input.accountId, scope: input.scope,
        draftVersion: 1, status: "COLLECTING", sourceCollectItemId: input.sourceCollectItemId,
        expectedSourceVersion: input.expectedSourceVersion, duplicate: false }); },
    async startSamplingSession(input) {
      records.session.push(input);
      storedSession = repositoryTransform("startSamplingSession",
        { sessionId: input.sessionId, draftId: input.draftId, accountId: input.accountId,
          state: "ACTIVE", createdAt: now.toISOString(), expiresAt: input.expiresAt, duplicate: false });
      return storedSession;
    },
    async commitSampleSetCanonical(input) {
      calls.commit += 1;
      records.commit.push(input);
      const failure = typeof commitFailure === "function" ? commitFailure(calls.commit) : commitFailure;
      if (failure) throw failure;
      return repositoryTransform("commitSampleSetCanonical", { sampleSetId: input.samples[0].sampleSetId, draftId: input.draftId,
        accountId: input.accountId, sampleSetHash: HASH,
        sampleCount: input.samples.length, draftVersion: input.expectedDraftVersion + 1,
        status: "SAMPLES_READY", idempotencyKey: input.idempotencyKey, duplicate: false });
    },
    async transitionAccountPolicy(input) {
      calls.policy += 1;
      currentPolicyMode = input.mode;
      return repositoryTransform("transitionAccountPolicy", { accountId: input.accountId, mode: input.mode,
        version: input.expectedVersion + 1, duplicate: false });
    },
    async getAccountPolicy({ accountId }) {
      return repositoryTransform("getAccountPolicy",
        { accountId, mode: currentPolicyMode, version: 1, duplicate: false });
    },
  };
  const readModel = {
    async listStrategies({ accountId }) { calls.read += 1; return [currentDraft && { ...currentDraft, accountId }].filter(Boolean); },
    async getDraft() { calls.read += 1; return currentDraft; },
  };
  const sampleStore = {
    async persistSampleImages(input) {
      calls.persist += 1;
      records.persist.push(input);
      if (persistFailure) throw persistFailure;
      return input.sourceReferences.map((entry) => imageEvidence(entry, input.sampleId, input.sampleSetId));
    },
  };
  const exactProductFacts = {
    async verify(input) { calls.verify += 1; return verify(input); },
  };
  const extensionSessionChannel = {
    async putSession(input) {
      calls.handoff += 1;
      records.handoff.push(input);
      assert.equal(input.sessionSecret.length >= 32, true);
      if (handoffWait) await handoffWait(calls.handoff);
      const failure = typeof handoffFailure === "function" ? handoffFailure(calls.handoff) : handoffFailure;
      if (failure) throw failure;
    },
  };
  const publicationService = {
    async publishCategoryStrategyDraft() { calls.publish += 1; if (publicationFailure) throw publicationFailure; return {
      id: "strategy-v2", strategyKey: "default", version: 2, status: "PUBLISHED", duplicate: false,
      ...publicationOverrides,
      ...(publicationExtra ? { vendorSecret: "must-not-leak" } : {}),
    }; },
    async rollbackCategoryStrategyVersion() { calls.rollback += 1; if (publicationFailure) throw publicationFailure; return {
      id: "strategy-v3", strategyKey: "default", version: 3, status: "PUBLISHED", duplicate: false,
      ...publicationOverrides,
      ...(publicationExtra ? { vendorSecret: "must-not-leak" } : {}),
    }; },
  };
  const service = createAutoListingCategoryStrategyService({
    repository, readModel, sampleStore, exactProductFacts, extensionSessionChannel,
    publicationService,
    now: () => new Date(now),
    async deriveSessionIdentity(input) {
      records.identity.push(input);
      const material = JSON.stringify(input);
      return {
        sessionId: `session-${crypto.createHash("sha256").update(`id:${material}`).digest("hex").slice(0, 40)}`,
        sessionSecret: crypto.createHmac("sha256", "test-only-session-key-that-is-long-enough")
          .update(material).digest("hex"),
      };
    },
  });
  return { service, calls, records };
}

test("administrator settings are account-scoped and store identity is not accepted", async () => {
  const h = harness({ policyMode: "LEGACY_FALLBACK" });
  assert.deepEqual(await h.service.getSettings({ actor: ACTOR }), {
    mode: "LEGACY_FALLBACK", version: 1,
  });
  assert.deepEqual(await h.service.updateSettings({
    actor: ACTOR, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
    idempotencyKey: "policy-a", correlationId: "correlation-a",
  }), { mode: "REQUIRE_EXACT_STRATEGY", version: 2, duplicate: false });
  await assert.rejects(h.service.updateSettings({
    actor: ACTOR, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
    idempotencyKey: "policy-b", correlationId: "correlation-b", storeId: "store-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID", status: 400 });
  assert.equal(h.calls.policy, 1);
});

test("LEGACY_FALLBACK is account read-only until an administrator explicitly enables strategy mutations", async () => {
  const h = harness({ policyMode: "LEGACY_FALLBACK" });
  assert.equal((await h.service.listStrategies({ actor: ACTOR })).length, 1);
  assert.equal((await h.service.getDraft({ actor: ACTOR, draftId: "draft-a" })).draftId, "draft-a");
  await assert.rejects(h.service.createDraft({
    actor: ACTOR, scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 },
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
    idempotencyKey: "disabled-draft", correlationId: "correlation-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", status: 409 });
  assert.equal(h.calls.handoff, 0);
  assert.equal(h.calls.persist, 0);
  assert.equal(h.calls.commit, 0);
  await h.service.updateSettings({ actor: ACTOR, expectedVersion: 1,
    mode: "REQUIRE_EXACT_STRATEGY", idempotencyKey: "enable", correlationId: "correlation-a" });
  assert.equal((await h.service.createDraft({
    actor: ACTOR, scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 },
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
    idempotencyKey: "enabled-draft", correlationId: "correlation-a",
  })).status, "COLLECTING");
});

test("a durable draft replay remains readable after rollout returns to LEGACY_FALLBACK", async () => {
  const h = harness({ policyMode: "LEGACY_FALLBACK", draftReplay: {
    draftId: "draft-a", accountId: "account-a", scope: SCOPE, draftVersion: 1, status: "COLLECTING",
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1", duplicate: true,
  } });
  assert.deepEqual(await h.service.createDraft({
    actor: ACTOR, scope: { taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 },
    sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
    idempotencyKey: "draft-a", correlationId: "correlation-a",
  }), {
    draftId: "draft-a", scope: { taxonomyScope: "OZON:DEFAULT",
      descriptionCategoryId: 17028922, typeId: 91542 },
    draftVersion: 1, status: "COLLECTING", duplicate: true,
  });
});

test("administrator can list, read, and create exact account-scoped drafts", async () => {
  const h = harness();
  assert.deepEqual(await h.service.listStrategies({ actor: ACTOR }), [{
    draftId: "draft-a", scope: {
      taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542,
    }, draftVersion: 1, status: "COLLECTING", sampleCount: 0,
  }]);
  assert.deepEqual(await h.service.getDraft({ actor: ACTOR, draftId: "draft-a" }), {
    draftId: "draft-a", scope: {
      taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542,
    }, draftVersion: 1, status: "COLLECTING", sampleCount: 0,
  });
  assert.deepEqual(await h.service.createDraft({
    actor: ACTOR, scope: {
      taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542,
    }, sourceCollectItemId: "collect-a", expectedSourceVersion: "draft:1",
    idempotencyKey: "draft-a", correlationId: "correlation-a",
  }), {
    draftId: "draft-a", scope: {
      taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542,
    }, draftVersion: 1, status: "COLLECTING", duplicate: false,
  });
});

test("sampling session uses DB-authoritative repository expiry and never returns its secret", async () => {
  const h = harness({ currentDraft: draft({
    browserUrl: "https://www.ozon.ru/category/17028922/?tracking=must-not-leak",
  }) });
  const result = await h.service.startSamplingSession({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-a", correlationId: "correlation-a",
  });
  assert.deepEqual(Object.keys(result), [
    "sessionId", "expiresAt", "browserUrl", "extensionMode", "scope", "duplicate",
  ]);
  assert.equal(result.browserUrl, "https://www.ozon.ru/category/17028922/");
  assert.equal(result.extensionMode, "CATEGORY_STRATEGY_SAMPLING");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(new URL(result.browserUrl).searchParams.has("sessionSecret"), false);
  assert.equal(h.calls.handoff, 1);
  assert.deepEqual(await h.service.startSamplingSession({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-a", correlationId: "correlation-a",
  }), result);
  assert.equal(h.calls.handoff, 1);
});

test("sampling session handoff retry keeps the original secret identity without exposing it", async () => {
  const retryable = Object.assign(new Error("extension channel unavailable"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_CHANNEL_FAILED", status: 503,
  });
  const h = harness({ handoffFailure: (attempt) => attempt === 1 ? retryable : null });
  const input = { actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-retry", correlationId: "correlation-a" };
  await assert.rejects(h.service.startSamplingSession(input), { code: retryable.code, status: 503 });
  const result = await h.service.startSamplingSession(input);
  assert.equal(h.records.session.length, 1);
  assert.equal(h.records.session[0].sessionId, h.records.handoff[0].sessionId);
  assert.equal(h.records.session[0].sessionSecretHash,
    crypto.createHash("sha256").update(h.records.handoff[0].sessionSecret).digest("hex"));
  assert.equal(h.records.handoff[1].sessionSecret, h.records.handoff[0].sessionSecret);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("successful replay cache entries expire and re-enter durable replay", async () => {
  const clock = new Date("2026-08-15T00:00:00.000Z");
  const h = harness({ now: clock });
  const input = { actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-expiring-cache", correlationId: "correlation-a" };

  const first = await h.service.startSamplingSession(input);
  assert.equal(h.records.identity.length, 1);

  clock.setUTCMinutes(clock.getUTCMinutes() + 31);
  const replay = await h.service.startSamplingSession(input);

  assert.equal(h.records.identity.length, 2);
  assert.equal(replay.sessionId, first.sessionId);
  assert.equal(replay.duplicate, true);
  assert.equal(h.records.session.length, 1);
});

test("a session handoff retry remains single-flight while it crosses the replay TTL", async () => {
  const clock = new Date("2026-08-15T00:00:00.000Z");
  let releaseRetry;
  let retryEntered;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  const entered = new Promise((resolve) => { retryEntered = resolve; });
  const h = harness({
    now: clock,
    handoffFailure: (attempt) => attempt === 1
      ? Object.assign(new Error("temporary handoff failure"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_CHANNEL_FAILED", status: 503,
      }) : null,
    handoffWait: async (attempt) => {
      if (attempt === 2) {
        retryEntered();
        await retryGate;
      }
    },
  });
  const input = { actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-crossing-ttl", correlationId: "correlation-a" };

  await assert.rejects(h.service.startSamplingSession(input), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_EXTENSION_CHANNEL_FAILED", status: 503,
  });
  const retry = h.service.startSamplingSession(input);
  await entered;
  clock.setUTCMinutes(clock.getUTCMinutes() + 31);
  const concurrentReplay = h.service.startSamplingSession(input);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.calls.handoff, 2);
  assert.equal(h.records.identity.length, 1);
  releaseRetry();
  assert.deepEqual(await concurrentReplay, await retry);
});

test("sample confirmation revalidates every SKU before persistence and atomically commits Task 4 evidence", async () => {
  const h = harness();
  const input = {
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    sessionId: "session-a", sessionSecret: "secret-value-at-least-32-characters",
    samples: selectedSamples(), idempotencyKey: "samples-a", correlationId: "correlation-a",
  };
  const result = await h.service.confirmSampleSet(input);
  assert.deepEqual({ ...result, sampleSetId: result.sampleSetId.startsWith("sample-set-") }, {
    draftId: "draft-a", sampleSetId: true, sampleSetHash: HASH,
    sampleCount: 5, draftVersion: 2, status: "SAMPLES_READY", duplicate: false,
  });
  assert.deepEqual(h.calls, { read: 1, verify: 5, persist: 5, commit: 1, policy: 0,
    handoff: 0, publish: 0, rollback: 0 });

  assert.deepEqual(await h.service.confirmSampleSet(input), result);
  assert.deepEqual(h.calls, { read: 1, verify: 5, persist: 5, commit: 1, policy: 0,
    handoff: 0, publish: 0, rollback: 0 });
});

test("durable repository replays bypass browser facts, object storage, and current draft state", async () => {
  const committedReplay = { sampleSetId: "sample-set-durable", draftId: "draft-a", accountId: "account-a",
    sampleSetHash: HASH, sampleCount: 5, draftVersion: 2, status: "SAMPLES_READY",
    idempotencyKey: "samples-durable", duplicate: true };
  const h = harness({ currentDraft: draft({ status: "SAMPLES_READY", draftVersion: 2, sampleCount: 5 }),
    committedReplay });
  assert.deepEqual(await h.service.confirmSampleSet({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    sessionId: "session-a", sessionSecret: "secret-value-at-least-32-characters",
    samples: selectedSamples(), idempotencyKey: "samples-durable", correlationId: "correlation-a",
  }), {
    draftId: "draft-a", sampleSetId: "sample-set-durable", sampleSetHash: HASH,
    sampleCount: 5, draftVersion: 2, status: "SAMPLES_READY", duplicate: true,
  });
  assert.deepEqual(h.calls, { read: 0, verify: 0, persist: 0, commit: 0, policy: 0,
    handoff: 0, publish: 0, rollback: 0 });
});

test("sample retry after a pre-commit failure reuses the exact evidence identity", async () => {
  const retryable = Object.assign(new Error("temporary repository failure"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_DATABASE_FAILED", status: 503,
  });
  const h = harness({ commitFailure: (attempt) => attempt === 1 ? retryable : null });
  const input = {
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    sessionId: "session-a", sessionSecret: "secret-value-at-least-32-characters",
    samples: selectedSamples(), idempotencyKey: "samples-retry", correlationId: "correlation-a",
  };
  await assert.rejects(h.service.confirmSampleSet(input), { code: retryable.code, status: 503 });
  const result = await h.service.confirmSampleSet(input);
  assert.equal(result.sampleSetId, h.records.commit[0].samples[0].sampleSetId);
  assert.deepEqual(h.records.commit[1].samples.map(({ sampleSetId, sampleId }) => ({ sampleSetId, sampleId })),
    h.records.commit[0].samples.map(({ sampleSetId, sampleId }) => ({ sampleSetId, sampleId })));
  assert.equal(h.calls.commit, 2);
});

test("mixed category, duplicate SKU, expired secret, image failure, and repository conflict stop unrelated side effects", async () => {
  const cases = [
    {
      h: harness({ verify(input) { return { ...factFor(input), productScope: {
        ...factFor(input).productScope, typeId: 1,
      } }; } }),
      input: { samples: selectedSamples() }, code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SCOPE_CONFLICT",
      want: { verify: 1, persist: 0, commit: 0 },
    },
    {
      h: harness({ verify(input) { return { ...factFor(input), pageScope: {
        ...factFor(input).pageScope, descriptionCategoryId: 1,
      } }; } }),
      input: { samples: selectedSamples() }, code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SCOPE_CONFLICT",
      want: { verify: 1, persist: 0, commit: 0 },
    },
    {
      h: harness(), input: { samples: [...selectedSamples(4), selectedSamples(1)[0]] },
      code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_DUPLICATE", want: { verify: 0, persist: 0, commit: 0 },
    },
    {
      h: harness({ persistFailure: Object.assign(new Error("storage"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", status: 503,
      }) }), input: { samples: selectedSamples() },
      code: "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", want: { verify: 5, persist: 1, commit: 0 },
    },
    {
      h: harness({ sessionValidationFailure: Object.assign(new Error("expired"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", status: 409,
      }) }), input: { samples: selectedSamples() },
      code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_EXPIRED", want: { verify: 0, persist: 0, commit: 0 },
    },
    {
      h: harness({ sessionValidationFailure: Object.assign(new Error("secret mismatch"), {
        code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_SECRET_MISMATCH", status: 409,
      }) }), input: { samples: selectedSamples() },
      code: "AUTO_LISTING_CATEGORY_STRATEGY_SESSION_SECRET_MISMATCH",
      want: { verify: 0, persist: 0, commit: 0 },
    },
  ];
  for (const entry of cases) {
    await assert.rejects(entry.h.service.confirmSampleSet({
      actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
      sessionId: "session-a", sessionSecret: "secret-value-at-least-32-characters",
      idempotencyKey: `idem-${entry.code}`, correlationId: "correlation-a", ...entry.input,
    }), { code: entry.code });
    assert.equal(entry.h.calls.verify, entry.want.verify);
    assert.equal(entry.h.calls.persist, entry.want.persist);
    assert.equal(entry.h.calls.commit, entry.want.commit);
    assert.equal(entry.h.calls.publish, 0);
    assert.equal(entry.h.calls.rollback, 0);
  }
});

test("cross-account drafts are hidden and hostile requests invoke no getter, proxy trap, or dependency", async () => {
  const h = harness({ currentDraft: draft({ accountId: "account-b",
    scope: { ...SCOPE, accountId: "account-b" } }) });
  await assert.rejects(h.service.getDraft({ actor: ACTOR, draftId: "draft-a" }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", status: 404,
  });
  let getterReads = 0;
  const accessor = { actor: ACTOR };
  Object.defineProperty(accessor, "draftId", { enumerable: true, get() { getterReads += 1; return "draft-a"; } });
  let proxyTraps = 0;
  const proxy = new Proxy({ actor: ACTOR, draftId: "draft-a" }, {
    ownKeys() { proxyTraps += 1; return []; },
  });
  for (const input of [accessor, proxy]) {
    await assert.rejects(h.service.getDraft(input), {
      code: "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID", status: 400,
    });
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyTraps, 0);
  assert.equal(h.calls.verify, 0);
  assert.equal(h.calls.persist, 0);
  assert.equal(h.calls.commit, 0);
});

test("malformed same-account read rows fail as a closed server data boundary", async () => {
  const h = harness({ currentDraft: draft({ databaseOnlySecret: "must-not-leak" }) });
  await assert.rejects(h.service.getDraft({ actor: ACTOR, draftId: "draft-a" }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", status: 500,
  });
});

test("repository result DTOs are exact descriptor-safe server boundaries", async () => {
  const extra = harness({ repositoryTransform(method, value) {
    return method === "getAccountPolicy" ? { ...value, databaseOnlySecret: "must-not-leak" } : value;
  } });
  await assert.rejects(extra.service.getSettings({ actor: ACTOR }), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", status: 500,
  });

  let getterReads = 0;
  const accessor = harness({ repositoryTransform(method, value) {
    if (method !== "startSamplingSession") return value;
    const hostile = { ...value };
    Object.defineProperty(hostile, "expiresAt", { enumerable: true, get() {
      getterReads += 1;
      return value.expiresAt;
    } });
    return hostile;
  } });
  await assert.rejects(accessor.service.startSamplingSession({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    idempotencyKey: "session-hostile", correlationId: "correlation-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", status: 500 });
  assert.equal(getterReads, 0);
  assert.equal(accessor.calls.handoff, 0);
});

test("analysis, edit, and sample removal are closed zero-side-effect boundaries before their repositories exist", async () => {
  const h = harness();
  await assert.rejects(h.service.createAnalysisAttempt({
    actor: ACTOR, draftId: "draft-a", costConfirmed: true,
    idempotencyKey: "analysis-a", correlationId: "correlation-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY", status: 409 });
  await assert.rejects(h.service.updateDraft({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1, patch: {},
    idempotencyKey: "edit-a", correlationId: "correlation-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_EDIT_NOT_READY", status: 409 });
  await assert.rejects(h.service.removeSample({
    actor: ACTOR, draftId: "draft-a", sampleId: "sample-a",
    expectedDraftVersion: 1, idempotencyKey: "remove-a", correlationId: "correlation-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_CHANGE_NOT_READY", status: 409 });
  assert.deepEqual(h.calls, { read: 0, verify: 0, persist: 0, commit: 0, policy: 0,
    handoff: 0, publish: 0, rollback: 0 });
});

test("every service write rejects an ordinary user before repository, storage, verification, or publication", async () => {
  const h = harness();
  const user = { id: "account-a", role: "user" };
  const writes = [
    ["updateSettings", { actor: user, expectedVersion: 1, mode: "REQUIRE_EXACT_STRATEGY",
      idempotencyKey: "p", correlationId: "c" }],
    ["createDraft", { actor: user, scope: { taxonomyScope: "OZON:DEFAULT",
      descriptionCategoryId: 1, typeId: 2 }, sourceCollectItemId: "collect-a",
      expectedSourceVersion: "draft:1", idempotencyKey: "d", correlationId: "c" }],
    ["startSamplingSession", { actor: user, draftId: "draft-a", expectedDraftVersion: 1,
      idempotencyKey: "s", correlationId: "c" }],
    ["confirmSampleSet", { actor: user, draftId: "draft-a", expectedDraftVersion: 1,
      sessionId: "session-a", sessionSecret: "secret-value-at-least-32-characters",
      samples: selectedSamples(), idempotencyKey: "ss", correlationId: "c" }],
    ["removeSample", { actor: user, draftId: "draft-a", sampleId: "sample-a",
      expectedDraftVersion: 1, idempotencyKey: "r", correlationId: "c" }],
    ["createAnalysisAttempt", { actor: user, draftId: "draft-a", costConfirmed: true,
      idempotencyKey: "a", correlationId: "c" }],
    ["updateDraft", { actor: user, draftId: "draft-a", expectedDraftVersion: 1,
      patch: {}, idempotencyKey: "e", correlationId: "c" }],
    ["publishDraft", { actor: user, draftId: "draft-a", expectedDraftVersion: 1,
      expectedPublishedStrategyVersionId: "v1", idempotencyKey: "pub", correlationId: "c" }],
    ["rollbackDraft", { actor: user, draftId: "draft-a", targetStrategyVersionId: "v1",
      expectedPublishedStrategyVersionId: "v2", idempotencyKey: "rb", correlationId: "c" }],
  ];
  for (const [method, input] of writes) {
    await assert.rejects(h.service[method](input), { code: "PERMISSION_FORBIDDEN", status: 403 });
  }
  assert.deepEqual(h.calls, { read: 0, verify: 0, persist: 0, commit: 0, policy: 0,
    handoff: 0, publish: 0, rollback: 0 });
});

test("publication and rollback expose only the closed immutable strategy summary", async () => {
  const h = harness();
  assert.deepEqual(await h.service.publishDraft({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    expectedPublishedStrategyVersionId: "strategy-v1",
    idempotencyKey: "publish-a", correlationId: "correlation-a",
  }), { id: "strategy-v2", strategyKey: "default", version: 2, status: "PUBLISHED", duplicate: false });
  assert.deepEqual(await h.service.rollbackDraft({
    actor: ACTOR, draftId: "draft-a", targetStrategyVersionId: "strategy-v1",
    expectedPublishedStrategyVersionId: "strategy-v2",
    idempotencyKey: "rollback-a", correlationId: "correlation-a",
  }), { id: "strategy-v3", strategyKey: "default", version: 3, status: "PUBLISHED", duplicate: false });
  assert.equal(h.calls.publish, 1);
  assert.equal(h.calls.rollback, 1);

  const hostile = harness({ publicationExtra: true });
  await assert.rejects(hostile.service.publishDraft({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    expectedPublishedStrategyVersionId: "strategy-v1",
    idempotencyKey: "publish-extra", correlationId: "correlation-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", status: 500 });

  for (const publicationOverrides of [{ status: "RETIRED" }, { duplicate: "yes" }]) {
    const malformed = harness({ publicationOverrides });
    await assert.rejects(malformed.service.publishDraft({
      actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
      expectedPublishedStrategyVersionId: "strategy-v1",
      idempotencyKey: `publish-malformed-${String(publicationOverrides.status || publicationOverrides.duplicate)}`,
      correlationId: "correlation-a",
    }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", status: 500 });
  }
});

test("publication delegates rollout gating to the atomic publication transaction and preserves READ_ONLY", async () => {
  const readOnly = Object.assign(new Error("internal setting detail"), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", status: 409,
  });
  const h = harness({ policyMode: "LEGACY_FALLBACK", publicationFailure: readOnly });
  await assert.rejects(h.service.publishDraft({
    actor: ACTOR, draftId: "draft-a", expectedDraftVersion: 1,
    expectedPublishedStrategyVersionId: "strategy-v1",
    idempotencyKey: "disabled-publish", correlationId: "correlation-a",
  }), { code: readOnly.code, status: 409 });
  assert.equal(h.calls.publish, 1);
});
