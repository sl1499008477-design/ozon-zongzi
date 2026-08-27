import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { buildAutoListingSubmissionDraft, freezeAutoListingListingBase } from "../auto-listing-overlay.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { createAutoListingUploadService } from "../auto-listing-upload-service.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const publishedPolicyDigest = (value) => crypto.createHash("sha256").update(JSON.stringify({
  origin: value.origin,
  baseUrl: value.baseUrl,
  prefix: value.prefix,
  publicationVersion: value.publicationVersion,
})).digest("hex");
const accountId = "account-a";
const actor = { id: accountId, role: "admin" };

function normalizedItem(offerId = "offer-1") {
  return {
    offer_id: offerId, name: `Name ${offerId}`, price: "100.00", currency_code: "RUB",
    description_category_id: 17028702, type_id: 92576, weight: 500, weight_unit: "g",
    depth: 200, width: 100, height: 50, dimension_unit: "mm",
    images: ["https://source.example/a.jpg"], primary_image: "https://source.example/a.jpg",
    attributes: [{ complex_id: 0, id: 85, values: [{ value: "Brand" }] }],
  };
}

function evidence() {
  const publicationPolicy = { origin: "https://cdn.example.com", baseUrl: "https://cdn.example.com/",
    prefix: "listing-media/v1", publicationVersion: "LISTING_MEDIA_V1" };
  const pricing = { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" };
  const base = freezeAutoListingListingBase({
    accountId, jobId: "job-1", itemId: "item-1", sourceSnapshotId: "snapshot-source-1",
    collectItemId: "collect-1", targetStoreId: "store-1",
    productDraft: { id: "draft-1", version: 4, dataHash: "a".repeat(64) },
    pricingEvidence: { ...pricing, evidenceHash: digest(pricing) },
    richContentAttributeSupported: true,
    variants: [{ sourceVariantId: "variant-1", sourceSku: "sku-1", item: normalizedItem() }],
    versions: { normalizerVersion: "v3", categoryRuleVersion: "cat-v1", dictionaryVersion: "dict-v1" },
  });
  const frozenConfig = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-1", targetWarehouseId: "warehouse-db-1", stock: 5,
    priceAdjustmentKopecks: "0",
    image: { ratio: "3:4", resolution: "1K", quality: "Medium", language: "ru",
      roles: { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 }, total: 6 },
  });
  const slots = [
    ["slot-main", "MAIN"], ["slot-selling-1", "SELLING_POINT"], ["slot-selling-2", "SELLING_POINT"],
    ["slot-detail", "DETAIL"], ["slot-scene", "SCENE"], ["slot-info", "INFOGRAPHIC"],
  ];
  const assets = slots.map(([slotKey, role], index) => ({
    accountId, jobId: "job-1", itemId: "item-1", planId: "plan-1", assetId: `asset-${index + 1}`,
    visualGroupKey: "group-1", slotKey, role, status: "ACCEPTED",
    contentHash: String(index + 1).repeat(64), width: 768, height: 1024,
  }));
  const rich = { version: "AUTO_LISTING_RICH_CONTENT_V1", language: "ru", blocks: [
    { type: "HERO_IMAGE", assetId: "asset-1" },
    { type: "HEADING", text: "Название", sourceFactIds: ["fact.a"], factBindings: [{ sourceFactId: "fact.a", field: "identity.name", value: "Название", numericValue: null, unit: null }] },
    { type: "TEXT", text: "Описание", sourceFactIds: ["fact.b"], factBindings: [{ sourceFactId: "fact.b", field: "identity.description", value: "Описание", numericValue: null, unit: null }] },
  ] };
  return {
    item: { accountId, jobId: "job-1", id: "item-1", sourceSnapshotId: "snapshot-source-1", status: "UPLOAD_QUEUED", statusVersion: 7,
      targetStoreId: "store-1", targetWarehouseId: "warehouse-db-1", activePlanId: "plan-1" },
    sourceHash: "b".repeat(64), listingBaseId: "base-1", listingBase: base,
    frozenConfig, effectiveFrozenConfig: frozenConfig,
    targetWarehousePlatformId: "warehouse-platform-1",
    warehouseFulfillmentType: "FBS",
    creationWarehouseValidation: null,
    visualGroups: { accountId, jobId: "job-1", itemId: "item-1", planId: "plan-1", groups: [
      { visualGroupKey: "group-1", variantIds: ["variant-1"], slots: slots.map(([slotKey, role], order) => ({ slotKey, role, order })) },
    ] },
    acceptedAssets: assets,
    acceptedRichContent: [{ accountId, jobId: "job-1", itemId: "item-1", planId: "plan-1",
      visualGroupKey: "group-1", status: "ACCEPTED", content: rich, outputHash: digest(rich) }],
    productDraft: { id: "draft-1", version: 4, dataHash: "a".repeat(64) },
    collectItem: { id: "collect-1", accountId, listingDraft: { variants: [{ sourceCategory: { descriptionCategoryId: 17028702 } }] } },
    store: { id: "store-1", ownerAccountId: accountId, credentialsUsable: true },
    warehouses: [{ id: "warehouse-db-1", warehouseId: "warehouse-platform-1", storeId: "store-1", accountId,
      warehouseType: "fbs", status: "active", isActive: true, isArchived: false, hasActiveProductAssociation: true }],
    products: [{ id: "product-1", accountId, storeId: "store-1", isArchived: false,
      warehouseStocks: [{ warehouseId: "warehouse-platform-1", source: "fbs" }] }],
    uploadPolicy: { id: "policy-1", accountId, version: 1, mode: "REVIEW", enabled: true,
      publishedBy: accountId, publishedAt: "2026-08-08T00:00:00.000Z",
      publicationPolicy, publicationPolicyHash: publishedPolicyDigest(publicationPolicy) },
  };
}

