import assert from "node:assert/strict";
import test from "node:test";
import { createJsonCollectCategoryResolutionRepository } from "../collect-category-resolution-repository.mjs";
import { createJsonStateTransactionBoundary } from "../json-state-transaction.mjs";
import { createCollectCategoryResolutionService } from "../collect-category-resolution-service.mjs";

const ACCOUNT_ID = "account-a";
const COLLECT_ITEM_ID = "collect-a";
const SCOPE = "OZON:DEFAULT";
const START = "2026-08-03T10:00:00.000Z";

function categoryTree({ label = "杯子", duplicate = false, typeId = 94405 } = {}) {
  const leaf = { type_id: typeId, type_name: label, children: [] };
  return [{
    description_category_id: 17028702,
    category_name: label === "Кружки" ? "Дом" : "家居",
    children: duplicate
      ? [leaf, { ...leaf, description_category_id: 17029999 }]
      : [leaf],
  }];
}

function createHarness({
  itemOverrides = {},
  stores: requestedStores,
  snapshot,
  snapshotError = null,
  validation,
  validationError = null,
  collectReadErrorAfter = Number.POSITIVE_INFINITY,
  storeReadErrorAfter = Number.POSITIVE_INFINITY,
  collectReadError = Object.assign(new Error("collect port unavailable"), { status: 503 }),
  storeReadError = Object.assign(new Error("store port unavailable"), { status: 503 }),
  candidateTaxonomyScope = SCOPE,
  state: existingState,
  repository: existingRepository,
  now: initialNow = START,
  additionalItems = [],
} = {}) {
  let nowMs = Date.parse(initialNow);
  let uuidSequence = 0;
  let collectReadCount = 0;
  let storeReadCount = 0;
  const item = {
    id: COLLECT_ITEM_ID,
    accountId: ACCOUNT_ID,
    collectionStatus: "SUCCESS",
    enrichmentComplete: true,
    sourceCategory: {
      descriptionCategoryId: 17033604,
      typeIdCandidate: 94405,
      typeName: "杯子",
      path: ["旧家居", "旧杯子"],
    },
    ...structuredClone(itemOverrides),
  };
  const stores = requestedStores ?? [
    { id: "store-a", ownerAccountId: ACCOUNT_ID, status: "ACTIVE", clientId: "client-a", apiKey: "secret-a" },
    { id: "store-b", ownerAccountId: ACCOUNT_ID, status: "ACTIVE", clientId: "client-b", apiKey: "secret-b" },
    { id: "foreign-store", ownerAccountId: "account-b", status: "ACTIVE", clientId: "client-x", apiKey: "secret-x" },
  ];
  const items = [item, ...structuredClone(additionalItems)];
  const state = existingState ?? {
    caches: { collectBox: items.map(({ id, accountId }) => ({ id, accountId })) },
    stores: stores.map(({ id, ownerAccountId }) => ({ id, ownerAccountId })),
    collectCategoryResolutions: [],
  };
  const calls = { snapshots: [], validations: [], audits: [], storeReads: [] };
  const repository = existingRepository ?? createJsonCollectCategoryResolutionRepository({
    state,
    stateTransaction: createJsonStateTransactionBoundary(),
    auditWriter: async ({ event }) => { calls.audits.push(structuredClone(event)); },
  });
  const categoryPort = {
    async getCategorySnapshot(input) {
      calls.snapshots.push({ accountId: input.accountId, storeId: input.store?.id });
      if (snapshotError) throw snapshotError;
      const resolvedSnapshot = typeof snapshot === "function"
        ? await snapshot(input, calls.snapshots.length)
        : snapshot;
      return structuredClone(resolvedSnapshot ?? {
        items: categoryTree(),
        taxonomyScope: SCOPE,
        taxonomyFingerprint: "taxonomy-v1",
        fetchedAt: START,
        stale: false,
      });
    },
    async validateTarget(input, target) {
      calls.validations.push({
        accountId: input.accountId,
        storeId: input.store?.id,
        target: structuredClone(target),
      });
      if (validationError) throw validationError;
      const result = typeof validation === "function"
        ? await validation(input, target)
        : validation;
      return structuredClone(result ?? {
        valid: true,
        reasonCode: "VALID",
        taxonomyFingerprint: "taxonomy-v1",
        validatedAt: new Date(nowMs).toISOString(),
      });
    },
  };
  const collectItemPort = {
    async read({ accountId, collectItemId }) {
      collectReadCount += 1;
      if (collectReadCount > collectReadErrorAfter) throw collectReadError;
      const found = items.find((candidate) => candidate.accountId === accountId && candidate.id === collectItemId);
      return found
        ? structuredClone(found)
        : null;
    },
    async listForCategoryResolution({ accountId }) {
      return items
        .filter((candidate) => candidate.accountId === accountId)
        .map((candidate) => ({ collectItemId: candidate.id, taxonomyScope: candidateTaxonomyScope }));
    },
  };
  const storePort = {
    async readCredentialStore({ accountId, storeId }) {
      storeReadCount += 1;
      calls.storeReads.push({ accountId, storeId });
      if (storeReadCount > storeReadErrorAfter) throw storeReadError;
      const store = stores.find((candidate) => candidate.id === storeId);
      return store ? structuredClone(store) : null;
    },
  };
  const auditPort = {
    prepare(event) {
      return structuredClone(event);
    },
  };
  const service = createCollectCategoryResolutionService({
    repository,
    categoryPort,
    collectItemPort,
    storePort,
    auditPort,
    now: () => new Date(nowMs),
    randomUUID: () => `lease-${++uuidSequence}`,
  });
  return {
    service,
    repository,
    state,
    item,
    items,
    calls,
    setNow(value) { nowMs = Date.parse(value); },
    advance(milliseconds) { nowMs += milliseconds; },
  };
}

