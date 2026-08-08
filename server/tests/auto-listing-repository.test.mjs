import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { buildAutoListingBlockedSourceEvidence, buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function listingBaseTemplate(sourceRecordId, sourceOrder) {
  const price = { currency: "RUB", blackKopecks: "10000", greenKopecks: "8000" };
  const image = `https://source.example.test/${sourceOrder}.jpg`;
  return {
    productDraft: { id: `draft-${sourceRecordId}`, version: 1, dataHash: "1".repeat(64) },
    pricingEvidence: { ...price, evidenceHash: digest(price) },
    richContentAttributeSupported: true,
    variants: [{
      sourceVariantId: `variant-${sourceOrder}`,
      sourceSku: `sku-lock-${sourceOrder}`,
      item: {
        offer_id: `offer-lock-${sourceOrder}`, name: "Locked evidence product", price: "100.00",
        currency_code: "RUB", description_category_id: 123, type_id: 456,
        primary_image: image, images: [image], weight: 100, weight_unit: "g",
        depth: 100, width: 100, height: 100, dimension_unit: "mm",
        attributes: [{ id: 85, complex_id: 0, values: [{ value: "No brand" }] }],
      },
    }],
    versions: {
      normalizerVersion: "normalizer-v3", categoryRuleVersion: "category-v5", dictionaryVersion: "dictionary-live",
    },
  };
}

function transitionFixture({
  status, recoveryPoint = null, failureCode = "AUTO_LISTING_TRANSIENT", legacyCurrentEvent = null,
  legacyFallbackEvent = null, insertError = null, statusVersion = 3, updatedStatusVersion = null,
} = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_job_items/.test(sql) && /FOR UPDATE/.test(sql)) {
        const row = { id: "item-a", job_id: "job-a", status, status_version: statusVersion,
          recovery_point: recoveryPoint, failure_code: failureCode };
        if (!/failure_code/.test(sql)) delete row.failure_code;
        return { rows: [row] };
      }
      if (/FROM auto_listing_events e/.test(sql) && /e\.transition_version=\$4/.test(sql)) {
        return { rows: legacyCurrentEvent ? [legacyCurrentEvent] : [] };
      }
      if (/FROM auto_listing_events e/.test(sql) && /e\.id=\$4 AND e\.transition_version IS NULL/.test(sql)) {
        return { rows: legacyFallbackEvent ? [legacyFallbackEvent] : [] };
      }
      if (/UPDATE auto_listing_job_items/.test(sql)) return { rows: [{ id: "item-a", status: "PLANNING", status_version: updatedStatusVersion ?? statusVersion + 1 }] };
      if (/INSERT INTO auto_listing_events/.test(sql)) {
        if (insertError) throw insertError;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  return { calls, repository: createAutoListingRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } }) };
}

async function update(repository, eventType, details = {}, expectedStatusVersion = 3) {
  return repository.updateItemStatus({
    accountId: "account-a", itemId: "item-a", expectedStatusVersion,
    eventType, actorAccountId: "account-a", correlationId: "corr-a", details,
  });
}

test("retryable failure derives and atomically persists the locked recovery point", async () => {
  const { repository, calls } = transitionFixture({ status: "GENERATING" });
  await update(repository, "RETRYABLE_FAILURE", { failureCode: "AUTO_LISTING_TRANSIENT" });
  const updateCall = calls.find(({ sql }) => /UPDATE auto_listing_job_items/.test(sql));
  const eventCall = calls.find(({ sql }) => /INSERT INTO auto_listing_events/.test(sql));

  assert.equal(updateCall.params[1], "AUTO_LISTING_TRANSIENT");
  assert.equal(updateCall.params[2], "GENERATION");
  assert.deepEqual(JSON.parse(eventCall.params.at(-1)), {
    failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "GENERATION",
  });
  assert.equal(eventCall.params.at(-2), 4);
});

test("a mismatched caller recovery point is rejected before item or event writes", async () => {
  const { repository, calls } = transitionFixture({ status: "GENERATING" });
  await assert.rejects(
    update(repository, "RETRYABLE_FAILURE", {
      failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING",
    }),
    (error) => error?.code === "AUTO_LISTING_RECOVERY_POINT_MISMATCH",
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
});

test("wrong retry leaves the locked item and audit log untouched", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", recoveryPoint: "PLANNING" });
  await assert.rejects(
    update(repository, "RETRY_GENERATION"),
    (error) => error?.code === "AUTO_LISTING_TRANSITION_FORBIDDEN",
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("correct retry clears failure and recovery point in one CAS update", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", recoveryPoint: "PLANNING" });
  await update(repository, "RETRY_PLANNING", { attempt: 2 });
  const updateCall = calls.find(({ sql }) => /UPDATE auto_listing_job_items/.test(sql));
  const eventCall = calls.find(({ sql }) => /INSERT INTO auto_listing_events/.test(sql));

  assert.equal(updateCall.params[1], null);
  assert.equal(updateCall.params[2], null);
  assert.deepEqual(JSON.parse(eventCall.params.at(-1)), { attempt: 2 });
});

test("cancelling a retryable item clears failure and recovery point in one CAS update", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", recoveryPoint: "UPLOAD" });
  await update(repository, "CANCEL");
  const updateCall = calls.find(({ sql }) => /UPDATE auto_listing_job_items/.test(sql));

  assert.equal(updateCall.params[1], null);
  assert.equal(updateCall.params[2], null);
});

test("missing persisted recovery point fails closed before any update or event", async () => {
  const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR" });
  await assert.rejects(
    update(repository, "RETRY_PLANNING"),
    (error) => error?.code === "AUTO_LISTING_RECOVERY_POINT_INVALID",
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
});

test("a legacy retry uses its exact transition version even when a newer timestamp is unrelated", async () => {
  const { repository, calls } = transitionFixture({
    status: "RETRYABLE_ERROR",
    legacyCurrentEvent: {
      account_id: "account-a", job_id: "job-a", item_id: "item-a", event_type: "RETRYABLE_FAILURE",
      from_status: "UPLOADING", to_status: "RETRYABLE_ERROR",
      transition_version: 3, created_at: "2000-01-01T00:00:00.000Z",
      details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "UPLOAD" },
    },
  });
  await update(repository, "RETRY_UPLOAD");
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /FROM auto_listing_events e/.test(sql) && /created_at/.test(sql)), false);
});