function rfbsValidation(overrides = {}) {
  const normalized = {
    schemaVersion: "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1",
    accountId,
    storeId: "store-1",
    warehouseRecordId: "warehouse-db-1",
    platformWarehouseId: "warehouse-platform-1",
    fulfillmentType: "RFBS",
    status: "ACTIVE",
    outcome: "PASSED",
    observedAt: "2026-08-11T00:00:00.000Z",
    expiresAt: "2099-08-11T00:10:00.000Z",
    correlationId: "corr-1",
    actorAccountId: accountId,
    ...overrides,
  };
  return { evidenceId: "rfbs-creation-evidence-1", ...normalized, evidenceHash: digest(Object.fromEntries(
    Object.entries(normalized).filter(([key]) => key !== "evidenceHash"),
  )) };
}

function harness(overrides = {}) {
  const state = { context: evidence(), link: null, calls: [], attempts: [], publishedAssets: [] };
  const repository = {
    async loadUploadEvidence(input) {
      state.calls.push(["load", input]);
      return structuredClone({ ...state.context,
        terminalPublishedAssets: state.publishedAssets,
        terminalSubmission: state.link && ["SUBMITTED", "RECONCILING", "SUCCEEDED"].includes(state.link.status)
          ? state.link : null });
    },
    async reserveSubmission(input) {
      state.calls.push(["reserve", input]);
      if (state.link) return structuredClone(state.link);
      state.link = { id: "link-1", status: "RESERVED", idempotencyKey: input.idempotencyKey,
        resultHash: input.resultHash, targetStoreId: input.targetStoreId,
        requestHash: input.requestHash, jobId: input.jobId, listingBaseId: input.listingBaseId,
        activePlanId: input.activePlanId, sourceHash: input.sourceHash, configHash: input.configHash,
        uploadPolicyVersionId: input.uploadPolicyVersionId,
        publicationPolicyHash: input.publicationPolicyHash, mediaEvidenceHash: input.mediaEvidenceHash,
        claimToken: "claim-1", claimOwned: true,
        warehouseValidationEvidenceId: input.warehouseValidation ? "rfbs-upload-evidence-1" : null,
        linkIdentityEvidenceId: input.warehouseValidation ? "rfbs-link-identity-evidence-1" : null,
        reservedAttemptId: input.warehouseValidation ? "rfbs-reserved-attempt-1" : null };
      return structuredClone(state.link);
    },
    async bindSubmission(input) {
      state.calls.push(["bind", input]);
      state.link = { ...state.link, status: "SUBMITTED", submissionJobId: input.submissionJobId,
        submissionSnapshotId: input.submissionSnapshotId };
      state.attempts.push(input.attempt);
      return structuredClone(state.link);
    },
    async recordAttempt(input) { state.calls.push(["attempt", input]); state.attempts.push(input); },
    async blockSubmission(input) {
      state.calls.push(["blocked", input]);
      state.attempts.push(input.attempt);
      state.link.status = "BLOCKED";
    },
    async releaseSubmissionForRetry(input) {
      state.calls.push(["released", input]);
      state.attempts.push(input.attempt);
      state.link.claimOwned = false;
    },
  };
  const deps = {
    repository,
    uploadEnabled: true,
    listingPipelineEnabled: true,
    publicationPolicy: { origin: "https://cdn.example.com", baseUrl: "https://cdn.example.com/",
      prefix: "listing-media/v1", publicationVersion: "LISTING_MEDIA_V1" },
    richContentPublicationPolicy: { origin: "https://cdn.example.com" },
    async publishListingAsset({ itemId, assetId }) {
      state.calls.push(["publish", { itemId, assetId }]);
      const asset = state.context.acceptedAssets.find((row) => row.assetId === assetId);
      const published = { ...asset, publishedUrl: `https://cdn.example.com/${assetId}.jpg`, contentHash: String(assetId.at(-1)).repeat(64),
        width: 768, height: 1024, publicationVersion: "LISTING_MEDIA_V1" };
      state.publishedAssets.push(published);
      return published;
    },
    async createSubmission(input) {
      state.calls.push(["submit", input]);
      return { duplicate: false, job: { id: "submission-job-1", snapshotId: "submission-snapshot-1", status: "QUEUE_PENDING" } };
    },
    async findSubmission() { return null; },
    async checkPublicationHealth(input) {
      state.calls.push(["health", input]);
      return { accountId: input.accountId, outcome: "PASSED", evidenceId: "health-evidence-current" };
    },
    async assertDirectSystemReady() { return { ready: true }; },
    async assertDirectReady() { return { ready: true, evidenceId: "health-evidence-1" }; },
    rfbsWarehouseVerifier: {
      async verifyRfbsWarehouse(input) {
        state.calls.push(["verify", input]);
        const { evidenceId: _creationOnly, ...fresh } = rfbsValidation({ correlationId: input.correlationId });
        return fresh;
      },
    },
    ...overrides,
  };
  return { state, repository, service: createAutoListingUploadService(deps) };
}

