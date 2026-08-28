import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createAutoListingRepository } from "../auto-listing-repository.mjs";
import { normalizeAndHashAutoListingConfig } from "../auto-listing-contract.mjs";
import { deriveEffectiveAutoListingImageConfig } from "../auto-listing-item-image-config.mjs";
import { calculateAutoListingPrice } from "../auto-listing-pricing.mjs";
import {
  buildAutoListingBlockedSourceEvidence,
  buildAutoListingSourceSnapshot,
  canonicalAutoListingSourceSnapshot,
} from "../auto-listing-source-snapshot.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function listingBaseTemplate(sourceRecordId, sourceOrder) {
  const price = { currency: "RUB", currencySource: "SOURCE", blackKopecks: "10000", greenKopecks: "8000" };
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

function categoryAuthority(collectItemId) {
  return {
    categoryEvidence: { id: `evidence-${collectItemId}`, accountId: "account-a",
      sourceDescriptionCategoryId: 123, sourceTypeId: 456, taxonomyScope: "OZON:DEFAULT" },
    sharedCategory: { id: "shared-123-456", accountId: "account-a", version: 1,
      evidenceId: `evidence-${collectItemId}`, status: "ACTIVE", source: "SOURCE_DIRECT",
      sourceDescriptionCategoryId: 123, sourceTypeId: 456, currentDescriptionCategoryId: 123,
      currentTypeId: 456, taxonomyScope: "OZON:DEFAULT", taxonomyFingerprint: null },
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

test("ordinary list ranks item rows before limit and filters unselected siblings while getJob keeps history", async () => {
  const calls = [];
  const jobs = {
    "job-new": { id: "job-new", account_id: "account-a", source_type: "COLLECT_BOX", status: "CREATED",
      strategy_version_id: "strategy-a", correlation_id: "corr-new",
      created_at: new Date("2026-08-12T02:00:00.000Z"), updated_at: new Date("2026-08-12T02:00:00.000Z") },
    "job-other-store": { id: "job-other-store", account_id: "account-a", source_type: "COLLECT_BOX", status: "CREATED",
      strategy_version_id: "strategy-a", correlation_id: "corr-other",
      created_at: new Date("2026-08-12T01:00:00.000Z"), updated_at: new Date("2026-08-12T01:00:00.000Z") },
  };
  const itemRows = {
    "job-new": [
      { id: "item-new-a", status: "SOURCE_READY", status_version: 1, target_store_id: "store-a",
        target_warehouse_id: "warehouse-a", source_record_id: "collect-a", source_version: "1",
        snapshot_hash: "hash-a", created_at: new Date(), updated_at: new Date(),
        progress_phase: "PLAN_CONTENT", progress_state: "PENDING", progress_attempts: 2,
        progress_updated_at: new Date("2026-08-14T01:02:03.000Z"),
        progress_next_retry_at: new Date("2026-08-14T01:03:03.000Z") },
      { id: "item-new-sibling", status: "SOURCE_READY", status_version: 1, target_store_id: "store-a",
        target_warehouse_id: "warehouse-a", source_record_id: "collect-b", source_version: "1",
        snapshot_hash: "hash-b", created_at: new Date(), updated_at: new Date() },
    ],
    "job-other-store": [{ id: "item-other-store", status: "SOURCE_READY", status_version: 1,
      target_store_id: "store-b", target_warehouse_id: "warehouse-b", source_record_id: "collect-a",
      source_version: "1", snapshot_hash: "hash-c", created_at: new Date(), updated_at: new Date() }],
  };
  const eventRows = {
    "job-new": [
      { id: "event-job", item_id: null, event_type: "JOB_CREATED", details: {}, created_at: new Date() },
      { id: "event-a", item_id: "item-new-a", event_type: "SOURCE_CAPTURED", details: {}, created_at: new Date() },
      { id: "event-sibling", item_id: "item-new-sibling", event_type: "SOURCE_CAPTURED", details: {}, created_at: new Date() },
    ],
    "job-other-store": [],
  };
  const pool = {
    async connect() { return pool; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/WITH ranked_items AS/.test(sql)) return { rows: [
        { job_id: "job-new", item_id: "item-new-a" },
        { job_id: "job-other-store", item_id: "item-other-store" },
      ] };
      if (/SELECT id,account_id,source_type,status,strategy_version_id/.test(sql)) {
        return { rows: jobs[params[0]] && params[1] === "account-a" ? [jobs[params[0]]] : [] };
      }
      if (/FROM auto_listing_job_items i/.test(sql)) {
        const selectedIds = Array.isArray(params[2]) ? new Set(params[2]) : null;
        return { rows: itemRows[params[0]].filter((row) => !selectedIds || selectedIds.has(row.id)) };
      }
      if (/FROM auto_listing_events/.test(sql)) {
        const selectedIds = Array.isArray(params[2]) ? new Set(params[2]) : null;
        return { rows: eventRows[params[0]].filter((row) => !selectedIds || row.item_id === null || selectedIds.has(row.item_id)) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const repository = createAutoListingRepository({ pool });
  const listed = await repository.listJobs({ accountId: "account-a", limit: 2 });
  assert.deepEqual(listed.map((job) => [job.id, job.items.map((item) => item.id)]), [
    ["job-new", ["item-new-a"]], ["job-other-store", ["item-other-store"]],
  ]);
  assert.deepEqual(listed[0].events.map((event) => event.id), ["event-job", "event-a"]);
  assert.deepEqual(listed[0].items[0].workflowProgress, {
    phase: "PLAN_CONTENT", state: "RETRY_WAIT", attemptCount: 2,
    updatedAt: new Date("2026-08-14T01:02:03.000Z"),
    nextRetryAt: new Date("2026-08-14T01:03:03.000Z"),
  });
  const ranked = calls.find(({ sql }) => /WITH ranked_items AS/.test(sql));
  assert.match(ranked.sql, /PARTITION BY snapshot\.source_record_id,item\.target_store_id/u);
  assert.match(ranked.sql, /ORDER BY job\.created_at DESC,job\.id DESC,item\.id ASC/u);
  assert.match(ranked.sql, /WHERE item_rank=1[\s\S]*LIMIT \$2/u);
  assert.deepEqual(ranked.params, ["account-a", 2]);
  assert.match(ranked.sql, /job\.account_id=\$1/u);
  assert.match(ranked.sql, /item\.account_id=job\.account_id/u);
  assert.match(ranked.sql, /snapshot\.account_id=job\.account_id/u);
  const itemRead = calls.find(({ sql }) => /FROM auto_listing_job_items i/.test(sql));
  assert.match(itemRead.sql, /LEFT JOIN LATERAL[\s\S]*?auto_listing_ai_outbox/u);
  assert.match(itemRead.sql, /progress\.account_id=\$2[\s\S]*?progress\.job_id=\$1[\s\S]*?progress\.item_id=i\.id/u);
  assert.match(itemRead.sql, /ORDER BY progress\.created_at DESC,progress\.id DESC[\s\S]*?LIMIT 1/u);

  const full = await repository.getJob({ accountId: "account-a", jobId: "job-new" });
  assert.deepEqual(full.items.map((item) => item.id), ["item-new-a", "item-new-sibling"]);
  assert.deepEqual(full.events.map((event) => event.id), ["event-job", "event-a", "event-sibling"]);
});

test("job reads project durable AI queue state in the existing item query", async () => {
  const calls = [];
  const createdAt = new Date("2026-08-28T01:00:00.000Z");
  const queueRows = [
    {
      id: "item-calling", status: "GENERATING", status_version: 4,
      target_store_id: "store-a", target_warehouse_id: "warehouse-a",
      source_record_id: "collect-calling", source_version: "1", snapshot_hash: "hash-calling",
      created_at: createdAt, updated_at: createdAt,
      ai_queue_state: "CALLING_AI", ai_channel_display_name: "主通道",
      ai_channel_switching: false, ai_channel_wait_started_at: null,
    },
    {
      id: "item-takeover", status: "PLANNING", status_version: 2,
      target_store_id: "store-a", target_warehouse_id: "warehouse-a",
      source_record_id: "collect-takeover", source_version: "1", snapshot_hash: "hash-takeover",
      created_at: createdAt, updated_at: createdAt,
      ai_queue_state: "WAITING_FOR_AI_CHANNEL", ai_channel_display_name: "备用通道",
      ai_channel_switching: false, ai_channel_wait_started_at: new Date("2026-08-28T01:01:00.000Z"),
    },
    {
      id: "item-switching", status: "GENERATING", status_version: 5,
      target_store_id: "store-a", target_warehouse_id: "warehouse-a",
      source_record_id: "collect-switching", source_version: "1", snapshot_hash: "hash-switching",
      created_at: createdAt, updated_at: createdAt,
      ai_queue_state: "SWITCHING_AI_CHANNEL", ai_channel_display_name: "故障通道",
      ai_channel_switching: true, ai_channel_wait_started_at: new Date("2026-08-28T01:02:00.000Z"),
    },
    {
      id: "item-waiting", status: "PLANNING", status_version: 3,
      target_store_id: "store-a", target_warehouse_id: "warehouse-a",
      source_record_id: "collect-waiting", source_version: "1", snapshot_hash: "hash-waiting",
      created_at: createdAt, updated_at: createdAt,
      ai_queue_state: "WAITING_FOR_AI_CHANNEL", ai_channel_display_name: null,
      ai_channel_switching: false, ai_channel_wait_started_at: new Date("2026-08-28T01:03:00.000Z"),
    },
    {
      id: "item-complete", status: "READY_FOR_REVIEW", status_version: 6,
      target_store_id: "store-a", target_warehouse_id: "warehouse-a",
      source_record_id: "collect-complete", source_version: "1", snapshot_hash: "hash-complete",
      created_at: createdAt, updated_at: createdAt,
      ai_queue_state: "CALLING_AI", ai_channel_display_name: "不得泄漏",
      ai_channel_switching: true, ai_channel_wait_started_at: createdAt,
    },
  ];
  const pool = {
    async connect() { return pool; },
    release() {},
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id,account_id,source_type,status,strategy_version_id/.test(sql)) return { rows: [{
        id: "job-queue", account_id: "account-a", source_type: "COLLECT_BOX", status: "CREATED",
        strategy_version_id: "strategy-a", correlation_id: "corr-queue",
        created_at: createdAt, updated_at: createdAt,
      }] };
      if (/FROM auto_listing_job_items i/.test(sql)) return { rows: queueRows };
      if (/FROM auto_listing_events/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const job = await createAutoListingRepository({ pool }).getJob({ accountId: "account-a", jobId: "job-queue" });

  assert.deepEqual(job.items.map((item) => ({
    id: item.id,
    aiQueueState: item.aiQueueState,
    aiChannelDisplayName: item.aiChannelDisplayName,
    aiChannelSwitching: item.aiChannelSwitching,
    aiChannelWaitStartedAt: item.aiChannelWaitStartedAt,
  })), [
    { id: "item-calling", aiQueueState: "CALLING_AI", aiChannelDisplayName: "主通道", aiChannelSwitching: false, aiChannelWaitStartedAt: null },
    { id: "item-takeover", aiQueueState: "WAITING_FOR_AI_CHANNEL", aiChannelDisplayName: "备用通道", aiChannelSwitching: false, aiChannelWaitStartedAt: new Date("2026-08-28T01:01:00.000Z") },
    { id: "item-switching", aiQueueState: "SWITCHING_AI_CHANNEL", aiChannelDisplayName: "故障通道", aiChannelSwitching: true, aiChannelWaitStartedAt: new Date("2026-08-28T01:02:00.000Z") },
    { id: "item-waiting", aiQueueState: "WAITING_FOR_AI_CHANNEL", aiChannelDisplayName: null, aiChannelSwitching: false, aiChannelWaitStartedAt: new Date("2026-08-28T01:03:00.000Z") },
    { id: "item-complete", aiQueueState: null, aiChannelDisplayName: null, aiChannelSwitching: false, aiChannelWaitStartedAt: null },
  ]);
  const itemReads = calls.filter(({ sql }) => /FROM auto_listing_job_items i/.test(sql));
  assert.equal(itemReads.length, 1);
  assert.match(itemReads[0].sql, /LEFT JOIN LATERAL[\s\S]*auto_listing_ai_outbox AS ai_queue/u);
  assert.match(itemReads[0].sql, /auto_listing_ai_profile_channels AS assigned_channel/u);
  assert.match(itemReads[0].sql, /auto_listing_ai_profile_channels AS available_channel/u);
  assert.match(itemReads[0].sql, /ai_queue\.expected_status_version=i\.status_version/u);
  assert.match(itemReads[0].sql, /WHEN live_execution\.outbox_id IS NOT NULL THEN 'CALLING_AI'[\s\S]*WHEN latest_failure\.outbox_id IS NOT NULL THEN 'SWITCHING_AI_CHANNEL'[\s\S]*runnable_queue\.assignment_exact IS TRUE THEN 'WAITING_FOR_AI_CHANNEL'/u);
  assert.match(itemReads[0].sql, /auto_listing_ai_outbox AS live_queue[\s\S]*live_queue\.state='PROCESSING'[\s\S]*\) live_execution ON TRUE/u);
  assert.match(itemReads[0].sql, /live_channel\.execution_lease_owner=live_queue\.lease_owner[\s\S]*live_channel\.execution_lease_token=live_queue\.lease_token[\s\S]*live_channel\.execution_lease_expires_at=live_queue\.lease_expires_at[\s\S]*live_channel\.execution_lease_expires_at>NOW\(\)/u);
  assert.match(itemReads[0].sql, /auto_listing_ai_outbox AS failed_queue[\s\S]*failed_queue\.state='PENDING'[\s\S]*failed_queue\.last_error_code IN \([\s\S]*ORDER BY failed_queue\.updated_at DESC,failed_queue\.created_at DESC,failed_queue\.id DESC[\s\S]*\) latest_failure ON TRUE/u);
  assert.match(itemReads[0].sql, /ORDER BY CASE WHEN available_channel\.fixed THEN 0 ELSE 1 END,[\s\S]*COALESCE\(ai_queue\.next_retry_at,ai_queue\.available_at\)[\s\S]*ai_queue\.created_at,ai_queue\.id[\s\S]*\) runnable_queue ON TRUE/u);
});

function warehouseGraph({ itemCount = 1, priceMultiplierMicros, useCategoryStrategy } = {}) {
  const { config, configHash } = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 1,
    priceAdjustmentKopecks: "0",
    ...(priceMultiplierMicros ? { priceMultiplierMicros } : {}),
    ...(useCategoryStrategy === undefined ? {} : { useCategoryStrategy }),
  });
  const items = Array.from({ length: itemCount }, (_, sourceIndex) => {
    const sourceOrder = sourceIndex + 1;
    const sourceRecordId = `collect-lock-${sourceOrder}`;
    const captured = buildAutoListingSourceSnapshot({
      accountId: "account-a",
      sourceType: "COLLECT_BOX",
      planningContract: "LEGACY_FULL_PLAN_V3",
      sourceRecordId,
      sourceVersion: "1",
      targetStoreId: "store-a",
      targetStoreCurrency: "RUB",
      rawResponseRef: `raw-lock-${sourceOrder}`,
      rawResponseHash: `hash-lock-${sourceOrder}`,
      productDraft: { id: `draft-${sourceRecordId}`, version: 1 },
      ...categoryAuthority(sourceRecordId),
      collectItem: {
        id: sourceRecordId,
        accountId: "account-a",
        sku: `SKU-${sourceOrder}`,
        listingDraft: {
          sku: `SKU-${sourceOrder}`,
          offerId: `offer-lock-${sourceOrder}`,
          title: sourceOrder === 1 ? "商品一" : `商品${sourceOrder}`,
          currency: "RUB",
          blackKopecks: "10000",
          greenKopecks: "8000",
          images: [`https://source.example.test/${sourceOrder === 1 ? "one" : sourceOrder}.jpg`],
          productMeasurements: { reliable: true, length: 28, unit: "cm", source: "manufacturer" },
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
      planningContract: "LEGACY_FULL_PLAN_V3",
      strategyId: "strategy-a",
      strategyVersionId: "strategy-version-a",
      ruleId: null,
      style: "BALANCED_DEFAULT",
      matchedBy: "DEFAULT",
      price: priceMultiplierMicros ? calculateAutoListingPrice({
        currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", adjustmentKopecks: "0", priceMultiplierMicros,
      }) : {
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
    categoryPreparationLeaseId: "category-lease-a",
    sourceType: "COLLECT_BOX",
    idempotencyKey: "lock-evidence-key",
    correlationId: "lock-evidence-correlation",
    configSnapshot: config,
    configHash,
    strategyVersionId: "strategy-version-a",
    uploadPolicyVersionId: "upload-policy-review-a",
    warehouseValidation: null,
    items,
  };
}

function rfbsWarehouseValidation(overrides = {}) {
  const { evidenceHash: overriddenHash, ...normalizedOverrides } = overrides;
  const normalized = {
    schemaVersion: "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1",
    accountId: "account-a",
    storeId: "store-a",
    warehouseRecordId: "warehouse-a",
    platformWarehouseId: "platform-a",
    fulfillmentType: "RFBS",
    status: "ACTIVE",
    outcome: "PASSED",
    observedAt: "2026-08-11T04:00:00.000Z",
    expiresAt: "2099-08-11T04:10:00.000Z",
    correlationId: "lock-evidence-correlation",
    actorAccountId: "account-a",
    ...normalizedOverrides,
  };
  return { ...normalized, evidenceHash: overriddenHash
    || crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

function excelWarehouseGraph() {
  const graph = warehouseGraph();
  const collectItemId = "collect-lock-0";
  const sourceRecordId = "row-lock-0";
  const captured = buildAutoListingSourceSnapshot({
    accountId: "account-a", sourceType: "EXCEL_SKU", sourceRecordId, collectItemId,
    targetStoreId: "store-a", targetStoreCurrency: "RUB",
    sourceVersion: "1", rawResponseRef: "raw-lock-0", rawResponseHash: "hash-lock-0",
    productDraft: { id: "draft-collect-lock-0", version: 1 },
    ...categoryAuthority(collectItemId),
    collectItem: {
      id: collectItemId, accountId: "account-a", sku: "sku-lock-0",
      listingDraft: {
        sku: "sku-lock-0", offerId: "offer-lock-0", title: "Locked evidence product",
        currency: "RUB", blackKopecks: "10000", greenKopecks: "8000", images: [],
        productMeasurements: { reliable: true, length: 28, unit: "cm", source: "manufacturer" },
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
    snapshot: captured.snapshot, snapshotHash: captured.snapshotHash, rawResponseRef: captured.rawResponseRef,
    listingBaseTemplate: listingBaseTemplate(collectItemId, 1),
    effectiveImageConfig: deriveEffectiveAutoListingImageConfig({
      configSnapshot: graph.configSnapshot, configHash: graph.configHash, sourceCapture: captured,
    }),
  }];
  return graph;
}

function warehouseEvidenceFixture({
  store = {}, credential = true, warehouse = {}, associations = true,
  profiles = [{ id: "profile-a", config_version: 3 }],
  catalog = null,
  stageInitialPlanWork = null,
  categoryFence = true,
} = {}) {
  const calls = [];
  const stop = Object.assign(new Error("stop after evidence"), { code: "STOP_AFTER_EVIDENCE" });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2/.test(sql)) return { rows: [] };
      if (/auto-listing-category-graph-lock-keys/u.test(sql)) return { rows: params[1].map((id, index) => ({ shared_category_id: id, lock_key: String(index + 1) })) };
      if (/pg_try_advisory_xact_lock_shared/u.test(sql)) return { rows: [{ locked: true }] };
      if (/auto-listing-category-graph-lease-active/u.test(sql)) return { rows: [{ id: "category-lease-a" }] };
      if (/FROM accounts WHERE id=\$1 FOR UPDATE/.test(sql)) return { rows: [{ id: "account-a" }] };
      if (/FROM ai_content_strategy_versions/.test(sql)) return { rows: [{ strategy_key: "strategy-a" }] };
      if (/FROM auto_listing_upload_policy_versions/.test(sql)) return { rows: [{ id: "upload-policy-review-a" }] };
      if (/FROM ai_gateway_profiles/.test(sql)) return { rows: profiles };
      if (/FROM ai_gateway_model_catalogs/.test(sql)) return { rows: catalog === null ? [] : [{ catalog }] };
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: [] };
      if (/FROM collect_ozon_category_current_sources current_category/.test(sql)) {
        return { rows: categoryFence ? [{ id: "shared-123-456" }] : [] };
      }
      if (/FROM auto_listing_import_rows/.test(sql)) return { rows: [{
        draft_id: `draft-${params[1]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/FROM collect_items c/.test(sql)) return { rows: [{
        draft_id: `draft-${params[0]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/FROM stores s/.test(sql) && /owner_account_id/.test(sql)) return { rows: [{
        id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A",
        client_id: "client-a", currency_code: "RUB", currency_source: "OZON_SELLER_INFO",
        currency_synced_at: "2026-08-13T00:00:00.000Z", status: "active", ...store,
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
      if (/INSERT INTO auto_listing_rfbs_warehouse_evidence/.test(sql)) return { rows: [{ id: params[0] }] };
      if (/INSERT INTO audit_events/.test(sql)) return { rows: [] };
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
  assert.match(insertCall.sql, /strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,\s*correlation_id,warehouse_validation_evidence_id/iu);
  assert.deepEqual(insertCall.params.slice(6), [
    "strategy-version-a", "upload-policy-review-a", null, null, "account-a", "lock-evidence-correlation", null,
    "category-lease-a",
  ]);
  const policyCall = calls.find(({ sql }) => /FROM auto_listing_upload_policy_versions/.test(sql));
  assert.match(policyCall.sql, /publication_origin IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_base_url IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_prefix IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_version IS NOT NULL/iu);
  assert.match(policyCall.sql, /publication_policy_hash ~ '\^\[a-f0-9\]\{64\}\$'/iu);
});

test("RFBS creation inserts exact normalized evidence, audit, and job binding in one transaction", async () => {
  const input = warehouseGraph();
  input.warehouseValidation = rfbsWarehouseValidation();
  const { repository, calls, stop } = warehouseEvidenceFixture({
    warehouse: { warehouse_type: "RFBS" }, associations: false,
  });
  await assert.rejects(repository.createJobGraph(input), (error) => error === stop);

  const evidenceIndex = calls.findIndex(({ sql }) => /INSERT INTO auto_listing_rfbs_warehouse_evidence/.test(sql));
  const auditIndex = calls.findIndex(({ sql }) => /INSERT INTO audit_events/.test(sql));
  const jobIndex = calls.findIndex(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql));
  assert.ok(evidenceIndex > 0 && auditIndex > evidenceIndex && jobIndex > auditIndex);
  const evidence = calls[evidenceIndex];
  assert.deepEqual(evidence.params.slice(1), [
    "account-a", "store-a", "warehouse-a", "platform-a",
    "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1", "RFBS", "ACTIVE", "PASSED",
    "2026-08-11T04:00:00.000Z", "2099-08-11T04:10:00.000Z",
    input.warehouseValidation.evidenceHash, "lock-evidence-correlation", "account-a", null,
  ]);
  assert.equal(calls[jobIndex].params.at(-2), evidence.params[0]);
  assert.equal(calls[jobIndex].params.at(-1), "category-lease-a");
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("malformed or cross-scope RFBS warehouse evidence fails before a database connection", async () => {
  let connections = 0;
  const repository = createAutoListingRepository({ pool: {
    connect: async () => { connections += 1; throw new Error("must not connect"); },
    query: async () => ({ rows: [] }),
  } });
  for (const evidence of [
    rfbsWarehouseValidation({ accountId: "account-b" }),
    rfbsWarehouseValidation({ storeId: "store-b" }),
    rfbsWarehouseValidation({ warehouseRecordId: "warehouse-b" }),
    rfbsWarehouseValidation({ outcome: "FAILED" }),
    rfbsWarehouseValidation({ fulfillmentType: "FBS" }),
    rfbsWarehouseValidation({ evidenceHash: "0".repeat(64) }),
    { ...rfbsWarehouseValidation(), extra: "open-contract" },
  ]) {
    const input = warehouseGraph();
    input.warehouseValidation = evidence;
    await assert.rejects(repository.createJobGraph(input), { code: "AUTO_LISTING_REPOSITORY_INVALID" });
  }
  assert.equal(connections, 0);
});

test("RFBS evidence platform identity is compared with the locked local warehouse before writes", async () => {
  const input = warehouseGraph();
  input.warehouseValidation = rfbsWarehouseValidation({ platformWarehouseId: "platform-b" });
  const { repository, calls } = warehouseEvidenceFixture({ warehouse: { warehouse_type: "RFBS" }, associations: false });
  await assert.rejects(repository.createJobGraph(input), (error) => error?.code === "LISTING_WAREHOUSE_NOT_ELIGIBLE"
    && error?.body?.reason === "RFBS_VALIDATION_REQUIRED");
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_rfbs_warehouse_evidence|INSERT INTO auto_listing_jobs/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
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
          evidence_id: "evidence-1", evidence_account_id: "account-a",
          source_description_category_id: 123, source_type_id: 456, taxonomy_scope: "OZON:DEFAULT",
          shared_category_id: "shared-a", shared_category_account_id: "account-a",
          shared_category_version: 1, shared_category_evidence_id: "evidence-1",
          shared_category_status: "ACTIVE", shared_category_source: "SOURCE_DIRECT",
          current_description_category_id: 123, current_type_id: 456, taxonomy_fingerprint: null,
        }] };
      },
    },
  });
  const result = await repository.loadExcelImportSources({ accountId: "account-a", importFileId: "import-1" });
  assert.equal(result.importFile.id, "import-1");
  assert.equal(result.sources[0].id, "row-1");
  assert.equal(result.sources[0].collectItemId, "collect-1");
  assert.equal(
    result.sources[0].sourceVersion,
    "raw:hash-1:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
  );
  assert.match(calls[1].sql, /r\.status='READY'/u);
  assert.match(calls[1].sql, /r\.account_id=\$1/u);
  assert.match(calls[1].sql, /c\.account_id=r\.account_id/u);
  assert.deepEqual(calls[1].params, ["account-a", "import-1"]);
});

test("loads Excel replay context without category, draft, collect, or ready-row joins", async () => {
  const calls = [];
  const repository = createAutoListingRepository({ pool: {
    connect: async () => assert.fail("lightweight replay header must not transact"),
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{
        id: "import-1", account_id: "account-a", status: "COLLECTING", status_version: 2,
        accepted_rows: 1, ready_rows: 1, failed_rows: 0,
        config_snapshot: { targetStoreId: "store-a" }, config_hash: "a".repeat(64),
        idempotency_key: "job-import-1", correlation_id: "corr-import-1",
      }] };
    },
  } });

  const file = await repository.loadExcelImportContext({ accountId: "account-a", importFileId: "import-1" });
  assert.equal(file.idempotencyKey, "job-import-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM auto_listing_import_files/u);
  assert.doesNotMatch(calls[0].sql, /collect_|product_drafts|category|auto_listing_import_rows/iu);
  assert.deepEqual(calls[0].params, ["account-a", "import-1"]);
});

test("category preparation lease uses one dedicated PostgreSQL session, sorted advisory locks, and bounded audit evidence", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/pg_backend_pid/u.test(sql)) return { rows: [{ pid: 4242, backend_started_at: "2026-08-12 00:00:00.123456+00" }] };
      if (/account_ozon_shared_category_lease_key/u.test(sql) && !/pg_advisory_lock/u.test(sql)) {
        return { rows: [{ collect_item_id: params[1], shared_category_id: params[3], lock_key: params[3] === "shared-b" ? "2" : "1" }] };
      }
      if (/pg_advisory_lock/u.test(sql)) return { rows: [{ locked: null }] };
      if (/auto-listing-category-preparation-lease-fence/u.test(sql)) return { rows: [{ collect_item_id: params[1] }] };
      if (/UPDATE auto_listing_category_preparation_leases/u.test(sql)) {
        return { rows: [{ id: "lease-a", state: "RELEASED", outcome: params[3],
          finalized_job_id: null, replayed_job_id: null }] };
      }
      return { rows: [] };
    },
    release(error) { calls.push({ sql: "RELEASE", error }); },
  };
  const repository = createAutoListingRepository({
    pool: { connect: async () => client, query: async (sql, params) => client.query(sql, params) },
    idFactory: () => "lease-a",
    categoryLeaseWaitTimeoutMs: 100,
    categoryLeaseHoldTimeoutMs: 10_000,
  });
  const item = (collectItemId, sharedCategoryId) => ({
    collectItemId, evidenceId: `evidence-${collectItemId}`, sharedCategoryId,
    sharedCategoryVersion: 7, sourceDescriptionCategoryId: 123, sourceTypeId: 456,
    descriptionCategoryId: 789, typeId: 999, taxonomyScope: "OZON:DEFAULT",
    taxonomyFingerprint: "", provenance: "MANUAL",
  });

  const lease = await repository.acquireCategoryPreparationLease({
    accountId: "account-a", items: [item("collect-b", "shared-b"), item("collect-a", "shared-a")],
  });
  assert.equal(lease.leaseId, "lease-a");
  const lockCalls = calls.filter(({ sql }) => /pg_advisory_lock/u.test(sql));
  assert.deepEqual(lockCalls.map(({ params }) => params[0]), ["1", "2"]);
  assert.equal(calls.filter(({ sql }) => /auto-listing-category-preparation-lease-fence/u.test(sql)).length, 2);
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_category_preparation_leases/u.test(sql)), true);
  await repository.releaseCategoryPreparationLease({
    accountId: "account-a", leaseId: lease.leaseId, outcome: "FAILED",
  });
  assert.equal(calls.some(({ sql }) => /pg_advisory_unlock_all/u.test(sql)), true);
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("category lease release is persistently idempotent only for the exact replay outcome and job", async () => {
  const calls = [];
  let terminal = null;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/pg_backend_pid/u.test(sql)) return { rows: [{ pid: 4242, backend_started_at: "2026-08-12 00:00:00.123456+00" }] };
      if (/account_ozon_shared_category_lease_key/u.test(sql) && !/pg_advisory_lock/u.test(sql)) {
        return { rows: [{ collect_item_id: params[1], shared_category_id: params[3], lock_key: "1" }] };
      }
      if (/pg_advisory_lock/u.test(sql)) return { rows: [{ locked: null }] };
      if (/auto-listing-category-preparation-lease-fence/u.test(sql)) return { rows: [{ id: "shared-a" }] };
      if (/UPDATE auto_listing_category_preparation_leases/u.test(sql)) {
        terminal = { state: "RELEASED", outcome: params[3], replayed_job_id: params[4] || null,
          finalized_job_id: null };
        return { rows: [{ id: "lease-a", ...terminal }] };
      }
      return { rows: [] };
    },
    release() {}, on() {}, off() {},
  };
  const pool = {
    connect: async () => client,
    async query(sql) {
      calls.push({ sql: String(sql), params: [] });
      return { rows: terminal ? [{ id: "lease-a", ...terminal }] : [] };
    },
  };
  const repository = createAutoListingRepository({ pool, idFactory: () => "lease-a" });
  await repository.acquireCategoryPreparationLease({ accountId: "account-a", items: [{
    collectItemId: "collect-a", evidenceId: "evidence-a", sharedCategoryId: "shared-a",
    sharedCategoryVersion: 1, sourceDescriptionCategoryId: 123, sourceTypeId: 456,
    descriptionCategoryId: 789, typeId: 999, taxonomyScope: "OZON:DEFAULT",
    taxonomyFingerprint: "", provenance: "MANUAL",
  }] });
  const exact = { accountId: "account-a", leaseId: "lease-a", outcome: "REPLAYED", jobId: "winner-job" };
  await repository.releaseCategoryPreparationLease(exact);
  await assert.doesNotReject(repository.releaseCategoryPreparationLease(exact));
  await assert.rejects(repository.releaseCategoryPreparationLease({ ...exact, outcome: "COMMITTED" }), {
    code: "AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE",
  });
  await assert.rejects(repository.releaseCategoryPreparationLease({ ...exact, jobId: "other-job" }), {
    code: "AUTO_LISTING_CATEGORY_LEASE_NOT_ACTIVE",
  });
  assert.equal(terminal.outcome, "REPLAYED");
  assert.equal(terminal.replayed_job_id, "winner-job");
});