test("legacy recovery rejects cross-boundary and incomplete exact-version evidence before writes", async () => {
  const base = {
    account_id: "account-a", job_id: "job-a", item_id: "item-a", event_type: "RETRYABLE_FAILURE",
    from_status: "PLANNING", to_status: "RETRYABLE_ERROR",
    details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING" },
  };
  for (const legacyEvent of [
    { ...base, event_type: "START_PLANNING" },
    { ...base, job_id: "other-job" },
    { ...base, account_id: "other-account" },
    { ...base, item_id: "other-item" },
    { ...base, to_status: "PLANNING" },
    { ...base, details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "UPLOAD" } },
    { ...base, details: { failureCode: "OTHER_FAILURE", recoveryPoint: "PLANNING" } },
  ]) {
    const { repository, calls } = transitionFixture({ status: "RETRYABLE_ERROR", legacyCurrentEvent: legacyEvent });
    await assert.rejects(
      update(repository, "RETRY_PLANNING"),
      (error) => error?.code === "AUTO_LISTING_RECOVERY_POINT_INVALID",
    );
    assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
  }
});

test("a migration-era null event may use only the exact deterministic event ID", async () => {
  const { repository, calls } = transitionFixture({
    status: "RETRYABLE_ERROR",
    legacyFallbackEvent: {
      id: "item-a_04", account_id: "account-a", job_id: "job-a", item_id: "item-a", event_type: "RETRYABLE_FAILURE",
      from_status: "PLANNING", to_status: "RETRYABLE_ERROR", transition_version: null,
      details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING" },
    },
  });
  await update(repository, "RETRY_PLANNING");
  assert.equal(calls.some(({ sql }) => /e\.transition_version=\$4/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /e\.id=\$4 AND e\.transition_version IS NULL/.test(sql)), true);
});

test("versions over 99 use one deterministic event-ID rule for legacy lookup and new writes", async () => {
  const { repository, calls } = transitionFixture({
    status: "RETRYABLE_ERROR", statusVersion: 100,
    legacyFallbackEvent: {
      id: "item-a_101", account_id: "account-a", job_id: "job-a", item_id: "item-a", event_type: "RETRYABLE_FAILURE",
      from_status: "PLANNING", to_status: "RETRYABLE_ERROR", transition_version: null,
      details: { failureCode: "AUTO_LISTING_TRANSIENT", recoveryPoint: "PLANNING" },
    },
  });
  await update(repository, "RETRY_PLANNING", {}, 100);
  const fallback = calls.find(({ sql }) => /e\.id=\$4 AND e\.transition_version IS NULL/.test(sql));
  const event = calls.find(({ sql }) => /INSERT INTO auto_listing_events/.test(sql));
  assert.equal(fallback.params.at(-1), "item-a_101");
  assert.equal(event.params[0], "item-a_102");
  assert.equal(event.params.at(-2), 101);
});

test("a mismatched CAS status version rolls back before it can append a causal event", async () => {
  const { repository, calls } = transitionFixture({ status: "PLANNING", updatedStatusVersion: 9 });
  await assert.rejects(
    update(repository, "RETRYABLE_FAILURE", { failureCode: "AUTO_LISTING_TRANSIENT" }),
    (error) => error?.code === "AUTO_LISTING_VERSION_CONFLICT",
  );
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_events/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("duplicate transition versions roll back the status update without commit", async () => {
  const duplicate = Object.assign(new Error("duplicate transition version"), { code: "23505" });
  const { repository, calls } = transitionFixture({ status: "PLANNING", insertError: duplicate });
  await assert.rejects(
    update(repository, "RETRYABLE_FAILURE", { failureCode: "AUTO_LISTING_TRANSIENT" }),
    (error) => error === duplicate,
  );
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
});

test("event insertion failure rolls back the status and recovery-point write", async () => {
  const failure = new Error("forced event insert failure");
  const { repository, calls } = transitionFixture({ status: "PLANNING", insertError: failure });
  await assert.rejects(
    update(repository, "RETRYABLE_FAILURE", { failureCode: "AUTO_LISTING_TRANSIENT" }),
    (error) => error === failure,
  );
  assert.equal(calls.some(({ sql }) => /UPDATE auto_listing_job_items/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
});

function warehouseGraph({ itemCount = 1 } = {}) {
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 1,
    priceAdjustmentKopecks: "0",
  });
  const items = Array.from({ length: itemCount }, (_, sourceOrder) => {
    const sourceRecordId = `collect-lock-${sourceOrder}`;
    const captured = buildAutoListingSourceSnapshot({
      accountId: "account-a",
      sourceType: "COLLECT_BOX",
      sourceRecordId,
      sourceVersion: "1",
      rawResponseRef: `raw-lock-${sourceOrder}`,
      rawResponseHash: `hash-lock-${sourceOrder}`,
      productDraft: { id: `draft-${sourceRecordId}`, version: 1 },
      collectItem: {
        id: sourceRecordId,
        accountId: "account-a",
        sku: `sku-lock-${sourceOrder}`,
        listingDraft: {
          sku: `sku-lock-${sourceOrder}`,
          offerId: `offer-lock-${sourceOrder}`,
          title: "Locked evidence product",
          currency: "RUB",
          blackKopecks: "10000",
          greenKopecks: "8000",
          images: [],
          variants: [{ sku: `sku-lock-${sourceOrder}`, offerId: `offer-lock-${sourceOrder}` }],
          categoryResolution: {
            status: "MATCHED", method: "test",
            target: { storeId: "store-a", descriptionCategoryId: "123", typeId: "456" },
            source: { path: [] },
          },
        },
      },
    });
    return {
      sourceType: "COLLECT_BOX",
      sourceRecordId,
      sourceVersion: "1",
      snapshot: captured.snapshot,
      snapshotHash: captured.snapshotHash,
      rawResponseRef: captured.rawResponseRef,
      targetStoreId: config.targetStoreId,
      targetWarehouseId: config.targetWarehouseId,
      sourceOrder,
      status: "SOURCE_READY",
      strategyId: "strategy-a",
      strategyVersionId: "strategy-version-a",
      ruleId: null,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: {
        currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000",
        realPriceKopecks: "14500", adjustmentKopecks: "0", finalPriceKopecks: "14500",
      },
      effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
        configSnapshot: config, configHash, sourceCapture: captured,
      }),
      listingBaseTemplate: listingBaseTemplate(sourceRecordId, sourceOrder),
    };
  });
  return {
    accountId: "account-a",
    actorAccountId: "account-a",
    sourceType: "COLLECT_BOX",
    idempotencyKey: "lock-evidence-key",
    correlationId: "lock-evidence-correlation",
    configSnapshot: config,
    configHash,
    strategyVersionId: "strategy-version-a",
    uploadPolicyVersionId: "upload-policy-review-a",
    items,
  };
}