const request = (overrides = {}) => ({ actor, itemId: "item-1", expectedStatusVersion: 7, correlationId: "corr-1", ...overrides });

test("closed upload boundary requires TENANT_OPERATE and an exact request", async () => {
  const { service } = harness();
  await assert.rejects(service.submitAutoListingItem({ ...request(), extra: true }), { code: "AUTO_LISTING_UPLOAD_INVALID" });
  await assert.rejects(service.submitAutoListingItem(request({ actor: { role: "viewer" } })), { code: "PERMISSION_FORBIDDEN" });
});

test("disabled flags stop before evidence, publication, and standard submission", async () => {
  for (const flag of ["uploadEnabled", "listingPipelineEnabled"]) {
    const { service, state } = harness({ [flag]: false });
    await assert.rejects(service.submitAutoListingItem(request()), { code: "AUTO_LISTING_UPLOAD_DISABLED" });
    assert.deepEqual(state.calls, []);
  }
});

test("review upload publishes accepted assets and delegates only the typed overlay to standard pipeline", async () => {
  const { service, state } = harness();
  const result = await service.submitAutoListingItem(request());
  assert.deepEqual(result, { itemId: "item-1", status: "SUBMITTED", submissionJobId: "submission-job-1",
    submissionSnapshotId: "submission-snapshot-1", duplicate: false });
  const submission = state.calls.find(([kind]) => kind === "submit")[1];
  assert.equal(submission.type, "AUTO_LISTING");
  assert.equal(submission.accountId, accountId);
  assert.deepEqual(submission.collectItem, state.context.collectItem);
  assert.equal(submission.collectItem.listingDraft.richContent, undefined);
  assert.equal(submission.normalizedItems[0].images.length, 6);
  assert.equal(submission.normalizedItems[0].primary_image, "https://cdn.example.com/asset-1.jpg");
  assert.equal(submission.normalizedItems[0].attributes.some((attribute) => Number(attribute.id) === 11254), true);
  assert.equal(submission.stocks[0].warehouse_id, "warehouse-platform-1");
  assert.match(submission.idempotencyKey, /^auto-listing:item-1:[a-f0-9]{64}$/);
  assert.deepEqual(submission.versions, { categoryRuleVersion: "cat-v1", dictionaryVersion: "dict-v1",
    richContentRuleVersion: "AUTO_LISTING_OZON_RICH_CONTENT_V2" });
  assert.deepEqual(submission.frozenProductDraft, state.context.productDraft);
  assert.equal(state.calls.find(([kind]) => kind === "bind")[1].claimToken, "claim-1");
  assert.equal(state.attempts[0].outcome, "SUCCEEDED");
  assert.ok(state.calls.findIndex(([kind]) => kind === "health")
    < state.calls.findIndex(([kind]) => kind === "publish"));
});