async function readResolution(harness, collectItemId = COLLECT_ITEM_ID) {
  return harness.repository.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId,
    taxonomyScope: SCOPE,
  });
}

async function resolveUntilSettled(harness, maxAttempts = 4) {
  let result = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    result = await harness.service.resolveNext({ accountId: ACCOUNT_ID });
    if (!result || result.status !== "QUEUED") return result;
  }
  return result;
}

test("incomplete source evidence waits for enrichment without an Ozon call", async () => {
  const harness = createHarness({ itemOverrides: { enrichmentComplete: false } });

  const result = await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  assert.equal(result.status, "WAITING_ENRICHMENT");
  assert.equal(harness.calls.snapshots.length, 0);
  assert.equal(harness.item.collectionStatus, "SUCCESS");
});

test("a completed collection without a credentialed store waits without changing collection success", async () => {
  const harness = createHarness();

  const result = await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "missing-store",
  });

  assert.equal(result.status, "WAITING_STORE");
  assert.equal(result.credentialStoreId, null);
  assert.equal(harness.item.collectionStatus, "SUCCESS");
  assert.equal(harness.calls.snapshots.length, 0);
});

test("source 17033604 / 94405 resolves only by the unique type ID to 17028702 / 94405", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  const result = await resolveUntilSettled(harness);

  assert.deepEqual({
    status: result.status,
    method: result.method,
    sourceTypeId: result.sourceTypeId,
    targetDescriptionCategoryId: result.targetDescriptionCategoryId,
    targetTypeId: result.targetTypeId,
  }, {
    status: "MATCHED",
    method: "TYPE_ID_EXACT",
    sourceTypeId: 94405,
    targetDescriptionCategoryId: 17028702,
    targetTypeId: 94405,
  });
  assert.equal(harness.item.sourceCategory.descriptionCategoryId, 17033604);
  assert.equal(harness.calls.snapshots.length, 2);
  assert.equal(harness.state.collectCategoryResolutions.length, 1);
  assert.equal(harness.calls.audits.some((event) => event.action === "COLLECT_CATEGORY_RESOLUTION_MATCHED"), true);
});

test("execution refreshes the queued source type from the latest collected evidence", async () => {
  const harness = createHarness({
    snapshot: {
      items: categoryTree({ typeId: 94406 }),
      taxonomyScope: SCOPE,
      taxonomyFingerprint: "taxonomy-v1",
      fetchedAt: START,
      stale: false,
    },
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    taxonomyFingerprint: "taxonomy-v1",
  });
  harness.item.sourceCategory.typeIdCandidate = 94406;

  const result = await resolveUntilSettled(harness);

  assert.equal(result.status, "MATCHED");
  assert.equal(result.sourceTypeId, 94406);
  assert.equal(result.targetTypeId, 94406);
  assert.equal(harness.state.collectCategoryResolutions.length, 1);
});