test("loads Collect Box source rows with versioned draft and raw identities", async () => {
  const repository = createAutoListingRepository({
    pool: {
      connect: async () => assert.fail("read path must not open a transaction"),
      async query() {
        return { rows: [
          {
            id: "collect-draft", account_id: "account-a", source: "SKU", source_sku: "7001", summary: {},
            draft_id: "draft-1", draft_version: 7, draft_data: {}, raw_response_ref: "raw-draft",
            raw_payload: { normalized: {} }, payload_hash: "payload-draft", collected_at: "2026-08-07T00:00:00.000Z",
            evidence_id: "evidence-draft", evidence_account_id: "account-a", source_description_category_id: 123,
            source_type_id: 456, taxonomy_scope: "OZON:DEFAULT", shared_category_id: "shared-a",
            shared_category_account_id: "account-a", shared_category_version: 2, shared_category_evidence_id: "evidence-draft",
            shared_category_status: "ACTIVE", shared_category_source: "SOURCE_DIRECT",
            current_description_category_id: 123, current_type_id: 456, taxonomy_fingerprint: null,
          },
          {
            id: "collect-raw", account_id: "account-a", source: "SKU", source_sku: "7002", summary: {},
            draft_id: null, draft_version: null, draft_data: null, raw_response_ref: "raw-raw",
            raw_payload: { normalized: {} }, payload_hash: "payload-raw", collected_at: "2026-08-07T00:00:00.000Z",
            evidence_id: "evidence-raw", evidence_account_id: "account-a", source_description_category_id: 123,
            source_type_id: 456, taxonomy_scope: "OZON:DEFAULT", shared_category_id: "shared-a",
            shared_category_account_id: "account-a", shared_category_version: 2, shared_category_evidence_id: "evidence-raw",
            shared_category_status: "ACTIVE", shared_category_source: "SOURCE_DIRECT",
            current_description_category_id: 123, current_type_id: 456, taxonomy_fingerprint: null,
          },
        ] };
      },
    },
  });

  const result = await repository.loadCollectSources({
    accountId: "account-a", collectItemIds: ["collect-draft", "collect-raw"],
  });

  assert.deepEqual(result.map(({ sourceVersion }) => sourceVersion), [
    "draft:7:payload-draft:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
    "raw:payload-raw:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
  ]);
  assert.deepEqual(result.map((entry) => entry.sharedCategory.version), [2, 2]);
});