test("review upload stops before publication when the public media endpoint is unavailable", async () => {
  const { service, state } = harness({
    async checkPublicationHealth(input) {
      state.calls.push(["health", input]);
      return { accountId: input.accountId, outcome: "FAILED", evidenceId: "health-evidence-failed" };
    },
  });

  await assert.rejects(service.submitAutoListingItem(request()), {
    code: "AUTO_LISTING_PUBLICATION_NOT_READY", retryable: true,
  });
  assert.equal(state.calls.some(([kind]) => ["publish", "reserve", "submit"].includes(kind)), false);
});

test("review upload accepts the exact policy hash emitted by the admin publication boundary", async () => {
  const { service, state } = harness();
  state.context.uploadPolicy.publicationPolicyHash = publishedPolicyDigest(
    state.context.uploadPolicy.publicationPolicy,
  );

  const result = await service.submitAutoListingItem(request());

  assert.equal(result.status, "SUBMITTED");
});

test("upload uses the frozen per-item image config when unavailable dimensions removed the size slot", async () => {
  const { service, state } = harness();
  state.context.frozenConfig = normalizeAndHashAutoListingConfig({
    ...state.context.frozenConfig.config,
    image: {
      ...state.context.frozenConfig.config.image,
      roles: { ...state.context.frozenConfig.config.image.roles, specification: 1 },
      total: state.context.frozenConfig.config.image.total + 1,
    },
  });

  const result = await service.submitAutoListingItem(request());

  assert.equal(result.status, "SUBMITTED");
  assert.equal(state.calls.find(([name]) => name === "reserve")[1].configHash,
    state.context.frozenConfig.configHash);
});