test("fingerprint refresh never completes a different account task with the first item's evidence", async () => {
  const otherCollectItemId = "collect-b";
  const harness = createHarness({
    additionalItems: [{
      id: otherCollectItemId,
      accountId: ACCOUNT_ID,
      collectionStatus: "SUCCESS",
      enrichmentComplete: true,
      sourceCategory: { descriptionCategoryId: 17030000, typeIdCandidate: 12345 },
    }],
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  harness.advance(1);
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: otherCollectItemId,
    credentialStoreId: "store-a",
    taxonomyFingerprint: "taxonomy-v1",
  });
  harness.advance(1);

  await harness.service.resolveNext({ accountId: ACCOUNT_ID });

  const other = await readResolution(harness, otherCollectItemId);
  assert.equal(other.status, "QUEUED");
  assert.equal(other.attemptCount, 0);
  assert.equal(other.targetTypeId, null);
  assert.equal(other.sourceTypeId, 12345);
});

test("different Chinese and Russian labels share a structural result and store B only validates the target", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await resolveUntilSettled(harness);
  const snapshotCallsAfterMatch = harness.calls.snapshots.length;

  const result = await harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });

  assert.equal(result.reused, true);
  assert.equal(result.resolution.targetDescriptionCategoryId, 17028702);
  assert.equal(harness.calls.validations.length, 1);
  assert.equal(harness.calls.validations[0].storeId, "store-b");
  assert.deepEqual(harness.calls.validations[0].target, {
    descriptionCategoryId: 17028702,
    typeId: 94405,
  });
  assert.equal(harness.calls.snapshots.length, snapshotCallsAfterMatch);
  assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_VALIDATED");
});

for (const [name, validation, expectedCode] of [
  ["fingerprint change", { valid: true, reasonCode: "VALID", taxonomyFingerprint: "taxonomy-v2", validatedAt: START }, "TAXONOMY_CHANGED"],
  ["target validation failure", { valid: false, reasonCode: "TYPE_DISABLED", taxonomyFingerprint: "taxonomy-v1", validatedAt: START }, "TYPE_DISABLED"],
]) {
  test(`${name} records invalidation before requeueing the existing result`, async () => {
    const harness = createHarness({ validation });
    await harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId: "store-a",
    });
    await resolveUntilSettled(harness);

    const result = await harness.service.validateForStore({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      storeId: "store-b",
    });

    assert.equal(result.reused, false);
    assert.equal(result.resolution.status, "QUEUED");
    assert.equal(harness.state.collectCategoryResolutions.length, 1);
    assert.deepEqual(harness.calls.audits.slice(-2).map((event) => [event.action, event.failureCode ?? null]), [
      ["COLLECT_CATEGORY_RESOLUTION_INVALIDATED", expectedCode],
      ["COLLECT_CATEGORY_RESOLUTION_QUEUED", null],
    ]);
  });
}

test("explicit transient failures use bounded exponential retry and never audit raw upstream details", async () => {
  const secret = "token=must-not-leak";
  const harness = createHarness({
    snapshotError: Object.assign(new Error(secret), { code: "HTTP_503" }),
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  const first = await harness.service.resolveNext({ accountId: ACCOUNT_ID });
  assert.equal(first.status, "RETRYABLE_ERROR");
  assert.equal(first.failureCode, "HTTP_503");
  assert.equal(first.attemptCount, 1);
  assert.equal(first.nextAttemptAt, "2026-08-03T10:00:30.000Z");
  assert.equal(JSON.stringify({ record: first, audits: harness.calls.audits }).includes(secret), false);

  harness.setNow(first.nextAttemptAt);
  const second = await harness.service.resolveNext({ accountId: ACCOUNT_ID });
  assert.equal(second.attemptCount, 2);
  assert.equal(second.nextAttemptAt, "2026-08-03T10:01:30.000Z");

  let current = second;
  for (let attempt = 3; attempt <= 8; attempt += 1) {
    harness.setNow(current.nextAttemptAt);
    current = await harness.service.resolveNext({ accountId: ACCOUNT_ID });
  }
  assert.equal(Date.parse(current.nextAttemptAt) - Date.parse(current.updatedAt), 30 * 60 * 1000);
});

for (const code of [
  "NETWORK_ERROR",
  "TIMEOUT",
  "HTTP_429",
  "HTTP_500",
  "OZON_RATE_LIMITED",
  "OZON_CATEGORY_TREE_UNAVAILABLE",
  "OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE",
]) {
  test(`${code} is retryable by explicit stable code`, async () => {
    const harness = createHarness({ snapshotError: Object.assign(new Error("unsafe"), { code }) });
    await harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId: "store-a",
    });
    assert.equal((await harness.service.resolveNext({ accountId: ACCOUNT_ID })).status, "RETRYABLE_ERROR");
  });
}

