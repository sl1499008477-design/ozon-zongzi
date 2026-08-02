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
  state: existingState,
  repository: existingRepository,
  now: initialNow = START,
  additionalItems = [],
} = {}) {
  let nowMs = Date.parse(initialNow);
  let uuidSequence = 0;
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
  const repository = existingRepository ?? createJsonCollectCategoryResolutionRepository({
    state,
    stateTransaction: createJsonStateTransactionBoundary(),
  });
  const calls = { snapshots: [], validations: [], audits: [], storeReads: [] };
  const categoryPort = {
    async getCategorySnapshot(input) {
      calls.snapshots.push({ accountId: input.accountId, storeId: input.store?.id });
      if (snapshotError) throw snapshotError;
      return structuredClone(snapshot ?? {
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
      return structuredClone(validation ?? {
        valid: true,
        reasonCode: "VALID",
        taxonomyFingerprint: "taxonomy-v1",
        validatedAt: new Date(nowMs).toISOString(),
      });
    },
  };
  const collectItemPort = {
    async read({ accountId, collectItemId }) {
      const found = items.find((candidate) => candidate.accountId === accountId && candidate.id === collectItemId);
      return found
        ? structuredClone(found)
        : null;
    },
    async listForCategoryResolution({ accountId }) {
      return items
        .filter((candidate) => candidate.accountId === accountId)
        .map((candidate) => ({ collectItemId: candidate.id }));
    },
  };
  const storePort = {
    async readCredentialStore({ accountId, storeId }) {
      calls.storeReads.push({ accountId, storeId });
      const store = stores.find((candidate) => candidate.id === storeId);
      return store ? structuredClone(store) : null;
    },
  };
  const auditPort = {
    async append(event) {
      calls.audits.push(structuredClone(event));
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

  const result = await harness.service.resolveNext({ accountId: ACCOUNT_ID });

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
  assert.equal(harness.calls.snapshots.length, 1);
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

  const result = await harness.service.resolveNext({ accountId: ACCOUNT_ID });

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
  await harness.service.resolveNext({ accountId: ACCOUNT_ID });
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
    await harness.service.resolveNext({ accountId: ACCOUNT_ID });

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

for (const code of ["NETWORK_ERROR", "TIMEOUT", "HTTP_429", "HTTP_500"]) {
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
    const result = await harness.service.resolveNext({ accountId: ACCOUNT_ID });
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
  await harness.service.resolveNext({ accountId: ACCOUNT_ID });
  assert.equal(await harness.service.resolveNext({ accountId: ACCOUNT_ID }), null);

  const restarted = createHarness({ state: harness.state, repository: harness.repository });
  restarted.item.enrichmentComplete = true;
  await restarted.service.onEnrichmentComplete({ accountId: ACCOUNT_ID, collectItemId: COLLECT_ITEM_ID });
  assert.equal(await restarted.service.resolveNext({ accountId: ACCOUNT_ID }), null);
  assert.equal(harness.state.collectCategoryResolutions.length, 1);
  assert.equal((await readResolution(restarted)).status, "MATCHED");
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

  await harness.service.onEnrichmentComplete({ accountId: ACCOUNT_ID, collectItemId: COLLECT_ITEM_ID });
  assert.equal(await harness.service.resolveNext({ accountId: ACCOUNT_ID }), null);
  const result = await readResolution(harness);
  assert.equal(result.method, "MANUAL");
  assert.equal(result.targetDescriptionCategoryId, 17029999);
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

test("audit events contain stable resolution identifiers and never credentials or raw responses", async () => {
  const harness = createHarness();
  await harness.service.scheduleForCollect({
    accountId: ACCOUNT_ID,
    collectItemId: COLLECT_ITEM_ID,
    credentialStoreId: "store-a",
  });
  await harness.service.resolveNext({ accountId: ACCOUNT_ID });

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
