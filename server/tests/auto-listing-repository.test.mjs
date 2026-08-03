import assert from "node:assert/strict";
import test from "node:test";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { buildAutoListingBlockedSourceEvidence, buildAutoListingSourceSnapshot } from "../auto-listing-source-snapshot.mjs";

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
    items,
  };
}

function warehouseEvidenceFixture({ store = {}, credential = true, warehouse = {}, associations = true } = {}) {
  const calls = [];
  const stop = Object.assign(new Error("stop after evidence"), { code: "STOP_AFTER_EVIDENCE" });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2/.test(sql)) return { rows: [] };
      if (/FROM ai_content_strategy_versions/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/FROM collect_items/.test(sql)) return { rows: [{ ok: 1 }] };
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
    }),
  };
}

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