for (const [name, itemOverrides, snapshot, expectedCode] of [
  ["missing source type", { sourceCategory: { descriptionCategoryId: 17033604 } }, undefined, "TYPE_MISSING"],
  ["source type not found", {}, { items: categoryTree({ typeId: 12345 }), taxonomyScope: SCOPE, taxonomyFingerprint: "taxonomy-v1", fetchedAt: START, stale: false }, "TYPE_NOT_FOUND"],
  ["ambiguous source type", {}, { items: categoryTree({ duplicate: true }), taxonomyScope: SCOPE, taxonomyFingerprint: "taxonomy-v1", fetchedAt: START, stale: false }, "TYPE_AMBIGUOUS"],
]) {
  test(`${name} needs review instead of retrying`, async () => {
    const harness = createHarness({ itemOverrides, snapshot });
    await harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId: "store-a",
    });
    const result = await resolveUntilSettled(harness);
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.failureCode, expectedCode);
    assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW");
  });
}

test("duplicate scheduling, completion notification, execution, and service restart keep one task", async () => {
  const harness = createHarness({ itemOverrides: { enrichmentComplete: false } });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  harness.item.enrichmentComplete = true;
  await harness.service.onEnrichmentComplete({ accountId: ACCOUNT_ID, collectItemId: COLLECT_ITEM_ID });
  await harness.service.onEnrichmentComplete({ accountId: ACCOUNT_ID, collectItemId: COLLECT_ITEM_ID });
  await resolveUntilSettled(harness);
  assert.equal(await harness.service.resolveNext({ accountId: ACCOUNT_ID }), null);

  const restarted = createHarness({ state: harness.state, repository: harness.repository });
  restarted.item.enrichmentComplete = true;
  await restarted.service.onEnrichmentComplete({ accountId: ACCOUNT_ID, collectItemId: COLLECT_ITEM_ID });
  assert.equal(await restarted.service.resolveNext({ accountId: ACCOUNT_ID }), null);
  assert.equal(harness.state.collectCategoryResolutions.length, 1);
  assert.equal((await readResolution(restarted)).status, "MATCHED");
});

test("replaying collection scheduling preserves an unchanged automatic match", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await resolveUntilSettled(harness);
  const before = await readResolution(harness);
  const auditCount = harness.calls.audits.length;

  const replay = await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  assert.equal(replay.status, "MATCHED");
  assert.equal(replay.method, "TYPE_ID_EXACT");
  assert.equal(replay.targetDescriptionCategoryId, 17028702);
  assert.equal(replay.targetTypeId, 94405);
  assert.equal(replay.taxonomyFingerprint, "taxonomy-v1");
  assert.equal(replay.updatedAt, before.updatedAt);
  assert.equal(harness.calls.audits.length, auditCount);
});

test("a changed source execution identity explicitly requeues an automatic match", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await resolveUntilSettled(harness);
  harness.item.sourceCategory.typeIdCandidate = 95555;

  const replay = await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  assert.equal(replay.status, "QUEUED");
  assert.equal(replay.sourceTypeId, 95555);
  assert.equal(replay.taxonomyFingerprint, null);
  assert.equal(replay.targetDescriptionCategoryId, null);
  assert.equal(replay.targetTypeId, null);
});

test("valid manual results survive automatic scheduling and stale worker completion", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await harness.service.saveManual({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    targetDescriptionCategoryId: 17029999,
    targetTypeId: 94405,
    taxonomyFingerprint: "taxonomy-v1",
    displayPath: { zh: ["人工类目"] },
  });
  const auditCount = harness.calls.audits.length;

  const replay = await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  assert.equal(replay.method, "MANUAL");
  assert.equal(replay.targetDescriptionCategoryId, 17029999);
  assert.equal(harness.calls.audits.length, auditCount);

  await harness.service.onEnrichmentComplete({ accountId: ACCOUNT_ID, collectItemId: COLLECT_ITEM_ID });
  assert.equal(await harness.service.resolveNext({ accountId: ACCOUNT_ID }), null);
  const result = await readResolution(harness);
  assert.equal(result.method, "MANUAL");
  assert.equal(result.targetDescriptionCategoryId, 17029999);
});