function excelWarehouseGraph() {
  const graph = warehouseGraph();
  const collectItemId = "collect-lock-0";
  const sourceRecordId = "row-lock-0";
  const captured = buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "EXCEL_SKU", sourceRecordId, collectItemId,
    sourceVersion: "1", rawResponseRef: "raw-lock-0", rawResponseHash: "hash-lock-0",
    productDraft: { id: "draft-collect-lock-0", version: 1 },
    collectItem: {
      id: collectItemId, accountId: "account-a", sku: "sku-lock-0",
      listingDraft: {
        sku: "sku-lock-0", offerId: "offer-lock-0", title: "Locked evidence product",
        currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: [],
        variants: [{ sku: "sku-lock-0", offerId: "offer-lock-0" }],
        categoryResolution: {
          status: "MATCHED", method: "test",
          target: { storeId: "store-a", descriptionCategoryId: "123", typeId: "456" },
          source: { path: [] },
        },
      },
    },
  });
  graph.sourceType = "EXCEL_SKU";
  graph.items = [{
    ...graph.items[0], sourceType: "EXCEL_SKU", sourceRecordId, collectItemId,
    snapshot: captured.snapshot, snapshotHash: captured.snapshotHash,
    effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
      configSnapshot: graph.configSnapshot, configHash: graph.configHash, sourceCapture: captured,
    }),
  }];
  return graph;
}