test("Collect Box category source query is account scoped, store independent, and fail closed", async () => {
  const calls = [];
  const repository = createAutoListingRepository({ pool: {
    connect: async () => assert.fail("read path must not transact"),
    async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
  } });
  assert.deepEqual(await repository.loadCollectSources({ accountId: "account-a", collectItemIds: ["collect-a"] }), []);
  assert.match(calls[0].sql, /collect_ozon_category_current_sources/);
  assert.match(calls[0].sql, /account_ozon_shared_categories/);
  assert.match(calls[0].sql, /shared\.status='ACTIVE'/);
  assert.match(calls[0].sql, /shared\.account_id=c\.account_id/);
  assert.match(calls[0].sql, /evidence\.id=current_category\.source_evidence_id/);
  assert.match(calls[0].sql, /evidence\.source_kind=current_category\.source_kind/);
  assert.match(calls[0].sql, /evidence\.source_record_id=current_category\.source_record_id/);
  assert.match(calls[0].sql, /evidence\.source_version=current_category\.source_version/);
  assert.match(calls[0].sql, /shared\.source_description_category_id=evidence\.source_description_category_id/);
  assert.match(calls[0].sql, /shared\.source_type_id=evidence\.source_type_id/);
  assert.match(calls[0].sql, /shared\.taxonomy_scope=evidence\.taxonomy_scope/);
  assert.doesNotMatch(calls[0].sql, /target_store|store_id/i);
  assert.deepEqual(calls[0].params, ["account-a", ["collect-a"]]);
});