test("successful validation with a changed fingerprint preserves and refreshes a manual result", async () => {
  const harness = createHarness({
    validation: {
      valid: true,
      reasonCode: "VALID",
      taxonomyFingerprint: "taxonomy-v2",
      validatedAt: "2026-08-03T10:05:00.000Z",
    },
  });
  await harness.service.saveManual({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    targetDescriptionCategoryId: 17029999,
    targetTypeId: 94405,
    taxonomyFingerprint: "taxonomy-v1",
  });

  const result = await harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });

  assert.equal(result.reused, true);
  assert.equal(result.resolution.status, "MATCHED");
  assert.equal(result.resolution.method, "MANUAL");
  assert.equal(result.resolution.targetDescriptionCategoryId, 17029999);
  assert.equal(result.resolution.taxonomyFingerprint, "taxonomy-v2");
});

test("transient manual validation unavailability persists retry metadata without invalidating the target", async () => {
  const harness = createHarness({
    validation: {
      valid: false,
      reasonCode: "TAXONOMY_UNAVAILABLE",
      taxonomyFingerprint: null,
      validatedAt: START,
    },
  });
  await harness.service.saveManual({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    targetDescriptionCategoryId: 17029999,
    targetTypeId: 94405,
    taxonomyFingerprint: "taxonomy-v1",
  });

  await harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });

  const persisted = await readResolution(harness);
  assert.equal(persisted.status, "MATCHED");
  assert.equal(persisted.method, "MANUAL");
  assert.equal(persisted.targetDescriptionCategoryId, 17029999);
  assert.equal(persisted.credentialStoreId, "store-b");
  assert.equal(persisted.failureCode, "TAXONOMY_UNAVAILABLE");
  assert.equal(Date.parse(persisted.nextAttemptAt) > Date.parse(START), true);
  assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED");
});

test("a held stale automatic validation cannot invalidate a newly saved manual resolution", async () => {
  let releaseValidation;
  let markValidationStarted;
  const validationStarted = new Promise((resolve) => { markValidationStarted = resolve; });
  const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
  const harness = createHarness({
    validation: async () => {
      markValidationStarted();
      await validationGate;
      return {
        valid: false,
        reasonCode: "TYPE_DISABLED",
        taxonomyFingerprint: "taxonomy-v1",
        validatedAt: START,
      };
    },
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await resolveUntilSettled(harness);

  const staleValidation = harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });
  await validationStarted;
  harness.advance(1000);
  const manual = await harness.service.saveManual({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    targetDescriptionCategoryId: 17029999,
    targetTypeId: 95555,
    taxonomyFingerprint: "taxonomy-v2",
    displayPath: { zh: ["新人工类目"] },
  });
  const auditCountAfterManual = harness.calls.audits.length;
  releaseValidation();
  await staleValidation;

  const persisted = await readResolution(harness);
  assert.equal(persisted.status, "MATCHED");
  assert.equal(persisted.method, "MANUAL");
  assert.equal(persisted.targetDescriptionCategoryId, 17029999);
  assert.equal(persisted.targetTypeId, 95555);
  assert.equal(persisted.taxonomyFingerprint, "taxonomy-v2");
  assert.equal(persisted.matchedAt, manual.matchedAt);
  assert.equal(harness.calls.audits.length, auditCountAfterManual);
});

test("a thrown status-only validation outage is persisted for restart-safe retry", async () => {
  const harness = createHarness({
    validationError: Object.assign(new Error("raw validation outage"), { status: 503 }),
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await resolveUntilSettled(harness);

  await harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });

  const persisted = await readResolution(harness);
  assert.equal(persisted.status, "MATCHED");
  assert.equal(persisted.targetTypeId, 94405);
  assert.equal(persisted.credentialStoreId, "store-b");
  assert.equal(persisted.failureCode, "HTTP_503");
  assert.equal(Date.parse(persisted.nextAttemptAt) > Date.parse(START), true);
  assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED");
});