test("RFBS revalidates before publication and binds the reserved fresh evidence to the standard submission", async () => {
  const { service, state } = harness();
  state.context.warehouses[0].warehouseType = "RFBS";
  state.context.warehouses[0].hasActiveProductAssociation = false;
  state.context.products = [];
  state.context.warehouseFulfillmentType = "RFBS";
  state.context.creationWarehouseValidation = rfbsValidation({ correlationId: "job-corr" });
  const originalReserve = state.calls;

  await service.submitAutoListingItem(request());

  const transitions = [];
  for (const [name] of originalReserve) {
    const normalized = ({ load: "loadUploadEvidence", verify: "verifyRfbsWarehouse", publish: "publishListingAsset",
      reserve: "reserveSubmission", submit: "createSubmission", bind: "bindSubmissionResult" })[name];
    if (normalized && transitions.at(-1) !== normalized) transitions.push(normalized);
  }
  assert.deepEqual(transitions, ["loadUploadEvidence", "verifyRfbsWarehouse", "publishListingAsset",
    "reserveSubmission", "createSubmission", "bindSubmissionResult"]);
  const reserveInput = state.calls.find(([name]) => name === "reserve")[1];
  assert.equal(reserveInput.warehouseValidation.fulfillmentType, "RFBS");
  const createInput = state.calls.find(([name]) => name === "submit")[1];
  assert.equal(createInput.warehouseValidationEvidenceId, "rfbs-upload-evidence-1");
  assert.equal(createInput.warehouseFulfillmentType, "RFBS");
  assert.equal(createInput.rfbsHandoff.linkIdentityEvidenceId, "rfbs-link-identity-evidence-1");
  assert.equal(createInput.rfbsHandoff.attemptAuthorizationEvidenceId, "rfbs-upload-evidence-1");
  assert.equal(state.attempts[0].warehouseValidationEvidenceId, "rfbs-upload-evidence-1");
});

test("RFBS verifier failures and changed creation evidence stop before publication or submission writes", async () => {
  const cases = [
    { mutate() {}, error: Object.assign(new Error("expired"), { code: "RFBS_WAREHOUSE_EVIDENCE_EXPIRED" }) },
    { mutate(context) { context.warehouseFulfillmentType = "FBS"; },
      error: Object.assign(new Error("must not verify"), { code: "RFBS_WAREHOUSE_CHANGED" }) },
  ];
  for (const fixture of cases) {
    const { service, state } = harness({ rfbsWarehouseVerifier: {
      async verifyRfbsWarehouse() { throw fixture.error; },
    } });
    state.context.warehouses[0].warehouseType = "RFBS";
    state.context.warehouses[0].hasActiveProductAssociation = false;
    state.context.products = [];
    state.context.warehouseFulfillmentType = "RFBS";
    state.context.creationWarehouseValidation = rfbsValidation({ correlationId: "job-corr" });
    fixture.mutate(state.context);
    await assert.rejects(service.submitAutoListingItem(request()), { code: fixture.error.code });
    assert.equal(state.calls.some(([name]) => ["publish", "reserve", "submit", "bind"].includes(name)), false);
  }
});

test("FBS upload never invokes the RFBS verifier", async () => {
  let verifierCalls = 0;
  const { service } = harness({ rfbsWarehouseVerifier: {
    async verifyRfbsWarehouse() { verifierCalls += 1; throw new Error("must not verify FBS"); },
  } });
  await service.submitAutoListingItem(request());
  assert.equal(verifierCalls, 0);
});

test("an expired immutable reservation can resume after a crash without changing the queued generation", async () => {
  let createCalls = 0;
  const { service, state } = harness({
    async createSubmission(input) {
      createCalls += 1;
      return { duplicate: false, job: { id: "submission-job-resumed", snapshotId: "submission-snapshot-resumed",
        status: "QUEUE_PENDING" }, input };
    },
  });
  state.context.item.status = "UPLOADING";
  state.context.item.statusVersion = 8;
  const result = await service.submitAutoListingItem(request());
  assert.equal(result.submissionJobId, "submission-job-resumed");
  assert.equal(createCalls, 1);
  assert.equal(state.calls.find(([kind]) => kind === "reserve")[1].expectedStatusVersion, 7);
});