function warehouseEvidenceFixture({
  store = {}, credential = true, warehouse = {}, associations = true,
  profiles = [{ id: "profile-a", config_version: 3 }],
  stageInitialPlanWork = null,
} = {}) {
  const calls = [];
  const stop = Object.assign(new Error("stop after evidence"), { code: "STOP_AFTER_EVIDENCE" });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2/.test(sql)) return { rows: [] };
      if (/FROM ai_content_strategy_versions/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM auto_listing_upload_policy_versions/.test(sql)) return { rows: [{ id: "upload-policy-review-a" }] };
      if (/FROM ai_gateway_profiles/.test(sql)) return { rows: profiles };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_import_rows/.test(sql)) return { rows: [{
        draft_id: `draft-${params[1]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/FROM collect_items c/.test(sql)) return { rows: [{
        draft_id: `draft-${params[0]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/FROM stores s/.test(sql) && /owner_account_id/.test(sql)) return { rows: [{
        id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A",
        client_id: "client-a", currency_code: "RUB", status: "active", ...store,
      }] };
      if (/FROM store_credentials/.test(sql)) return { rows: credential ? [{ store_id: "store-a" }] : [] };
      if (/FROM warehouses w/.test(sql)) return { rows: [{
        id: "warehouse-a", store_id: "store-a", warehouse_id: "platform-a", name: "Warehouse A",
        warehouse_type: "FBS", status: "active", is_active: true, is_archived: false, owner_account_id: "account-a", ...warehouse,
      }] };
      if (/FROM product_stocks ps/.test(sql)) return { rows: associations ? [{
        product_id: "product-a", product_store_id: "store-a", product_status: "active", product_is_archived: false,
        product_raw_is_archived: false, warehouse_id: "warehouse-a", source: "fbs",
      }] : [] };
      if (/INSERT INTO auto_listing_jobs/.test(sql)) throw stop;
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  return {
    calls,
    stop,
    repository: createAutoListingRepository({
      pool: { connect: async () => client, query: async () => ({ rows: [] }) },
      idFactory: (prefix) => `${prefix}-id`,
      stageInitialPlanWork,
    }),
  };
}

test("repository accepts only a function or null for the optional initial AI workflow port", () => {
  const pool = { connect: async () => {}, query: async () => ({ rows: [] }) };
  assert.throws(
    () => createAutoListingRepository({ pool, stageInitialPlanWork: {} }),
    /initial AI workflow port must be a function or null/,
  );
});

test("job creation without an AI workflow keeps the legacy profile-free path", async () => {
  const { repository, calls, stop } = warehouseEvidenceFixture();
  await assert.rejects(repository.createJobGraph(warehouseGraph()), (error) => error === stop);

  assert.equal(calls.some(({ sql }) => /FROM ai_gateway_profiles/.test(sql)), false);
  const insertCall = calls.find(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql));
  assert.match(insertCall.sql, /strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,correlation_id/iu);
  assert.deepEqual(insertCall.params.slice(6), [
    "strategy-version-a", "upload-policy-review-a", null, null, "account-a", "lock-evidence-correlation",
  ]);
  const policyCall = calls.find(({ sql }) => /FROM auto_listing_upload_policy_versions/.test(sql));
  assert.match(policyCall.sql, /publication_origin IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_base_url IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_prefix IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_version IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_policy_hash ~ '\^\[a-f0-9\]\{64\}\$'/iu);
});

test("EXCEL_SKU job creation locks the ready import-row to collect-item relationship", async () => {
  const { repository, calls, stop } = warehouseEvidenceFixture();
  await assert.rejects(repository.createJobGraph(excelWarehouseGraph()), (error) => error === stop);
  const sourceCheck = calls.find(({ sql }) => /FROM auto_listing_import_rows/.test(sql));
  assert.match(sourceCheck.sql, /JOIN collect_items/u);
  assert.match(sourceCheck.sql, /r\.status='READY'/u);
  assert.deepEqual(sourceCheck.params, ["row-lock-0", "collect-lock-0", "account-a"]);
  assert.equal(calls.some(({ sql }) => /SELECT 1 FROM collect_items[\s\S]*id=\$1/u.test(sql)), false);
});

test("loads finalizable Excel source rows with account and ready-state boundaries", async () => {
  const calls = [];
  const repository = createAutoListingRepository({
    pool: {
      connect: async () => assert.fail("read path must not open a transaction"),
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        if (/FROM auto_listing_import_files/u.test(sql)) return { rows: [{
          id: "import-1", account_id: "account-a", status: "COLLECTING", status_version: "2",
          accepted_rows: 1, ready_rows: 1, failed_rows: 0, config_snapshot: { targetStoreId: "store-a" },
          config_hash: "a".repeat(64), idempotency_key: "job-import-1", correlation_id: "corr-import-1",
        }] };
        return { rows: [{
          row_id: "row-1", collect_item_id: "collect-1", account_id: "account-a",
          source: "SKU", source_sku: "7003", summary: {}, draft_id: null, draft_version: null,
          draft_data: null, raw_response_ref: "raw-1", raw_payload: { normalized: { title: "Product" } },
          payload_hash: "hash-1", collected_at: "2026-08-07T00:00:00.000Z",
        }] };
      },
    },
  });
  const result = await repository.loadExcelImportSources({ accountId: "account-a", importFileId: "import-1" });
  assert.equal(result.importFile.id, "import-1");
  assert.equal(result.sources[0].id, "row-1");
  assert.equal(result.sources[0].collectItemId, "collect-1");
  assert.match(calls[1].sql, /r\.status='READY'/u);
  assert.match(calls[1].sql, /r\.account_id=\$1/u);
  assert.match(calls[1].sql, /c\.account_id=r\.account_id/u);
  assert.deepEqual(calls[1].params, ["account-a", "import-1"]);
});

test("job creation locks and freezes the one enabled account AI profile without latest-profile inference", async () => {
  const { repository, calls, stop } = warehouseEvidenceFixture({
    stageInitialPlanWork: async () => ({ status: "PLANNING", statusVersion: 2 }),
  });
  await assert.rejects(repository.createJobGraph(warehouseGraph()), (error) => error === stop);

  const strategyIndex = calls.findIndex(({ sql }) => /FROM ai_content_strategy_versions/.test(sql));
  const profileIndex = calls.findIndex(({ sql }) => /FROM ai_gateway_profiles/.test(sql));
  const profileCall = calls[profileIndex];
  const insertCall = calls.find(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql));
  assert.ok(profileIndex > strategyIndex);
  assert.match(profileCall.sql, /SELECT\s+id,config_version\s+FROM ai_gateway_profiles/iu);
  assert.match(profileCall.sql, /WHERE account_id=\$1 AND enabled IS TRUE/iu);
  assert.match(profileCall.sql, /FOR SHARE/iu);
  assert.doesNotMatch(profileCall.sql, /ORDER\s+BY|LIMIT|latest|api_key/iu);
  assert.deepEqual(profileCall.params, ["account-a"]);
  assert.match(insertCall.sql, /strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,correlation_id/iu);
  assert.deepEqual(insertCall.params.slice(6), [
    "strategy-version-a", "upload-policy-review-a", "profile-a", 3, "account-a", "lock-evidence-correlation",
  ]);
});

test("job creation fails closed when the account has no enabled AI profile", async () => {
  const { repository, calls } = warehouseEvidenceFixture({
    profiles: [],
    stageInitialPlanWork: async () => ({ status: "PLANNING", statusVersion: 2 }),
  });
  await assert.rejects(
    repository.createJobGraph(warehouseGraph()),
    (error) => error?.code === "AUTO_LISTING_AI_PROFILE_NOT_CONFIGURED"
      && !/sql|select|profile-a/iu.test(error.message),
  );
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("job creation fails closed instead of guessing when multiple AI profiles are enabled", async () => {
  const { repository, calls } = warehouseEvidenceFixture({ profiles: [
    { id: "profile-a", config_version: 3 },
    { id: "profile-b", config_version: 8 },
  ], stageInitialPlanWork: async () => ({ status: "PLANNING", statusVersion: 2 }) });
  await assert.rejects(
    repository.createJobGraph(warehouseGraph()),
    (error) => error?.code === "AUTO_LISTING_AI_PROFILE_AMBIGUOUS"
      && !/sql|select|profile-a|profile-b/iu.test(error.message),
  );
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("idempotent job replay returns before profile selection and does not change frozen evidence", async () => {
  const calls = [];
  let stageCount = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: "job-existing" }] };
      }
      if (/SELECT id,account_id,source_type,status,strategy_version_id,correlation_id/.test(sql)) {
        return { rows: [{
          id: "job-existing", account_id: "account-a", source_type: "COLLECT_BOX", status: "CREATED",
          strategy_version_id: "strategy-version-a", correlation_id: "existing-correlation",
          created_at: new Date(0), updated_at: new Date(0),
        }] };
      }
      if (/FROM auto_listing_job_items i/.test(sql) || /FROM auto_listing_events/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const repository = createAutoListingRepository({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
    stageInitialPlanWork: async () => {
      stageCount += 1;
      return { status: "PLANNING", statusVersion: 2 };
    },
  });
  const result = await repository.createJobGraph(warehouseGraph());
  assert.equal(result.id, "job-existing");
  assert.equal(result.duplicate, true);
  assert.equal(calls.some(({ sql }) => /FROM ai_gateway_profiles/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql)), false);
  assert.equal(stageCount, 0);
});

