import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

async function requestJson(handle, pathname, body, token, storeId, method = "POST") {
  const payload = JSON.stringify(body || {});
  const req = Readable.from([Buffer.from(payload)]);
  req.method = method;
  req.url = pathname;
  req.headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-ozon-store-id": storeId,
  };
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "qh-collect-submit-failure-"));
const dataFile = path.join(dataDir, "local-state.json");
const token = "local-test-token";
const storeId = "local_submit_store";
const collectId = "collect-submit-failure";
const completeCollectId = "collect-preview-complete";
const enrichedCollectId = "collect-preview-enriched-logistics";
const sourceOnlyCollectId = "collect-source-only-category";
const eligibleWarehouseId = "1020003087687000";
const fboWarehouseId = "1020003087687001";
const archivedOnlyWarehouseId = "1020003087687002";
const foreignWarehouseId = "1020003087687999";

await writeFile(dataFile, `${JSON.stringify({
  token,
  currentAccountId: "acct_submit_test",
  sessionIssuedAt: "2026-01-01T00:00:00.000Z",
  accounts: [{
    id: "acct_submit_test",
    username: "submit-test",
    displayName: "Submit Test",
    role: "admin",
    status: "active",
  }, {
    id: "acct_foreign",
    username: "foreign-test",
    displayName: "Foreign Test",
    role: "user",
    status: "active",
  }],
  currentStoreId: storeId,
  stores: [{
    id: storeId,
    ownerAccountId: "acct_submit_test",
    label: "submit-store",
    clientId: "submit-client",
    apiKey: "submit-key",
    status: "active",
  }, {
    id: "foreign-submit-store",
    ownerAccountId: "acct_foreign",
    label: "Foreign Secret Store",
    clientId: "foreign-secret-client",
    apiKey: "foreign-secret-key",
    status: "active",
  }],
  caches: {
    products: [{
      id: "active-fbs-product",
      accountId: "acct_submit_test",
      storeId,
      is_archived: false,
      warehouse_stocks: [{ warehouse_id: eligibleWarehouseId, source: "fbs", present: 0 }],
    }, {
      id: "archived-fbs-product",
      accountId: "acct_submit_test",
      storeId,
      is_archived: true,
      warehouse_stocks: [{ warehouse_id: archivedOnlyWarehouseId, source: "fbs", present: 5 }],
    }, {
      id: "foreign-fbs-product",
      accountId: "acct_foreign",
      storeId: "foreign-submit-store",
      is_archived: false,
      warehouse_stocks: [{ warehouse_id: foreignWarehouseId, source: "fbs", present: 5 }],
    }],
    warehouses: [{
      id: "wh_eligible",
      accountId: "acct_submit_test",
      storeId,
      warehouse_id: eligibleWarehouseId,
      warehouse_type: "fbs",
      status: "active",
    }, {
      id: "wh_fbo",
      accountId: "acct_submit_test",
      storeId,
      warehouse_id: fboWarehouseId,
      warehouse_type: "fbo",
      status: "active",
    }, {
      id: "wh_archived_only",
      accountId: "acct_submit_test",
      storeId,
      warehouse_id: archivedOnlyWarehouseId,
      warehouse_type: "fbs",
      status: "active",
    }, {
      id: "wh_placeholder",
      accountId: "acct_submit_test",
      storeId,
      warehouse_id: "",
      warehouse_type: "fbs",
      status: "active",
    }, {
      id: "wh_foreign",
      accountId: "acct_foreign",
      storeId: "foreign-submit-store",
      warehouse_id: foreignWarehouseId,
      warehouse_type: "fbs",
      status: "active",
    }],
    collectBox: [{
      id: collectId,
      accountId: "acct_submit_test",
      storeId,
      localStoreId: storeId,
      sku: "4260049338",
      status: "待处理",
      listingDraft: {
        sku: "4260049338",
        title: "Collect listing submit item",
        price: "100",
        currencyCode: "CNY",
        descriptionCategoryId: 17028941,
        typeId: 91670,
        categoryResolution: {
          status: "MATCHED",
          method: "MANUAL",
          target: { storeId, descriptionCategoryId: 17028941, typeId: 91670 },
        },
        packageWeight: "799",
        packageLength: "350",
        packageWidth: "85",
        packageHeight: "50",
        enrichment: {
          status: "COMPLETE",
          missingFields: [],
        },
        listingWarehouseId: "1020003087687000",
        listingStock: "5",
        images: ["https://cdn.example.test/main.jpg"],
      },
    }, {
      id: completeCollectId,
      accountId: "acct_submit_test",
      storeId,
      localStoreId: storeId,
      sku: "4260049339",
      status: "待处理",
      sourceCategory: {
        descriptionCategoryId: 17000001,
        path: ["Freshly collected source category"],
      },
      listingDraft: {
        sku: "4260049339",
        title: "Complete collect listing preview item",
        price: "100",
        currencyCode: "CNY",
        descriptionCategoryId: 17028941,
        typeId: 91670,
        categoryResolution: {
          status: "MATCHED",
          method: "MANUAL",
          source: { descriptionCategoryId: 17000001 },
          target: { storeId, descriptionCategoryId: 17028941, typeId: 91670 },
        },
        packageWeight: "799",
        packageLength: "350",
        packageWidth: "85",
        packageHeight: "50",
        listingWarehouseId: "1020003087687000",
        listingStock: "5",
        images: ["https://cdn.example.test/complete.jpg"],
      },
    }, {
      id: sourceOnlyCollectId,
      accountId: "acct_submit_test",
      taxonomyScope: "OZON:COLLECTOR_FORGED",
      sku: "4260049341",
      status: "COMPLETE",
      sourceCategory: { descriptionCategoryId: 123, typeIdCandidate: 456 },
      listingDraft: {
        sku: "4260049341",
        title: "Source category must never become listing target",
        price: "100",
        currencyCode: "CNY",
        descriptionCategoryId: 123,
        typeId: 456,
        sourceCategory: { descriptionCategoryId: 123, typeIdCandidate: 456 },
        packageWeight: "800",
        packageLength: "350",
        packageWidth: "85",
        packageHeight: "50",
        listingWarehouseId: "1020003087687000",
        listingStock: "5",
        images: ["https://cdn.example.test/source-only.jpg"],
      },
    }, {
      id: enrichedCollectId,
      accountId: "acct_submit_test",
      storeId,
      localStoreId: storeId,
      sku: "4260049340",
      status: "COMPLETE",
      enrichment: { status: "COMPLETE", missingFields: [] },
      listingDraft: {
        sku: "4260049340",
        title: "Seller-enriched logistics preview item",
        price: "100",
        currencyCode: "CNY",
        descriptionCategoryId: 17000001,
        typeId: 97000001,
        categoryResolution: {
          status: "MATCHED",
          method: "MANUAL",
          source: { descriptionCategoryId: 17000001, typeIdCandidate: 97000001 },
          target: { storeId, descriptionCategoryId: 17028941, typeId: 91670 },
        },
        sourceCategory: {
          descriptionCategoryId: 17000001,
          typeIdCandidate: 97000001,
          path: ["Seller source category"],
        },
        variants: [{
          sku: "4260049340",
          description_category_id: 17000001,
          type_id: 97000001,
          sourceCategory: {},
        }],
        logistics: { weightG: 801, lengthMm: 351, widthMm: 86, heightMm: 51 },
        listingWarehouseId: "1020003087687000",
        listingStock: "5",
        images: ["https://cdn.example.test/enriched.jpg"],
      },
    }],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
}, null, 2)}\n`, "utf8");