test("an unexpired claim owned by another worker is retried without returning an incomplete success DTO", async () => {
  const { service, state } = harness();
  state.context.item.status = "UPLOADING";
  state.context.item.statusVersion = 8;
  state.link = { id: "link-1", status: "RESERVED", idempotencyKey: "same", resultHash: "f".repeat(64),
    targetStoreId: "store-1", claimToken: "claim-other", claimOwned: false };
  await assert.rejects(service.submitAutoListingItem(request()), {
    code: "AUTO_LISTING_UPLOAD_CLAIM_BUSY", retryable: true,
  });
  assert.equal(state.calls.some(([kind]) => ["submit", "bind"].includes(kind)), false);
});

test("account, status/version, policy, store credentials, source draft, plan and media evidence are closed", async () => {
  const mutations = [
    (c) => { c.item.accountId = "account-b"; },
    (c) => { c.item.status = "GENERATING"; },
    (c) => { c.item.statusVersion = 8; },
    (c) => { c.uploadPolicy.enabled = false; },
    (c) => { c.uploadPolicy.publishedBy = "account-b"; },
    (c) => { c.store.credentialsUsable = false; },
    (c) => { c.warehouses[0].isActive = false; },
    (c) => { c.productDraft.dataHash = "f".repeat(64); },
    (c) => { c.item.activePlanId = "plan-other"; },
    (c) => { c.acceptedAssets.pop(); },
    (c) => { c.acceptedAssets[0].role = "DETAIL"; },
    (c) => { c.acceptedRichContent = []; },
  ];
  for (const mutate of mutations) {
    const { service, state } = harness();
    mutate(state.context);
    await assert.rejects(service.submitAutoListingItem(request()), (error) =>
      String(error?.code || "").startsWith("AUTO_LISTING_") || error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE");
    assert.equal(state.calls.some(([kind]) => kind === "publish"), false);
    assert.equal(state.calls.some(([kind]) => kind === "submit"), false);
  }
});

test("a definitely-not-submitted pipeline failure releases the same immutable reservation for a later generation", async () => {
  const { service, state } = harness({
    async createSubmission() {
      throw Object.assign(new Error("source changed before snapshot"), {
        code: "AUTO_LISTING_SOURCE_DRAFT_CHANGED",
        definitelyNotSubmitted: true,
      });
    },
  });
  await assert.rejects(service.submitAutoListingItem(request()), {
    code: "AUTO_LISTING_UPLOAD_RETRYABLE",
    retryable: true,
  });
  const released = state.calls.find(([kind]) => kind === "released")?.[1];
  assert.equal(released.linkId, "link-1");
  assert.equal(released.attempt.outcome, "FAILED");
  assert.equal(state.calls.some(([kind]) => kind === "blocked"), false);
});

test("a SAFE_RETRY delivery generation keeps the immutable business request hash", async () => {
  let submissionCalls = 0;
  const { service, state } = harness({
    async createSubmission() {
      submissionCalls += 1;
      if (submissionCalls === 1) {
        throw Object.assign(new Error("not submitted"), {
          code: "AUTO_LISTING_SOURCE_DRAFT_CHANGED",
          definitelyNotSubmitted: true,
        });
      }
      return { duplicate: false, job: { id: "submission-job-retry", snapshotId: "submission-snapshot-retry",
        status: "QUEUE_PENDING" } };
    },
  });
  await assert.rejects(service.submitAutoListingItem(request()), { code: "AUTO_LISTING_UPLOAD_RETRYABLE" });
  const firstHash = state.calls.find(([kind]) => kind === "reserve")[1].requestHash;
  state.context.item.status = "UPLOAD_QUEUED";
  state.context.item.statusVersion = 9;
  state.link = { ...state.link, status: "RESERVED", claimOwned: true, claimToken: "claim-2" };

  const result = await service.submitAutoListingItem(request({ expectedStatusVersion: 9, correlationId: "corr-2" }));
  const retryHash = state.calls.filter(([kind]) => kind === "reserve").at(-1)[1].requestHash;
  assert.equal(retryHash, firstHash);
  assert.equal(result.submissionJobId, "submission-job-retry");
  assert.deepEqual(state.attempts.map((attempt) => attempt.expectedStatusVersion), [7, 9]);
});

test("an indeterminate pipeline failure is blocked with its audit attempt in the same repository operation", async () => {
  const { service, state } = harness({
    async createSubmission() { throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); },
  });
  await assert.rejects(service.submitAutoListingItem(request()), { code: "AUTO_LISTING_UPLOAD_BLOCKED" });
  const blocked = state.calls.find(([kind]) => kind === "blocked")?.[1];
  assert.equal(blocked.attempt.outcome, "BLOCKED");
  assert.equal(state.calls.some(([kind]) => kind === "attempt"), false);
});