function blockedSourceGraph() {
  const graph = warehouseGraph();
  const evidence = buildAutoListingBlockedSourceEvidence({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-reused-blocked", sourceVersion: "1",
    productDraft: { id: "draft-reused-blocked", version: 1 }, rawResponseRef: "raw-reused-blocked", rawResponseHash: "hash-reused-blocked",
    rawCollectedAt: "2026-08-04T00:00:00.000Z", failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  });
  graph.items = [{
    sourceType: "COLLECT_BOX", sourceRecordId: "collect-reused-blocked", sourceVersion: "1",
    blockedEvidence: evidence.blockedEvidence, snapshotHash: evidence.snapshotHash, rawResponseRef: evidence.rawResponseRef,
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", sourceOrder: 0,
    status: "BLOCKED", failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  }];
  return graph;
}

function mixedCreationGraph() {
  const graph = warehouseGraph({ itemCount: 2 });
  const blocked = blockedSourceGraph().items[0];
  graph.items.push({ ...blocked, sourceOrder: 2 });
  return graph;
}

function successfulCreationFixture({ stageBehavior = null, profiles = [{ id: "profile-a", config_version: 3 }] } = {}) {
  const calls = [];
  const stageCalls = [];
  const snapshots = new Map();
  const items = [];
  const events = [];
  let job = null;
  const counters = new Map();
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2 FOR UPDATE/.test(sql)) return { rows: [] };
      if (/FROM stores s/.test(sql) && /owner_account_id/.test(sql)) return { rows: [{
        id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A",
        client_id: "client-a", currency_code: "RUB", status: "active",
      }] };
      if (/FROM store_credentials/.test(sql)) return { rows: [{ store_id: "store-a" }] };
      if (/FROM warehouses w/.test(sql)) return { rows: [{
        id: "warehouse-a", store_id: "store-a", warehouse_id: "platform-a", name: "Warehouse A",
        warehouse_type: "FBS", status: "active", is_active: true, is_archived: false,
      }] };
      if (/FROM product_stocks ps/.test(sql)) return { rows: [{
        product_id: "product-a", product_store_id: "store-a", product_status: "active",
        product_is_archived: false, product_raw_is_archived: false, warehouse_id: "warehouse-a", source: "fbs",
      }] };
      if (/FROM ai_content_strategy_versions/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM auto_listing_upload_policy_versions/.test(sql)) return { rows: [{ id: "upload-policy-review-a" }] };
      if (/FROM ai_gateway_profiles/.test(sql)) return { rows: profiles };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/FROM collect_items c/.test(sql)) return { rows: [{
        draft_id: `draft-${params[0]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/INSERT INTO auto_listing_jobs/.test(sql)) {
        job = {
          id: params[0], account_id: params[1], source_type: params[2], status: "CREATED",
          strategy_version_id: params[6], correlation_id: params[11],
          created_at: new Date(0), updated_at: new Date(0),
        };
        return { rows: [] };
      }
      if (/INSERT INTO auto_listing_source_snapshots/.test(sql)) {
        const row = {
          id: params[0], source_record_id: params[3], source_version: params[4],
          snapshot: JSON.parse(params[5]), snapshot_hash: params[6], raw_response_ref: params[7],
        };
        snapshots.set(row.id, row);
        return { rows: [row] };
      }
      if (/INSERT INTO auto_listing_job_items/.test(sql)) {
        items.push({
          id: params[0], job_id: params[1], account_id: params[2], snapshot_id: params[3],
          target_store_id: params[4], target_warehouse_id: params[5], status: params[6],
          status_version: 1, failure_code: params[7], created_at: new Date(0), updated_at: new Date(0),
        });
        return { rows: [] };
      }
      if (/INSERT INTO auto_listing_listing_bases/.test(sql)) return { rows: [] };
      if (/INSERT INTO auto_listing_events/.test(sql)) {
        const created = /NULL,'CREATED','CREATED'/.test(sql);
        events.push(created ? {
          id: params[0], item_id: params[3], from_status: null, to_status: "CREATED",
          event_type: "CREATED", correlation_id: params[5], details: JSON.parse(params[6]), created_at: new Date(0),
        } : {
          id: params[0], item_id: params[3], from_status: "CREATED", to_status: params[5],
          event_type: params[6], correlation_id: params[7], details: JSON.parse(params[8]), created_at: new Date(0),
        });
        return { rows: [] };
      }
      if (/SELECT id,account_id,source_type,status,strategy_version_id,correlation_id/.test(sql)) return { rows: job ? [job] : [] };
      if (/FROM auto_listing_job_items i/.test(sql)) return { rows: items.map((item) => ({
        ...item,
        source_record_id: snapshots.get(item.snapshot_id).source_record_id,
        source_version: snapshots.get(item.snapshot_id).source_version,
        snapshot_hash: snapshots.get(item.snapshot_id).snapshot_hash,
      })) };
      if (/FROM auto_listing_events/.test(sql)) return { rows: events };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const stageInitialPlanWork = stageBehavior === null ? null : async (input) => {
    stageCalls.push(input);
    calls.push({ sql: "STAGE_INITIAL_PLAN_WORK", params: [input] });
    const outcome = await stageBehavior(input, stageCalls.length - 1);
    if (outcome?.status === "PLANNING" && outcome?.statusVersion === 2) {
      const item = items.find((candidate) => candidate.id === input.itemId);
      if (item) {
        item.status = "PLANNING";
        item.status_version = 2;
      }
    }
    return outcome;
  };
  const repository = createAutoListingRepository({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
    idFactory(prefix) {
      const count = (counters.get(prefix) || 0) + 1;
      counters.set(prefix, count);
      return `${prefix}-${count}`;
    },
    stageInitialPlanWork,
  });
  return { repository, calls, stageCalls, client };
}

test("successful creation without the AI workflow keeps ready statuses and stages no outbox work", async () => {
  const { repository, calls, stageCalls } = successfulCreationFixture();
  const created = await repository.createJobGraph(mixedCreationGraph());

  assert.deepEqual(created.items.map(({ status }) => status), ["SOURCE_READY", "SOURCE_READY", "BLOCKED"]);
  assert.equal(calls.some(({ sql }) => /FROM ai_gateway_profiles/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /auto_listing_ai_outbox/i.test(sql)), false);
  assert.equal(calls.filter(({ sql }) => /INSERT INTO auto_listing_listing_bases/.test(sql)).length, 2);
  assert.equal(stageCalls.length, 0);
  const jobInsert = calls.find(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql));
  assert.deepEqual(jobInsert.params.slice(7, 10), ["upload-policy-review-a", null, null]);
});

test("optional AI workflow stages every ready sibling after its original event and leaves blocked siblings untouched", async () => {
  const { repository, calls, stageCalls, client } = successfulCreationFixture({
    stageBehavior: async () => ({ status: "PLANNING", statusVersion: 2 }),
  });

  const created = await repository.createJobGraph(mixedCreationGraph());

  assert.deepEqual(created.items.map(({ status }) => status), ["PLANNING", "PLANNING", "BLOCKED"]);
  assert.equal(stageCalls.length, 2);
  assert.deepEqual(stageCalls.map((call) => ({ ...call, client: undefined })), [
    {
      client: undefined, accountId: "account-a", jobId: "auto_listing_job-1",
      itemId: "auto_listing_job-1_item_000", actorAccountId: "account-a",
      expectedStatusVersion: 1, correlationId: "lock-evidence-correlation",
    },
    {
      client: undefined, accountId: "account-a", jobId: "auto_listing_job-1",
      itemId: "auto_listing_job-1_item_001", actorAccountId: "account-a",
      expectedStatusVersion: 1, correlationId: "lock-evidence-correlation",
    },
  ]);
  assert.equal(stageCalls.every((call) => call.client === client), true);
  for (const stageCall of stageCalls) {
    assert.deepEqual(Object.keys(stageCall).sort(), [
      "accountId", "actorAccountId", "client", "correlationId", "expectedStatusVersion", "itemId", "jobId",
    ]);
    const stageIndex = calls.findIndex(({ sql, params }) => sql === "STAGE_INITIAL_PLAN_WORK" && params[0] === stageCall);
    const sourceEventIndex = calls.findIndex(({ sql, params }) => /INSERT INTO auto_listing_events/.test(sql)
      && params[0] === `${stageCall.itemId}_02`);
    const baseIndex = calls.findIndex(({ sql, params }) => /INSERT INTO auto_listing_listing_bases/.test(sql)
      && params[3] === stageCall.itemId);
    assert.ok(baseIndex > sourceEventIndex);
    assert.ok(stageIndex > baseIndex);
    assert.ok(stageIndex > sourceEventIndex);
  }
  assert.equal(stageCalls.some(({ itemId }) => itemId.endsWith("_002")), false);
});

test("a ready item without a complete listing-base template fails before connecting", async () => {
  const graph = warehouseGraph();
  delete graph.items[0].listingBaseTemplate;
  let connections = 0;
  const repository = createAutoListingRepository({ pool: {
    connect: async () => { connections += 1; throw new Error("must not connect"); },
    query: async () => ({ rows: [] }),
  } });
  await assert.rejects(repository.createJobGraph(graph), {
    code: "AUTO_LISTING_REPOSITORY_INVALID",
  });
  assert.equal(connections, 0);

  const forged = warehouseGraph();
  const forgedPrice = { currency: "RUB", blackKopecks: "9000", greenKopecks: "7000" };
  forged.items[0].listingBaseTemplate.pricingEvidence = {
    ...forgedPrice, evidenceHash: digest(forgedPrice),
  };
  await assert.rejects(repository.createJobGraph(forged), {
    code: "AUTO_LISTING_REPOSITORY_INVALID",
  });
  assert.equal(connections, 0);
});

test("a malformed initial AI stage outcome rolls the whole graph back", async () => {
  const hidden = { status: "PLANNING", statusVersion: 2 };
  Object.defineProperty(hidden, "accountId", { value: "account-b" });
  const symbolled = { status: "PLANNING", statusVersion: 2, [Symbol("scope")]: "account-b" };
  const accessor = {};
  Object.defineProperties(accessor, {
    status: { enumerable: true, get: () => "PLANNING" },
    statusVersion: { enumerable: true, get: () => 2 },
  });
  for (const malformed of [
    { status: "SOURCE_READY", statusVersion: 1 },
    { status: "PLANNING", statusVersion: 2, accountId: "account-b" },
    hidden,
    symbolled,
    accessor,
    null,
  ]) {
    const { repository, calls } = successfulCreationFixture({
      stageBehavior: async () => malformed,
    });
    await assert.rejects(
      repository.createJobGraph(warehouseGraph()),
      (error) => error?.code === "AUTO_LISTING_AI_INITIAL_STAGE_INVALID",
    );
    assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
    assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
  }
});

test("a later sibling stage failure rolls back earlier staged work in the same transaction", async () => {
  const stageFailure = Object.assign(new Error("safe stage failure"), { code: "AUTO_LISTING_STAGE_FAILED" });
  const { repository, calls, stageCalls } = successfulCreationFixture({
    stageBehavior: async (_input, index) => {
      if (index === 1) throw stageFailure;
      return { status: "PLANNING", statusVersion: 2 };
    },
  });
  await assert.rejects(repository.createJobGraph(mixedCreationGraph()), (error) => error === stageFailure);
  assert.equal(stageCalls.length, 2);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
});

function reusedEvidenceFixture({ graph, persistedSnapshot }) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2/.test(sql)) return { rows: [] };
      if (/FROM stores s/.test(sql) && /owner_account_id/.test(sql)) return { rows: [{
        id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A",
        client_id: "client-a", currency_code: "RUB", status: "active",
      }] };
      if (/FROM store_credentials/.test(sql)) return { rows: [{ store_id: "store-a" }] };
      if (/FROM warehouses w/.test(sql)) return { rows: [{
        id: "warehouse-a", store_id: "store-a", warehouse_id: "platform-a", warehouse_type: "FBS",
        status: "active", is_active: true, is_archived: false,
      }] };
      if (/FROM product_stocks ps/.test(sql)) return { rows: [{
        product_id: "product-a", product_store_id: "store-a", product_status: "active", product_is_archived: false,
        product_raw_is_archived: false, warehouse_id: "warehouse-a", source: "fbs",
      }] };
      if (/FROM ai_content_strategy_versions/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM auto_listing_upload_policy_versions/.test(sql)) return { rows: [{ id: "upload-policy-review-a" }] };
      if (/FROM ai_gateway_profiles/.test(sql)) return { rows: [{ id: "profile-a", config_version: 3 }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/FROM collect_items c/.test(sql)) return { rows: [{
        draft_id: `draft-${params[0]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/INSERT INTO auto_listing_jobs/.test(sql)) return { rows: [] };
      if (/INSERT INTO auto_listing_source_snapshots/.test(sql)) return { rows: [] };
      if (/SELECT id,snapshot,snapshot_hash,raw_response_ref FROM auto_listing_source_snapshots/.test(sql)) {
        return { rows: [persistedSnapshot] };
      }
      if (/INSERT INTO auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)) {
        throw new Error("reused evidence was linked");
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  return {
    calls,
    repository: createAutoListingRepository({ pool: { connect: async () => client, query: async () => ({ rows: [] }) } }),
  };
}

test("reused source evidence verifies canonical body, kind, and raw reference instead of trusting a copied hash", async () => {
  const complete = warehouseGraph();
  const blocked = blockedSourceGraph();
  const alternateComplete = structuredClone(complete.items[0].snapshot);
  alternateComplete.identity.brand = "Different frozen body";
  const cases = [
    {
      graph: complete,
      persistedSnapshot: {
        id: "reused-wrong-kind", snapshot: blocked.items[0].blockedEvidence,
        snapshot_hash: complete.items[0].snapshotHash, raw_response_ref: complete.items[0].rawResponseRef,
      },
    },
    {
      graph: complete,
      persistedSnapshot: {
        id: "reused-wrong-body", snapshot: alternateComplete,
        snapshot_hash: complete.items[0].snapshotHash, raw_response_ref: complete.items[0].rawResponseRef,
      },
    },
    {
      graph: complete,
      persistedSnapshot: {
        id: "reused-wrong-raw", snapshot: complete.items[0].snapshot,
        snapshot_hash: complete.items[0].snapshotHash, raw_response_ref: "raw-reused-wrong",
      },
    },
    {
      graph: blocked,
      persistedSnapshot: {
        id: "reused-blocked-wrong-kind", snapshot: complete.items[0].snapshot,
        snapshot_hash: blocked.items[0].snapshotHash, raw_response_ref: blocked.items[0].rawResponseRef,
      },
    },
  ];
  for (const { graph, persistedSnapshot } of cases) {
    const { repository, calls } = reusedEvidenceFixture({ graph, persistedSnapshot });
    await assert.rejects(repository.createJobGraph(graph), (error) => error?.code === "AUTO_LISTING_SOURCE_VERSION_CONFLICT");
    assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_job_items|INSERT INTO auto_listing_events/.test(sql)), false);
    assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  }
});