test("a due manual validation retry resumes after service recreation without automatic rematching", async () => {
  const harness = createHarness({
    validationError: Object.assign(new Error("validation unavailable"), { status: 503 }),
  });
  await harness.service.saveManual({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    targetDescriptionCategoryId: 17029999,
    targetTypeId: 94405,
    taxonomyFingerprint: "taxonomy-v1",
  });
  await harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });
  const deferred = await readResolution(harness);
  assert.equal(deferred.status, "MATCHED");
  assert.equal(deferred.failureCode, "HTTP_503");

  const restarted = createHarness({
    state: harness.state,
    repository: harness.repository,
    now: deferred.nextAttemptAt,
  });
  const result = await restarted.service.resolveNext({ accountId: ACCOUNT_ID });

  assert.equal(result.status, "MATCHED");
  assert.equal(result.method, "MANUAL");
  assert.equal(result.targetDescriptionCategoryId, 17029999);
  assert.equal(result.targetTypeId, 94405);
  assert.equal(result.failureCode, null);
  assert.equal(result.leaseToken, null);
  assert.equal(restarted.calls.snapshots.length, 0);
  assert.equal(restarted.calls.validations.length, 1);
  assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_VALIDATED");
});

test("repeated validation failures increment once per execution and keep backoff audit and state aligned", async () => {
  const validationError = Object.assign(new Error("validation unavailable"), { status: 503 });
  const harness = createHarness({ validationError });
  await harness.service.saveManual({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
    targetDescriptionCategoryId: 17029999,
    targetTypeId: 94405,
    taxonomyFingerprint: "taxonomy-v1",
  });

  await harness.service.validateForStore({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    storeId: "store-b",
  });
  const first = await readResolution(harness);
  assert.equal(first.attemptCount, 1);
  assert.equal(first.nextAttemptAt, "2026-08-03T10:00:30.000Z");
  assert.equal(harness.calls.audits.at(-1).attempt, 1);

  const restarted = createHarness({
    state: harness.state,
    repository: harness.repository,
    now: first.nextAttemptAt,
    validationError,
  });
  await restarted.service.resolveNext({ accountId: ACCOUNT_ID });
  const second = await readResolution(restarted);
  assert.equal(second.attemptCount, 2);
  assert.equal(second.nextAttemptAt, "2026-08-03T10:01:30.000Z");
  assert.equal(harness.calls.audits.at(-1).attempt, 2);
  assert.equal(second.status, "MATCHED");
  assert.equal(second.method, "MANUAL");
  assert.equal(second.targetDescriptionCategoryId, 17029999);
  assert.equal(second.targetTypeId, 94405);

  const restartedAgain = createHarness({
    state: harness.state,
    repository: harness.repository,
    now: second.nextAttemptAt,
    validationError,
  });
  await restartedAgain.service.resolveNext({ accountId: ACCOUNT_ID });
  const third = await readResolution(restartedAgain);
  assert.equal(third.attemptCount, 3);
  assert.equal(third.nextAttemptAt, "2026-08-03T10:03:30.000Z");
  assert.equal(harness.calls.audits.at(-1).attempt, 3);
  assert.equal(third.method, "MANUAL");
  assert.equal(third.targetDescriptionCategoryId, 17029999);
  assert.equal(third.targetTypeId, 94405);
});

for (const [name, snapshotError, expectedStatus] of [
  ["status-only 429", Object.assign(new Error("rate limited"), { status: 429 }), "RETRYABLE_ERROR"],
  ["status-only 503", Object.assign(new Error("unavailable"), { status: 503 }), "RETRYABLE_ERROR"],
  ["request timeout 408", Object.assign(new Error("timeout"), { status: 408 }), "RETRYABLE_ERROR"],
  ["data contract error", Object.assign(new Error("invalid tree"), { code: "OZON_CATEGORY_DATA_INVALID", status: 422 }), "NEEDS_REVIEW"],
  ["stale taxonomy without transport failure", Object.assign(new Error("stale"), { code: "OZON_CATEGORY_TAXONOMY_STALE", status: 409 }), "RETRYABLE_ERROR"],
  ["data contract error carrying a 503", Object.assign(new Error("invalid tree"), { code: "OZON_CATEGORY_DATA_INVALID", status: 503 }), "NEEDS_REVIEW"],
  ["stale taxonomy carrying a 503", Object.assign(new Error("stale"), { code: "OZON_CATEGORY_TAXONOMY_STALE", status: 503 }), "RETRYABLE_ERROR"],
  ["numeric status 600", Object.assign(new Error("not an HTTP server error"), { status: 600 }), "NEEDS_REVIEW"],
  ["numeric status 999", Object.assign(new Error("not an HTTP server error"), { status: 999 }), "NEEDS_REVIEW"],
]) {
  test(`${name} follows the numeric transport retry boundary`, async () => {
    const harness = createHarness({ snapshotError });
    await harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId: "store-a",
    });
    assert.equal((await harness.service.resolveNext({ accountId: ACCOUNT_ID })).status, expectedStatus);
  });
}