test("Collect Box source mapping rejects foreign, incomplete, and non-active category authority", async () => {
  const valid = {
    id: "collect-a", account_id: "account-a", source: "SKU", source_sku: "7001", summary: {},
    draft_id: null, draft_version: null, draft_data: null, raw_response_ref: "raw-a",
    raw_payload: { normalized: {} }, payload_hash: "payload-a", collected_at: "2026-08-07T00:00:00.000Z",
    evidence_id: "evidence-a", evidence_account_id: "account-a", source_description_category_id: 123,
    source_type_id: 456, taxonomy_scope: "OZON:DEFAULT", shared_category_id: "shared-a",
    shared_category_account_id: "account-a", shared_category_version: 1,
    shared_category_evidence_id: "evidence-a", shared_category_status: "ACTIVE",
    shared_category_source: "SOURCE_DIRECT", current_description_category_id: 123,
    current_type_id: 456, taxonomy_fingerprint: null,
  };
  for (const override of [
    { evidence_account_id: "account-b" },
    { shared_category_account_id: "account-b" },
    { evidence_id: null },
    { shared_category_version: null },
    { shared_category_status: "INVALIDATED" },
    { shared_category_status: "NEEDS_REVIEW" },
  ]) {
    const repository = createAutoListingRepository({ pool: {
      connect: async () => assert.fail("read path must not transact"),
      query: async () => ({ rows: [{ ...valid, ...override }] }),
    } });
    await assert.rejects(repository.loadCollectSources({ accountId: "account-a", collectItemIds: ["collect-a"] }), {
      code: "AUTO_LISTING_SOURCE_CATEGORY_REQUIRED",
    });
  }
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
  assert.match(profileCall.sql, /SELECT\s+id,config_version,connection_id,connection_version,text_model,image_model\s+FROM ai_gateway_profiles/iu);
  assert.match(profileCall.sql, /WHERE account_id=\$1 AND enabled IS TRUE/iu);
  assert.match(profileCall.sql, /FOR SHARE/iu);
  assert.doesNotMatch(profileCall.sql, /ORDER\s+BY|LIMIT|latest|api_key/iu);
  assert.deepEqual(profileCall.params, ["account-a"]);
  assert.match(insertCall.sql, /strategy_version_id,upload_policy_version_id,ai_profile_id,ai_profile_version,created_by,\s*correlation_id,warehouse_validation_evidence_id/iu);
  assert.deepEqual(insertCall.params.slice(6), [
    "strategy-version-a", "upload-policy-review-a", "profile-a", 3, "account-a", "lock-evidence-correlation", null,
    "category-lease-a",
  ]);
});