test("job creation locks scoped store, credential, warehouse, product, and stock evidence without selecting a secret", async () => {
  const { repository, calls, stop } = warehouseEvidenceFixture();
  await assert.rejects(repository.createJobGraph(warehouseGraph()), (error) => error === stop);

  const evidenceCalls = calls.filter(({ sql }) => /FROM (stores s|store_credentials|warehouses w|product_stocks ps)/.test(sql));
  assert.equal(evidenceCalls.length, 4);
  assert.match(evidenceCalls[0].sql, /FOR SHARE OF s/i);
  assert.match(evidenceCalls[1].sql, /FOR SHARE OF sc/i);
  assert.match(evidenceCalls[2].sql, /FOR SHARE OF w/i);
  assert.match(evidenceCalls[3].sql, /FOR SHARE OF p,ps/i);
  assert.match(evidenceCalls[3].sql, /ORDER BY p\.id ASC,ps\.source ASC/i);
  assert.equal(evidenceCalls.every(({ sql }) => !/encrypted_api_key|auth_tag|\biv\b/i.test(sql)), true);
  assert.equal(evidenceCalls.every(({ sql }) => !/LOCK TABLE/i.test(sql)), true);
  assert.deepEqual(evidenceCalls[0].params, ["store-a", "account-a"]);
  assert.deepEqual(evidenceCalls[1].params, ["store-a", "account-a"]);
  assert.deepEqual(evidenceCalls[2].params, ["warehouse-a", "store-a", "account-a"]);
  assert.deepEqual(evidenceCalls[3].params, ["warehouse-a", "store-a", "account-a"]);
});