test("a stale last-known-good snapshot retries and later resolves without losing source evidence", async () => {
  let stale = true;
  const harness = createHarness({
    snapshot: async () => ({
      items: categoryTree(),
      taxonomyScope: SCOPE,
      taxonomyFingerprint: "taxonomy-lkg-v1",
      fetchedAt: START,
      stale,
      staleReasonCode: stale ? "OZON_CATEGORY_TREE_UNAVAILABLE" : null,
    }),
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  const deferred = await harness.service.resolveNext({ accountId: ACCOUNT_ID });
  assert.equal(deferred.status, "RETRYABLE_ERROR");
  assert.equal(deferred.failureCode, "OZON_CATEGORY_TREE_UNAVAILABLE");
  assert.equal(deferred.taxonomyFingerprint, "taxonomy-lkg-v1");
  assert.deepEqual(harness.item.sourceCategory, {
    descriptionCategoryId: 17033604,
    typeIdCandidate: 94405,
    typeName: "杯子",
    path: ["旧家居", "旧杯子"],
  });

  stale = false;
  harness.setNow(deferred.nextAttemptAt);
  const matched = await resolveUntilSettled(harness);
  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.targetDescriptionCategoryId, 17028702);
  assert.equal(matched.targetTypeId, 94405);
  assert.equal(matched.taxonomyFingerprint, "taxonomy-lkg-v1");
});

test("a stale last-known-good snapshot caused by invalid Ozon data requires review without retrying", async () => {
  const harness = createHarness({
    snapshot: async () => ({
      items: categoryTree(),
      taxonomyScope: SCOPE,
      taxonomyFingerprint: "taxonomy-invalid-lkg-v1",
      fetchedAt: START,
      stale: true,
      staleReasonCode: "OZON_CATEGORY_DATA_INVALID",
    }),
  });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  const reviewed = await harness.service.resolveNext({ accountId: ACCOUNT_ID });

  assert.equal(reviewed.status, "NEEDS_REVIEW");
  assert.equal(reviewed.failureCode, "OZON_CATEGORY_DATA_INVALID");
  assert.equal(reviewed.taxonomyFingerprint, "taxonomy-invalid-lkg-v1");
  assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW");
  assert.deepEqual(harness.item.sourceCategory, {
    descriptionCategoryId: 17033604,
    typeIdCandidate: 94405,
    typeName: "杯子",
    path: ["旧家居", "旧杯子"],
  });
  harness.setNow("2026-08-04T10:00:00.000Z");
  assert.equal(await harness.service.resolveNext({ accountId: ACCOUNT_ID }), null);
  assert.equal((await readResolution(harness)).attemptCount, 1);
});

test("a post-claim collect-item outage is persisted instead of leaving MATCHING until lease expiry", async () => {
  const harness = createHarness({ collectReadErrorAfter: 1 });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  await resolveUntilSettled(harness);

  const persisted = await readResolution(harness);
  assert.equal(persisted.status, "RETRYABLE_ERROR");
  assert.equal(persisted.failureCode, "HTTP_503");
  assert.equal(persisted.leaseToken, null);
});

test("a post-claim credential-store outage is retryable and observable", async () => {
  const harness = createHarness({ storeReadErrorAfter: 1 });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });

  const result = await harness.service.resolveNext({ accountId: ACCOUNT_ID });

  assert.equal(result.status, "RETRYABLE_ERROR");
  assert.equal(result.failureCode, "HTTP_503");
  assert.equal(harness.calls.audits.at(-1).action, "COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED");
});

for (const [name, stores, credentialStoreId] of [
  ["foreign", undefined, "foreign-store"],
  ["disabled", [{ id: "store-a", ownerAccountId: ACCOUNT_ID, status: "DISABLED", clientId: "client-a", apiKey: "secret-a" }], "store-a"],
  ["uncredentialed", [{ id: "store-a", ownerAccountId: ACCOUNT_ID, status: "ACTIVE", clientId: "client-a", apiKey: "" }], "store-a"],
]) {
  test(`${name} credential store is non-disclosing and moves work to WAITING_STORE`, async () => {
    const harness = createHarness({ stores });
    const result = await harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId,
    });
    assert.equal(result.status, "WAITING_STORE");
    assert.equal(result.credentialStoreId, null);
    assert.equal(harness.calls.snapshots.length, 0);
  });
}