test("a failed durable block write propagates instead of completing the upload task", async () => {
  const { service, repository } = harness({
    async createSubmission() { return { duplicate: false, job: { id: null, snapshotId: null } }; },
  });
  repository.blockSubmission = async () => {
    throw Object.assign(new Error("database unavailable"), {
      code: "AUTO_LISTING_UPLOAD_REPOSITORY_FAILED",
      retryable: true,
    });
  };
  await assert.rejects(service.submitAutoListingItem(request()), {
    code: "AUTO_LISTING_UPLOAD_REPOSITORY_FAILED",
    retryable: true,
  });
});

test("DIRECT submits the verified rich-content contract through the shared idempotent pipeline", async () => {
  const { service, state } = harness({ directUploadAllowed: true });
  state.context.item.status = "UPLOAD_QUEUED";
  state.context.uploadPolicy.mode = "DIRECT";
  const result = await service.submitAutoListingItem(request());
  assert.equal(result.status, "SUBMITTED");
  const submission = state.calls.find(([kind]) => kind === "submit")[1];
  assert.equal(submission.normalizedItems[0].attributes.some((attribute) => Number(attribute.id) === 11254), true);
});

test("DIRECT rejects unknown rich-content contract versions instead of inferring verification from their names", async () => {
  const { service, state } = harness({
    directUploadAllowed: true,
    buildSubmissionDraft(input) {
      const draft = buildAutoListingSubmissionDraft(input);
      return { ...draft, versions: { ...draft.versions, richContentRuleVersion: "TYPO_OR_UNKNOWN" } };
    },
  });
  state.context.item.status = "UPLOAD_QUEUED";
  state.context.uploadPolicy.mode = "DIRECT";
  await assert.rejects(service.submitAutoListingItem(request()), { code: "AUTO_LISTING_DIRECT_RICH_CONTENT_UNVERIFIED" });
  assert.equal(state.calls.some(([kind]) => ["publish", "reserve", "submit"].includes(kind)), false);
});

test("DIRECT remains blocked by the independent rollout kill switch", async () => {
  const { service, state } = harness();
  state.context.item.status = "UPLOAD_QUEUED";
  state.context.uploadPolicy.mode = "DIRECT";
  await assert.rejects(service.submitAutoListingItem(request()), { code: "AUTO_LISTING_DIRECT_UPLOAD_BLOCKED" });
  assert.equal(state.calls.some(([kind]) => ["publish", "reserve", "submit"].includes(kind)), false);
});

test("DIRECT requires fresh publication health readiness evidence before any asset publication", async () => {
  const { service, state } = harness({ directUploadAllowed: true,
    async assertDirectReady() { throw new Error("expired"); },
  });
  state.context.uploadPolicy.mode = "DIRECT";
  await assert.rejects(service.submitAutoListingItem(request()), {
    code: "AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", retryable: true,
  });
  assert.equal(state.calls.some(([kind]) => ["publish", "reserve", "submit"].includes(kind)), false);
});