const originalFetch = globalThis.fetch;
let externalWriteCalls = 0;
const fetchRequests = [];
globalThis.fetch = async (url) => {
  const href = String(url);
  fetchRequests.push(href);
  if (href.endsWith("/v1/description-category/attribute")) {
    return new Response(JSON.stringify({
      result: [
        { id: 4180 },
        { id: 4191 },
        { id: 4497 },
        { id: 9454 },
        { id: 9455 },
        { id: 9456 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (href.endsWith("/v3/product/import")) {
    externalWriteCalls += 1;
    const error = new TypeError("fetch failed");
    error.cause = { code: "UND_ERR_SOCKET", message: "other side closed" };
    throw error;
  }
  throw new Error(`Unexpected test fetch URL: ${href}`);
};

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.LISTING_PIPELINE_V3 = "0";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

try {
  const { handle } = await import("../index.mjs");

  const missingItem = await requestJson(
    handle,
    "/ozon/collect-box/missing-listing-item/listing/submit",
    { targetStoreId: storeId, idempotencyKey: "missing-listing-item" },
    token,
    storeId,
  );
  assert.equal(missingItem.status, 404);
  assert.equal(missingItem.body.code, "COLLECT_ITEM_NOT_FOUND");

  for (const action of ["preview", "submit"]) {
    const incomplete = await requestJson(
      handle,
      `/ozon/collect-box/${collectId}/listing/${action}`,
      {
        targetStoreId: storeId,
        idempotencyKey: `incomplete-${action}`,
      },
      token,
      storeId,
    );
    assert.equal(incomplete.status, 422);
    assert.equal(incomplete.body.code, "COLLECT_ENRICHMENT_INCOMPLETE");
    assert.deepEqual(incomplete.body.missingFields, ["descriptionCategoryId"]);
    const unchangedState = JSON.parse(await readFile(dataFile, "utf8"));
    const unchangedItem = unchangedState.caches.collectBox.find((row) => row.id === collectId);
    assert.equal(unchangedItem.status, "待处理");
    assert.equal(unchangedItem.listingLastError, undefined);
    assert.equal(unchangedItem.listingLastErrorAt, undefined);
    assert.equal(externalWriteCalls, 0);
    assert.deepEqual(fetchRequests, [], "incomplete collection items must not reach Ozon");
  }

  const missingTarget = await requestJson(
    handle,
    `/ozon/collect-box/${collectId}/listing/submit`,
    { idempotencyKey: "submit-missing-target" },
    token,
    storeId,
  );
  assert.equal(missingTarget.status, 422);
  assert.equal(missingTarget.body.code, "TARGET_STORE_REQUIRED");

  const foreignTarget = await requestJson(
    handle,
    `/ozon/collect-box/${collectId}/listing/submit`,
    {
      targetStoreId: "foreign-submit-store",
      idempotencyKey: "submit-foreign-target",
    },
    token,
    storeId,
  );
  assert.equal(foreignTarget.status, 404);
  assert.equal(foreignTarget.body.code, "TARGET_STORE_NOT_FOUND");
  assert.doesNotMatch(JSON.stringify(foreignTarget.body), /Foreign Secret Store|foreign-secret-client|foreign-secret-key/);

  assert.equal(externalWriteCalls, 0);
  assert.deepEqual(fetchRequests, [], "fail-closed route must not make any external request");

  for (const action of ["preview", "submit"]) {
    const sourceOnly = await requestJson(
      handle,
      `/ozon/collect-box/${sourceOnlyCollectId}/listing/${action}`,
      { targetStoreId: storeId, idempotencyKey: `source-only-${action}` },
      token,
      storeId,
    );
    assert.equal(sourceOnly.status, 422);
    assert.equal(sourceOnly.body.code, "COLLECT_TARGET_CATEGORY_REQUIRED");
    assert.equal(externalWriteCalls, 0);
    assert.deepEqual(fetchRequests, [], "source aliases must fail before category normalization or Ozon calls");
  }

  const sourceOnlyState = JSON.parse(await readFile(dataFile, "utf8"));
  const sourceOnlyDraft = sourceOnlyState.caches.collectBox
    .find((row) => row.id === sourceOnlyCollectId).listingDraft;
  const patchedTarget = await requestJson(
    handle,
    `/ozon/collect-box/${sourceOnlyCollectId}`,
    {
      description_category_id: 17028941,
      type_id: 91670,
      listingDraft: {
        ...sourceOnlyDraft,
        categoryResolution: {
          status: "MATCHED",
          method: "MANUAL",
          source: { descriptionCategoryId: 123, typeIdCandidate: 456 },
          target: { storeId, descriptionCategoryId: 17028941, typeId: 91670 },
        },
      },
    },
    token,
    storeId,
    "PATCH",
  );
  assert.equal(patchedTarget.status, 200, JSON.stringify(patchedTarget.body));
  assert.equal(patchedTarget.body.listingDraft.categoryResolution.target.storeId, storeId);
  assert.equal(patchedTarget.body.listingDraft.categoryResolution.method, "MANUAL");
  assert.equal(patchedTarget.body.listingDraft.categoryResolution.target.descriptionCategoryId, 17028941);
  assert.equal(patchedTarget.body.description_category_id, undefined);
  assert.equal(patchedTarget.body.type_id, undefined);
  assert.equal(patchedTarget.body.sourceCategory.descriptionCategoryId, 123);
  assert.equal(patchedTarget.body.sourceCategory.typeIdCandidate, 456);
  const persistedAfterManualSave = JSON.parse(await readFile(dataFile, "utf8"));
  const persistedTarget = persistedAfterManualSave.caches.collectBox
    .find((row) => row.id === sourceOnlyCollectId).listingDraft.categoryResolution;
  assert.equal(persistedTarget.target.storeId, storeId);
  const canonicalManual = persistedAfterManualSave.collectCategoryResolutions
    .find((row) => row.accountId === "acct_submit_test"
      && row.collectItemId === sourceOnlyCollectId
      && row.taxonomyScope === "OZON:DEFAULT");
  assert.equal(canonicalManual.status, "MATCHED");
  assert.equal(canonicalManual.method, "MANUAL");
  assert.equal(canonicalManual.targetDescriptionCategoryId, 17028941);
  assert.equal(canonicalManual.targetTypeId, 91670);
  assert.equal(canonicalManual.credentialStoreId, storeId);
  assert.equal(
    persistedAfterManualSave.auditEvents.some((event) =>
      event.action === "COLLECT_CATEGORY_RESOLUTION_MANUAL_SAVED"
      && event.accountId === "acct_submit_test"
      && event.entityId === sourceOnlyCollectId),
    true,
  );

  const publicStateAfterManualSave = await requestJson(
    handle,
    "/local/state",
    {},
    token,
    storeId,
    "GET",
  );
  const publicManual = publicStateAfterManualSave.body.caches.collectBox
    .find((row) => row.id === sourceOnlyCollectId).categoryResolution;
  assert.equal(publicManual.method, "MANUAL");
  assert.equal(publicManual.targetDescriptionCategoryId, 17028941);
  assert.equal(publicManual.targetTypeId, 91670);

  const ineligibleWarehouseCases = [
    { warehouseId: fboWarehouseId, reason: "UNSUPPORTED_FULFILLMENT_TYPE" },
    { warehouseId: archivedOnlyWarehouseId, reason: "NO_ACTIVE_PRODUCT_ASSOCIATION" },
    { warehouseId: foreignWarehouseId, reason: "STORE_SCOPE_MISMATCH" },
    { warehouseId: "wh_placeholder", reason: "STORE_SCOPE_MISMATCH" },
  ];
  for (const { warehouseId, reason } of ineligibleWarehouseCases) {
    for (const action of ["preview", "submit"]) {
      const latestState = JSON.parse(await readFile(dataFile, "utf8"));
      const completeItem = latestState.caches.collectBox.find((row) => row.id === completeCollectId);
      completeItem.listingDraft.listingWarehouseId = warehouseId;
      await writeFile(dataFile, `${JSON.stringify(latestState, null, 2)}\n`, "utf8");
      const beforeExternalWrites = externalWriteCalls;
      const response = await requestJson(
        handle,
        `/ozon/collect-box/${completeCollectId}/listing/${action}`,
        { targetStoreId: storeId, idempotencyKey: `warehouse-${reason}-${action}` },
        token,
        storeId,
      );
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.equal(response.body.code, "LISTING_WAREHOUSE_NOT_ELIGIBLE");
      assert.equal(response.body.message, "请选择当前店铺的活跃 FBS 仓库");
      assert.equal(response.body.reason, reason);
      assert.equal(externalWriteCalls, beforeExternalWrites);
      const rejectedState = JSON.parse(await readFile(dataFile, "utf8"));
      assert.deepEqual(rejectedState.jobs || {}, {});
    }
  }

  const stateBeforeEligiblePreview = JSON.parse(await readFile(dataFile, "utf8"));
  stateBeforeEligiblePreview.caches.collectBox
    .find((row) => row.id === completeCollectId).listingDraft.listingWarehouseId = eligibleWarehouseId;
  await writeFile(dataFile, `${JSON.stringify(stateBeforeEligiblePreview, null, 2)}\n`, "utf8");

  const completePreview = await requestJson(
    handle,
    `/ozon/collect-box/${completeCollectId}/listing/preview`,
    { targetStoreId: storeId, idempotencyKey: "complete-preview" },
    token,
    storeId,
  );
  assert.equal(completePreview.status, 200, JSON.stringify(completePreview.body));
  assert.equal(completePreview.body.ok, true);
  assert.equal(externalWriteCalls, 0);

  const enrichedPreview = await requestJson(
    handle,
    `/ozon/collect-box/${enrichedCollectId}/listing/preview`,
    { targetStoreId: storeId, idempotencyKey: "enriched-logistics-preview" },
    token,
    storeId,
  );
  assert.equal(enrichedPreview.status, 200, JSON.stringify(enrichedPreview.body));
  assert.equal(enrichedPreview.body.ok, true);
  assert.equal(enrichedPreview.body.items?.[0]?.weight, 801);
  assert.equal(enrichedPreview.body.items?.[0]?.depth, 351);
  assert.equal(enrichedPreview.body.items?.[0]?.description_category_id, 17028941);
  assert.notEqual(enrichedPreview.body.items?.[0]?.description_category_id, 17000001);
  assert.equal(enrichedPreview.body.items?.[0]?.type_id, 91670);
  assert.notEqual(enrichedPreview.body.items?.[0]?.type_id, 97000001);
  assert.equal(externalWriteCalls, 0);

  const state = JSON.parse(await readFile(dataFile, "utf8"));
  const item = state.caches.collectBox.find((row) => row.id === collectId);
  assert.equal(item.status, "失败");
  assert.equal(item.listingTaskId, "");
  assert.equal(item.listingJobId, "");
  assert.match(item.listingLastError, /目标经营店铺不存在或不可用/);

  console.log("collect listing fail-closed smoke passed");
  process.exitCode = 0;
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