test("a legacy credentialed store with no status remains available unless explicitly disabled", async () => {
  const harness = createHarness({
    stores: [{ id: "store-a", ownerAccountId: ACCOUNT_ID, clientId: "client-a", apiKey: "secret-a" }],
  });
  const result = await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  assert.equal(result.status, "QUEUED");
});

for (const [name, disabledFields] of [
  ["inactive status", { status: "INACTIVE" }],
  ["archived status", { status: "ARCHIVED" }],
  ["explicit disabled flag", { enabled: false }],
]) {
  test(`${name} keeps a credentialed store unavailable`, async () => {
    const harness = createHarness({
      stores: [{
        id: "store-a",
        ownerAccountId: ACCOUNT_ID,
        clientId: "client-a",
        apiKey: "secret-a",
        ...disabledFields,
      }],
    });
    const result = await harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId: "store-a",
    });
    assert.equal(result.status, "WAITING_STORE");
  });
}

test("an available operating store wakes only account-scoped waiting items", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: null,
  });

  const awakened = await harness.service.onOperatingStoreAvailable({
    accountId: ACCOUNT_ID,
    storeId: "store-a",
  });

  assert.equal(awakened.length, 1);
  assert.equal((await readResolution(harness)).status, "QUEUED");
});

test("operating-store wakeup surfaces a safe retryable store outage and leaves waiting work intact", async () => {
  const harness = createHarness({ storeReadErrorAfter: 0 });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: null,
  });

  await assert.rejects(
    harness.service.onOperatingStoreAvailable({
      accountId: ACCOUNT_ID,
      storeId: "store-a",
    }),
    (error) => error?.code === "HTTP_503"
      && error?.status === 503
      && !error?.message.includes("store port unavailable"),
  );
  assert.equal((await readResolution(harness)).status, "WAITING_STORE");
});

test("operating-store wakeup preserves each waiting record's taxonomy scope", async () => {
  const taxonomyScope = "OZON:RU";
  const harness = createHarness({ candidateTaxonomyScope: taxonomyScope });
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: null,
    taxonomyScope,
  });

  const awakened = await harness.service.onOperatingStoreAvailable({
    accountId: ACCOUNT_ID,
    storeId: "store-a",
  });

  assert.equal(awakened.length, 1);
  const persisted = await harness.repository.readForItem({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    taxonomyScope,
  });
  assert.equal(persisted.status, "QUEUED");
});

test("audit events contain stable resolution identifiers and never credentials or raw responses", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await resolveUntilSettled(harness);

  const allowed = new Set([
    "action", "accountId", "collectItemId", "taxonomyScope", "sourceTypeId",
    "targetDescriptionCategoryId", "targetTypeId", "credentialStoreId",
    "taxonomyFingerprint", "attempt", "failureCode",
  ]);
  for (const event of harness.calls.audits) {
    assert.deepEqual(Object.keys(event).filter((key) => !allowed.has(key)), []);
    assert.equal(JSON.stringify(event).includes("secret-a"), false);
    assert.equal("apiKey" in event, false);
    assert.equal("leaseToken" in event, false);
  }
});

test("a configured Service transition fails closed when its Repository has no transaction audit writer", async () => {
  const state = {
    caches: { collectBox: [{ id: COLLECT_ITEM_ID, accountId: ACCOUNT_ID }] },
    stores: [{ id: "store-a", ownerAccountId: ACCOUNT_ID }],
    collectCategoryResolutions: [],
  };
  const repository = createJsonCollectCategoryResolutionRepository({
    state,
    stateTransaction: createJsonStateTransactionBoundary(),
  });
  const harness = createHarness({ state, repository });

  await assert.rejects(
    harness.service.scheduleForCollect({
      accountId: ACCOUNT_ID,
      collectItemId: COLLECT_ITEM_ID,
      credentialStoreId: "store-a",
    }),
    (error) => error?.code === "COLLECT_CATEGORY_RESOLUTION_AUDIT_WRITER_REQUIRED",
  );
  assert.equal(await readResolution(harness), null);
});