test("DIRECT fails closed on system readiness before checking publication health", async () => {
  const readinessCalls = [];
  const { service, state } = harness({ directUploadAllowed: true,
    async assertDirectSystemReady() { readinessCalls.push("system"); throw new Error("not ready"); },
    async assertDirectReady() { readinessCalls.push("publication"); return { ready: true, evidenceId: "health-late" }; },
  });
  state.context.uploadPolicy.mode = "DIRECT";
  await assert.rejects(service.submitAutoListingItem(request()), {
    code: "AUTO_LISTING_DIRECT_UPLOAD_BLOCKED", retryable: true,
  });
  assert.deepEqual(readinessCalls, ["system"]);
  assert.equal(state.calls.some(([kind]) => ["publish", "reserve", "submit"].includes(kind)), false);
});

test("DIRECT freezes its current readiness evidence on the link and every upload attempt", async () => {
  const readinessCalls = [];
  const { service, state } = harness({
    directUploadAllowed: true,
    async assertDirectSystemReady() { readinessCalls.push("system"); return { ready: true }; },
    async assertDirectReady() { readinessCalls.push("publication"); return { ready: true, evidenceId: "health-evidence-current" }; },
  });
  state.context.uploadPolicy.mode = "DIRECT";

  await service.submitAutoListingItem(request());

  const reserve = state.calls.find(([kind]) => kind === "reserve")[1];
  assert.equal(reserve.directHealthEvidenceId, "health-evidence-current");
  assert.equal(state.attempts[0].directHealthEvidenceId, "health-evidence-current");
  assert.deepEqual(readinessCalls, ["system", "publication"]);
});

test("same result link or uncertain standard-pipeline success is rebound and never submitted twice", async () => {
  let createCalls = 0;
  let findCalls = 0;
  const { service, state } = harness({
    async createSubmission() { createCalls += 1; throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); },
    async findSubmission() {
      findCalls += 1;
      if (findCalls === 1) return null;
      return { duplicate: true, job: { id: "submission-job-recovered", snapshotId: "submission-snapshot-recovered", status: "QUEUE_PENDING" } };
    },
  });
  state.context.warehouses[0].warehouseType = "RFBS";
  state.context.warehouses[0].hasActiveProductAssociation = false;
  state.context.products = [];
  state.context.warehouseFulfillmentType = "RFBS";
  state.context.creationWarehouseValidation = rfbsValidation({ correlationId: "job-corr" });
  const recovered = await service.submitAutoListingItem(request());
  assert.equal(recovered.submissionJobId, "submission-job-recovered");
  assert.equal(createCalls, 1);
  assert.equal(findCalls, 2);
  const replay = await service.submitAutoListingItem(request());
  assert.equal(replay.submissionJobId, "submission-job-recovered");
  assert.equal(replay.duplicate, true);
  assert.equal(createCalls, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "verify").length, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "publish").length,
    state.context.acceptedAssets.length);
  assert.equal(state.calls.filter(([kind]) => kind === "reserve").length, 1);
  state.context.item.status = "SUCCEEDED";
  state.context.item.statusVersion = 99;
  const reconciledReplay = await service.submitAutoListingItem(request());
  assert.equal(reconciledReplay.submissionJobId, "submission-job-recovered");
  assert.equal(reconciledReplay.duplicate, true);
  assert.equal(createCalls, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "verify").length, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "reserve").length, 1);
  state.link.resultHash = "0".repeat(64);
  await assert.rejects(service.submitAutoListingItem(request()), { code: "AUTO_LISTING_UPLOAD_CONFLICT" });
  assert.equal(state.calls.filter(([kind]) => kind === "verify").length, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "publish").length,
    state.context.acceptedAssets.length);
  assert.equal(state.calls.filter(([kind]) => kind === "reserve").length, 1);
});