test("shared category version change before graph commit conflicts with zero paid or graph side effects", async () => {
  let paidStages = 0;
  const { repository, calls } = warehouseEvidenceFixture({
    categoryFence: false,
    stageInitialPlanWork: async () => { paidStages += 1; return { status: "PLANNING", statusVersion: 2 }; },
  });
  await assert.rejects(repository.createJobGraph(warehouseGraph()), {
    code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT",
  });
  assert.equal(paidStages, 0);
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_jobs|INSERT INTO auto_listing_source_snapshots/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("graph preflight rejects every ozon-ready variant whose category differs from its V2 snapshot", async () => {
  const graph = warehouseGraph();
  const second = structuredClone(graph.items[0].listingBaseTemplate.variants[0]);
  second.sourceVariantId = "variant-second";
  second.sourceSku = "sku-second";
  second.item.offer_id = "offer-second";
  second.item.description_category_id = 789;
  second.item.type_id = 999;
  graph.items[0].listingBaseTemplate.variants.push(second);
  let connections = 0;
  const repository = createAutoListingRepository({ pool: {
    async connect() { connections += 1; throw new Error("must reject before connect"); },
    query: async () => ({ rows: [] }),
  } });

  await assert.rejects(repository.createJobGraph(graph), { code: "AUTO_LISTING_REPOSITORY_INVALID" });
  assert.equal(connections, 0);
});

test("new jobs accept a connection-backed profile only when its latest successful catalog still contains both frozen models", async () => {
  const { repository, calls, stop } = warehouseEvidenceFixture({
    profiles: [{
      id: "profile-connected", config_version: 1, connection_id: "connection-a", connection_version: 1,
      text_model: "text-model-a", image_model: "image-model-a",
    }],
    catalog: { models: [{ id: "image-model-a" }, { id: "text-model-a" }] },
    stageInitialPlanWork: async () => ({ status: "PLANNING", statusVersion: 2 }),
  });
  await assert.rejects(repository.createJobGraph(warehouseGraph()), (error) => error === stop);
  const accountFenceIndex = calls.findIndex(({ sql }) => /FROM accounts WHERE id=\$1 FOR UPDATE/iu.test(sql));
  const profileIndex = calls.findIndex(({ sql }) => /FROM ai_gateway_profiles/iu.test(sql));
  const catalogCall = calls.find(({ sql }) => /FROM ai_gateway_model_catalogs/iu.test(sql));
  assert.ok(accountFenceIndex >= 0 && profileIndex > accountFenceIndex,
    "new-job catalog eligibility must share the account fence used by catalog completion and publication");
  assert.deepEqual(catalogCall.params, ["account-a", "connection-a", 1]);
  assert.match(catalogCall.sql, /JOIN ai_gateway_model_sync_tasks/iu);
  assert.match(catalogCall.sql, /task\.status='SUCCEEDED'/iu);
  assert.match(catalogCall.sql, /task\.sync_purpose='CATALOG_SYNC'/iu);
  assert.match(catalogCall.sql, /ORDER BY catalog\.created_at DESC,catalog\.id DESC[\s\S]*LIMIT 1/iu);
});

test("a latest successful MISSING catalog blocks new jobs without changing the published profile or creating rows", async () => {
  const { repository, calls } = warehouseEvidenceFixture({
    profiles: [{
      id: "profile-connected", config_version: 1, connection_id: "connection-a", connection_version: 1,
      text_model: "text-model-a", image_model: "image-model-a",
    }],
    catalog: { models: [{ id: "text-model-a" }, { id: "different-image-model" }] },
    stageInitialPlanWork: async () => ({ status: "PLANNING", statusVersion: 2 }),
  });
  await assert.rejects(repository.createJobGraph(warehouseGraph()), {
    code: "AUTO_LISTING_AI_ACTIVE_MODEL_UNAVAILABLE", status: 409,
  });
  assert.equal(calls.some(({ sql }) => /UPDATE ai_gateway_profiles|INSERT INTO auto_listing_jobs|INSERT INTO outbox_events/iu.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
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

test("idempotent job replay recalculates exact multiplier evidence before profile selection", async () => {
  const calls = [];
  let stageCount = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: "job-existing" }] };
      }
      if (/SELECT id,account_id,source_type,status,strategy_version_id,warehouse_validation_evidence_id/.test(sql)) {
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
  const result = await repository.createJobGraph(warehouseGraph({ priceMultiplierMicros: "1250000" }));
  assert.equal(result.id, "job-existing");
  assert.equal(result.duplicate, true);
  assert.equal(calls.some(({ sql }) => /FROM ai_gateway_profiles/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql)), false);
  assert.equal(stageCount, 0);
});

test("idempotent RFBS replay exact-compares the immutable original evidence binding", async () => {
  const persistedValidation = rfbsWarehouseValidation();
  const evidenceId = "rfbs-evidence-existing";
  const makeRepository = () => createAutoListingRepository({ pool: {
    connect: async () => ({
      async query(sql) {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
        if (/FROM auto_listing_jobs WHERE account_id=\$1 AND idempotency_key=\$2 FOR UPDATE/.test(sql)) {
          return { rows: [{ id: "job-existing" }] };
        }
        if (/SELECT id,account_id,source_type,status,strategy_version_id,warehouse_validation_evidence_id/.test(sql)) {
          return { rows: [{ id: "job-existing", account_id: "account-a", source_type: "COLLECT_BOX",
            status: "CREATED", strategy_version_id: "strategy-version-a",
            warehouse_validation_evidence_id: evidenceId, correlation_id: "lock-evidence-correlation",
            created_at: new Date(0), updated_at: new Date(0) }] };
        }
        if (/FROM auto_listing_rfbs_warehouse_evidence/.test(sql)) return { rows: [{
          id: evidenceId, account_id: "account-a", store_id: "store-a", warehouse_record_id: "warehouse-a",
          platform_warehouse_id: "platform-a", schema_version: persistedValidation.schemaVersion,
          fulfillment_type: "RFBS", status: "ACTIVE", outcome: "PASSED",
          observed_at: new Date(persistedValidation.observedAt), expires_at: new Date(persistedValidation.expiresAt),
          evidence_hash: persistedValidation.evidenceHash, correlation_id: persistedValidation.correlationId,
          actor_account_id: "account-a", raw_response_ref: null,
        }] };
        if (/FROM auto_listing_job_items i|FROM auto_listing_events/.test(sql)) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() {},
    }),
    query: async () => ({ rows: [] }),
  } });

  const matching = warehouseGraph();
  matching.warehouseValidation = persistedValidation;
  assert.equal((await makeRepository().createJobGraph(matching)).duplicate, true);

  const conflicting = warehouseGraph();
  conflicting.correlationId = "different-correlation";
  conflicting.warehouseValidation = rfbsWarehouseValidation({ correlationId: "different-correlation" });
  await assert.rejects(makeRepository().createJobGraph(conflicting), {
    code: "AUTO_LISTING_WAREHOUSE_EVIDENCE_CONFLICT", status: 409,
  });
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
    planningContract: "LEGACY_FULL_PLAN_V3",
    blockedEvidence: evidence.blockedEvidence, snapshotHash: evidence.snapshotHash, rawResponseRef: evidence.rawResponseRef,
    targetStoreId: "store-a", targetWarehouseId: "warehouse-a", sourceOrder: 1,
    status: "BLOCKED", failureCode: "AUTO_LISTING_SOURCE_SKU_REQUIRED",
  }];
  return graph;
}

function mixedCreationGraph() {
  const graph = warehouseGraph({ itemCount: 2 });
  const blocked = blockedSourceGraph().items[0];
  graph.items.push({ ...blocked, sourceOrder: 3 });
  return graph;
}

function successfulCreationFixture({
  stageBehavior = null,
  profiles = [{ id: "profile-a", config_version: 3 }],
  rules = [],
} = {}) {
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
      if (/auto-listing-category-graph-lock-keys/u.test(sql)) return { rows: params[1].map((id, index) => ({ shared_category_id: id, lock_key: String(index + 1) })) };
      if (/pg_try_advisory_xact_lock_shared/u.test(sql)) return { rows: [{ locked: true }] };
      if (/auto-listing-category-graph-lease-active/u.test(sql)) return { rows: [{ id: "category-lease-a" }] };
      if (/FROM accounts WHERE id=\$1 FOR UPDATE/.test(sql)) return { rows: [{ id: "account-a" }] };
      if (/FROM stores s/.test(sql) && /owner_account_id/.test(sql)) return { rows: [{
        id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A",
        client_id: "client-a", currency_code: "RUB", currency_source: "OZON_SELLER_INFO",
        currency_synced_at: "2026-08-13T00:00:00.000Z", status: "active",
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
      if (/FROM ai_content_strategy_rules/.test(sql)) return { rows: rules };
      if (/FROM collect_ozon_category_current_sources current_category/.test(sql)) return { rows: [{ id: "shared-123-456" }] };
      if (/FROM collect_items c/.test(sql)) return { rows: [{
        draft_id: `draft-${params[0]}`, draft_version: 1, draft_data_hash: "1".repeat(64),
      }] };
      if (/INSERT INTO auto_listing_jobs/.test(sql)) {
        job = {
          id: params[0], account_id: params[1], source_type: params[2], status: "CREATED",
          strategy_version_id: params[6], warehouse_validation_evidence_id: params[12], correlation_id: params[11],
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
          source_order: params[4], target_store_id: params[5], target_warehouse_id: params[6], status: params[7],
          status_version: 1, failure_code: params[8], created_at: new Date(0), updated_at: new Date(0),
          planning_contract: params[10],
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
      if (/SELECT id,account_id,source_type,status,strategy_version_id,warehouse_validation_evidence_id/.test(sql)) return { rows: job ? [job] : [] };
      if (/FROM auto_listing_job_items i/.test(sql)) return { rows: items.map((item) => {
        const snapshot = snapshots.get(item.snapshot_id);
        return {
          ...item,
          source_record_id: snapshot.source_record_id,
          source_version: snapshot.source_version,
          snapshot_hash: snapshot.snapshot_hash,
          source_thumbnail_url: snapshot.snapshot.media?.images?.[0] || "",
          source_title: snapshot.snapshot.identity?.primaryName || "",
          source_sku: snapshot.snapshot.identity?.primarySku || "",
        };
      }) };
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
    pool: { connect: async () => client, query: (...args) => client.query(...args) },
    idFactory(prefix) {
      const count = (counters.get(prefix) || 0) + 1;
      counters.set(prefix, count);
      return `${prefix}-${count}`;
    },
    stageInitialPlanWork,
  });
  return { repository, calls, stageCalls, client, events };
}

test("successful creation without the AI workflow keeps ready statuses and stages no outbox work", async () => {
  const { repository, calls, stageCalls } = successfulCreationFixture();
  const created = await repository.createJobGraph(mixedCreationGraph());

  assert.deepEqual(created.items.map(({ status }) => status), ["SOURCE_READY", "SOURCE_READY", "BLOCKED"]);
  assert.equal(calls.some(({ sql }) => /FROM ai_gateway_profiles/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/i.test(sql)), false);
  assert.equal(calls.filter(({ sql }) => /INSERT INTO auto_listing_listing_bases/.test(sql)).length, 2);
  assert.equal(stageCalls.length, 0);
  const jobInsert = calls.find(({ sql }) => /INSERT INTO auto_listing_jobs/.test(sql));
  assert.deepEqual(jobInsert.params.slice(7, 10), ["upload-policy-review-a", null, null]);
});

test("category strategy OFF persists the frozen generic selection even when a published rule matches", async () => {
  const { repository, calls } = successfulCreationFixture({
    rules: [{
      id: "matching-rule", rule_order: 1, rule_kind: "EXACT_CATEGORY",
      category_id: "123", ancestor_category_id: null, product_style: null,
      rule: { style: "VISUAL_FIRST", textDensityByRole: {} },
    }],
  });

  const created = await repository.createJobGraph(warehouseGraph({ useCategoryStrategy: false }));

  assert.equal(created.items[0].style, "BALANCED_DEFAULT");
  assert.equal(created.items[0].matchedBy, "DEFAULT");
  assert.equal(calls.some(({ sql }) => /FROM ai_content_strategy_rules/.test(sql)), false);
});

test("job graph persists and returns each server-selected planning contract", async () => {
  const { repository, calls } = successfulCreationFixture();
  const graph = warehouseGraph();
  graph.items[0].planningContract = "FIXED_SKELETON_V1";
  const created = await repository.createJobGraph(graph);

  const itemInsert = calls.find(({ sql }) => /INSERT INTO auto_listing_job_items/.test(sql));
  assert.match(itemInsert.sql, /planning_contract/u);
  assert.match(itemInsert.sql, /source_order/u);
  assert.equal(itemInsert.params.includes(1), true);
  assert.equal(itemInsert.params.at(-1), "FIXED_SKELETON_V1");
  assert.equal(created.items[0].planningContract, "FIXED_SKELETON_V1");
  assert.equal(created.items[0].sourceOrder, 1);
  assert.equal(created.items[0].sourceThumbnailUrl, "https://source.example.test/one.jpg");
  assert.equal(created.items[0].sourceTitle, "商品一");
  assert.equal(created.items[0].sourceSku, "SKU-1");
});

test("SOURCE_CAPTURED audit round-trips the requested image configuration with its evidence gap", async () => {
  const { repository } = successfulCreationFixture();
  const graph = warehouseGraph();
  const requested = normalizeAndHashAutoListingConfig({
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    stock: 1,
    priceAdjustmentKopecks: "0",
    image: {
      roles: {
        main: 1,
        sellingPoint: 3,
        detail: 1,
        scene: 1,
        specification: 1,
        infographic: 1,
      },
    },
  });
  graph.configSnapshot = requested.config;
  graph.configHash = requested.configHash;
  graph.items[0].snapshot.productMeasurements = {};
  graph.items[0].snapshotHash = crypto.createHash("sha256")
    .update(canonicalAutoListingSourceSnapshot(graph.items[0].snapshot)).digest("hex");
  graph.items[0].effectiveImageConfig = deriveEffectiveAutoListingImageConfig({
    configSnapshot: graph.configSnapshot,
    configHash: graph.configHash,
    sourceCapture: {
      snapshot: graph.items[0].snapshot,
      snapshotHash: graph.items[0].snapshotHash,
    },
  });

  const created = await repository.createJobGraph(graph);
  const reloaded = await repository.getJob({ accountId: "account-a", jobId: created.id });
  const audit = reloaded.events.find((event) => event.eventType === "SOURCE_CAPTURED").details;
  assert.deepEqual(audit.effectiveImageConfig, {
    roles: {
      main: 1,
      sellingPoint: 3,
      detail: 1,
      scene: 1,
      specification: 1,
      infographic: 1,
    },
    total: 8,
    reasonCodes: ["PRODUCT_DIMENSIONS_UNAVAILABLE"],
  });
});

test("repository reads reject internally inconsistent effective image audit details", async () => {
  const { repository, events } = successfulCreationFixture();
  const created = await repository.createJobGraph(warehouseGraph());
  const sourceEvent = events.find((event) => event.event_type === "SOURCE_CAPTURED");
  sourceEvent.details.effectiveImageConfig = {
    roles: {
      main: 1,
      sellingPoint: 3,
      detail: 1,
      scene: 1,
      specification: 1,
      infographic: 1,
    },
    total: 99,
    reasonCodes: [],
  };

  await assert.rejects(
    repository.getJob({ accountId: "account-a", jobId: created.id }),
    (error) => error?.code === "AUTO_LISTING_REPOSITORY_INVALID",
  );
});

test("job graph rejects a missing or unknown planning contract before PostgreSQL", async () => {
  for (const planningContract of [undefined, null, "", "FIXED_V2"] ) {
    let connections = 0;
    const repository = createAutoListingRepository({
      pool: {
        async connect() { connections += 1; throw new Error("must not connect"); },
        async query() { throw new Error("must not query"); },
      },
    });
    const graph = warehouseGraph();
    if (planningContract === undefined) delete graph.items[0].planningContract;
    else graph.items[0].planningContract = planningContract;
    await assert.rejects(repository.createJobGraph(graph), {
      code: "AUTO_LISTING_REPOSITORY_INVALID",
    });
    assert.equal(connections, 0);
  }
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
      itemId: "auto_listing_job-1_item_001", actorAccountId: "account-a",
      expectedStatusVersion: 1, correlationId: "lock-evidence-correlation",
    },
    {
      client: undefined, accountId: "account-a", jobId: "auto_listing_job-1",
      itemId: "auto_listing_job-1_item_002", actorAccountId: "account-a",
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
  assert.equal(stageCalls.some(({ itemId }) => itemId.endsWith("_003")), false);
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

  const forgedVariant = warehouseGraph();
  const forgedVariantPrice = {
    currency: "RUB", currencySource: "SOURCE", blackKopecks: "25000", greenKopecks: null,
  };
  forgedVariant.items[0].listingBaseTemplate.variants[0].pricingEvidence = {
    ...forgedVariantPrice,
    evidenceHash: digest(forgedVariantPrice),
  };
  await assert.rejects(repository.createJobGraph(forgedVariant), {
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
      if (/SELECT id FROM accounts WHERE id=\$1 FOR UPDATE/.test(sql)) return { rows: [{ id: "account-a" }] };
      if (/auto-listing-category-graph-lock-keys/u.test(sql)) return { rows: params[1].map((id, index) => ({ shared_category_id: id, lock_key: String(index + 1) })) };
      if (/pg_try_advisory_xact_lock_shared/u.test(sql)) return { rows: [{ locked: true }] };
      if (/auto-listing-category-graph-lease-active/u.test(sql)) return { rows: [{ id: "category-lease-a" }] };
      if (/FROM stores s/.test(sql) && /owner_account_id/.test(sql)) return { rows: [{
        id: "store-a", owner_account_id: "account-a", label: "Store A", company_name: "Store A",
        client_id: "client-a", currency_code: "RUB", currency_source: "OZON_SELLER_INFO",
        currency_synced_at: "2026-08-13T00:00:00.000Z", status: "active",
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
      if (/FROM collect_ozon_category_current_sources current_category/.test(sql)) return { rows: [{ id: "shared-123-456" }] };
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
    categoryPreparationLeaseId: "category-lease-a",
    correlationId: "corr", configSnapshot: config, configHash, strategyVersionId: "version-a",
    uploadPolicyVersionId: "upload-policy-review-a",
    items: [{
      sourceType: "COLLECT_BOX", sourceRecordId: "collect-blocked", sourceVersion: "1",
      planningContract: "LEGACY_FULL_PLAN_V3",
      blockedEvidence: evidence.blockedEvidence, snapshotHash: evidence.snapshotHash, rawResponseRef: evidence.rawResponseRef,
      targetStoreId: "store-a", targetWarehouseId: "warehouse-a", sourceOrder: 1,
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