test("locked target evidence rejects invalid store, credential, or active association before a job insert", async () => {
  for (const [{ store, credential, associations }, expectedCode] of [
    [{ store: { status: "disabled" } }, "TARGET_STORE_DISABLED"],
    [{ credential: false }, "TARGET_STORE_CREDENTIALS_REQUIRED"],
    [{ associations: false }, "LISTING_WAREHOUSE_NOT_ELIGIBLE"],
  ]) {
    const { repository, calls } = warehouseEvidenceFixture({ store, credential, associations });
    await assert.rejects(repository.createJobGraph(warehouseGraph()), (error) => error?.code === expectedCode);
    assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql)), false);
    assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  }
});

test("sibling items sharing a target lock and validate its evidence once", async () => {
  const { repository, calls, stop } = warehouseEvidenceFixture();
  await assert.rejects(repository.createJobGraph(warehouseGraph({ itemCount: 2 })), (error) => error === stop);
  assert.equal(calls.filter(({ sql }) => /FROM stores s/.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /FROM store_credentials/.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /FROM warehouses w/.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /FROM product_stocks ps/.test(sql)).length, 1);
});

test("repository accepts only canonical blocked-source evidence before connecting", async () => {
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 1, priceAdjustmentKopecks: "0",
  });
  const evidence = buildAutoListingBlockedSourceEvidence({
    accountId: "account-a", sourceType: "COLLECT_BOX", sourceRecordId: "collect-blocked", sourceVersion: "1",
    productDraft: { id: "draft-blocked", version: 1 }, rawResponseRef: "raw-blocked", rawResponseHash: "hash-blocked",
    rawCollectedAt: "2026-08-04T00:00:00.000Z", failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  });
  const graph = {
    accountId: "account-a", actorAccountId: "account-a", sourceType: "COLLECT_BOX", idempotencyKey: "blocked-source",
    correlationId: "corr", configSnapshot: config, configHash, strategyVersionId: "version-a",
    uploadPolicyVersionId: "upload-policy-review-a",
    items: [{
      sourceType: "COLLECT_BOX", sourceRecordId: "collect-blocked", sourceVersion: "1",
      blockedEvidence: evidence.blockedEvidence, snapshotHash: evidence.snapshotHash, rawResponseRef: evidence.rawResponseRef,
      targetStoreId: "store-a", targetWarehouseId: "warehouse-a", sourceOrder: 0,
      status: "BLOCKED", failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
    }],
  };
  let connections = 0;
  const connected = new Error("connected after graph validation");
  const repository = createAutoListingRepository({ pool: {
    connect: async () => { connections += 1; throw connected; }, query: async () => ({ rows: [] }),
  } });
  await assert.rejects(repository.createJobGraph(graph), (error) => error === connected);
  assert.equal(connections, 1);
  for (const item of [
    { ...graph.items[0], snapshot: { identity: "fake" } },
    { ...graph.items[0], failureCode: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED" },
    { ...graph.items[0], strategyId: "strategy-a" },
    { ...graph.items[0], price: { currency: "RUB" } },
    { ...graph.items[0], effectiveImageConfig: {} },
    { ...graph.items[0], status: "SOURCE_READY" },
  ]) {
    await assert.rejects(repository.createJobGraph({ ...graph, idempotencyKey: `invalid-${connections}`, items: [item] }), (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID");
    assert.equal(connections, 1);
  }
});

test("published upload-policy lookup ignores legacy rows and selects a newer complete policy", async () => {
  const calls = [];
  const legacy = {
    id: "policy-legacy", account_id: "account-a", version: 3, mode: "DIRECT", enabled: true,
    published_by: "account-a", published_at: new Date("2026-08-08T01:00:00.000Z"),
    publication_origin: null, publication_base_url: null, publication_prefix: null,
    publication_version: null, publication_policy_hash: null,
  };
  const complete = {
    id: "policy-complete", account_id: "account-a", version: 2, mode: "REVIEW", enabled: true,
    published_by: "account-a", published_at: new Date("2026-08-08T00:00:00.000Z"),
    publication_origin: "https://cdn.example.test", publication_base_url: "https://cdn.example.test/assets",
    publication_prefix: "assets", publication_version: "v1", publication_policy_hash: "a".repeat(64),
  };
  const queryRows = (rows) => rows
    .filter((row) => row.publication_origin && row.publication_base_url && row.publication_prefix
      && row.publication_version && /^[a-f0-9]{64}$/.test(row.publication_policy_hash || ""))
    .map((row) => ({ ...row }));
  const repository = createAutoListingRepository({ pool: {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: queryRows([legacy, complete]) };
    },
    async connect() { throw new Error("unused"); },
  } });
  const policies = await repository.loadPublishedUploadPolicies({ accountId: "account-a" });
  assert.deepEqual(policies.map((policy) => policy.id), ["policy-complete"]);
  const sql = calls[0].sql;
  for (const column of ["publication_origin", "publication_base_url", "publication_prefix", "publication_version"]) {
    assert.match(sql, new RegExp(`${column} IS NOT NULL`, "iu"));
  }
  assert.match(sql, /publication_policy_hash\s*~/iu);

  const legacyOnlyRepository = createAutoListingRepository({ pool: {
    async query() { return { rows: queryRows([legacy]) }; },
    async connect() { throw new Error("unused"); },
  } });
  assert.deepEqual(await legacyOnlyRepository.loadPublishedUploadPolicies({ accountId: "account-a" }), []);
});
