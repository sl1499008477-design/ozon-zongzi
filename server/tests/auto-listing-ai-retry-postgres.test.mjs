import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingAiRetryRepository } from "../auto-listing-ai-retry-postgres.mjs";

const command = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a",
  expectedStatusVersion: 4, idempotencyKey: "retry-a",
});

function harness({ recoveryPoint = "PLANNING", acceptedSlots = [], skippedSlots = [], slots = [], statusVersion = 4,
  status = "RETRYABLE_ERROR", failureCode = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/set_config\('statement_timeout'/u.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM auto_listing_events[\s\S]*?WHERE id=\$1/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM auto_listing_job_items AS i[\s\S]*?FOR UPDATE OF i/u.test(sql)) return {
        rows: [{ status, status_version: statusVersion, recovery_point: recoveryPoint, failure_code: failureCode,
          active_content_plan_id: recoveryPoint === "GENERATION" || status === "BLOCKED" ? "plan-a" : null }], rowCount: 1,
      };
      if (/SELECT p\.plan/u.test(sql)) return { rows: [{ plan: { slots } }], rowCount: 1 };
      if (/FROM ai_generation_assets/u.test(sql)) return { rows: acceptedSlots.map((slot_key) => ({ slot_key })), rowCount: acceptedSlots.length };
      if (/UPDATE ai_generation_assets/u.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM auto_listing_events/u.test(sql) && /AI_IMAGE_SLOT_SKIPPED/u.test(sql)) {
        return { rows: skippedSlots.map((slot_key) => ({ slot_key })), rowCount: skippedSlots.length };
      }
      if (/UPDATE auto_listing_job_items/u.test(sql)) return {
        rows: [{ status: recoveryPoint === "PLANNING" ? "PLANNING" : "GENERATING", status_version: statusVersion + 1 }], rowCount: 1,
      };
      if (/INSERT INTO auto_listing_events/u.test(sql)) return { rows: [{ id: "retry-event" }], rowCount: 1 };
      if (/INSERT INTO auto_listing_ai_outbox/u.test(sql)) return { rows: [{ id: "outbox" }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  return {
    calls,
    repository: createPostgresAutoListingAiRetryRepository({
      pool: { async connect() { return client; }, async query() { throw new Error("must use transaction"); } },
    }),
  };
}

test("PLANNING retry atomically advances the fence, audits and enqueues one PLAN_CONTENT message", async () => {
  const { repository, calls } = harness();
  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "PLANNING", statusVersion: 5, recoveryPoint: "PLANNING", enqueued: 1, duplicate: false,
  });
  const insert = calls.find(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql));
  assert.match(insert.sql, /ON CONFLICT \(dedupe_key\) DO NOTHING/iu);
  assert.match(JSON.stringify(insert.values), /PLAN_CONTENT/iu);
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_events/u.test(sql)), true);
  assert.deepEqual(calls.slice(-2).map(({ sql }) => sql), ["COMMIT", "RELEASE"]);
});

test("GENERATION retry enqueues only incomplete slots and never repeats accepted assets", async () => {
  const slots = [
    { slotKey: "main", role: "MAIN", visualGroupKey: "group-a" },
    { slotKey: "detail", role: "DETAIL", visualGroupKey: "group-a" },
  ];
  const { repository, calls } = harness({ recoveryPoint: "GENERATION", acceptedSlots: ["main"], slots });
  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 1, duplicate: false,
  });
  const outbox = calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql));
  assert.equal(outbox.length, 1);
  assert.match(JSON.stringify(outbox[0].values), /detail/iu);
  assert.doesNotMatch(JSON.stringify(outbox[0].values), /"main"/iu);
  const acceptedLookup = calls.find(({ sql }) => /FROM ai_generation_assets AS asset/u.test(sql));
  assert.match(acceptedLookup.sql, /jsonb_array_length\(planned_slot->'claims'\)>0/iu);
  assert.match(acceptedLookup.sql, /checker_result->>'textForbidden'='true'/iu);
});

test("GENERATION retry closes old-version generating attempts before replaying immutable slot input", async () => {
  const slots = [
    { slotKey: "main", role: "MAIN", visualGroupKey: "group-a" },
    { slotKey: "scene", role: "SCENE", visualGroupKey: "group-a" },
  ];
  const { repository, calls } = harness({ recoveryPoint: "GENERATION", acceptedSlots: ["main"], slots });

  await repository.retryAutoListingAiItem(command);

  const cleanupIndex = calls.findIndex(({ sql }) => /UPDATE ai_generation_assets/u.test(sql));
  const itemUpdateIndex = calls.findIndex(({ sql }) => /UPDATE auto_listing_job_items/u.test(sql));
  const cleanup = calls[cleanupIndex];
  assert.ok(cleanupIndex >= 0 && cleanupIndex < itemUpdateIndex);
  assert.match(cleanup.sql, /status='GENERATING'/iu);
  assert.match(cleanup.sql, /expected_status_version\s*<\s*\$4/iu);
  assert.match(cleanup.sql, /AUTO_LISTING_IMAGE_RETRY_SUPERSEDED/iu);
  assert.deepEqual(cleanup.values, ["account-a", "job-a", "item-a", 4, "plan-a"]);
});

test("GENERATION retry supports a materialized multi-variant plan with 77 slots", async () => {
  const slots = Array.from({ length: 77 }, (_, index) => ({
    slotKey: index === 0 ? "main" : `slot-${index}`,
    role: index % 7 === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: `group-${Math.floor(index / 7)}`,
  }));
  const { repository, calls } = harness({ recoveryPoint: "GENERATION", slots });

  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 77, duplicate: false,
  });
  assert.equal(calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql)).length, 77);
});

test("a main-image coverage block reuses the generation retry path without repeating accepted slots", async () => {
  const slots = [
    { slotKey: "main", role: "MAIN", visualGroupKey: "group-a" },
    { slotKey: "detail", role: "DETAIL", visualGroupKey: "group-a" },
  ];
  const { repository, calls } = harness({
    status: "BLOCKED", failureCode: "AUTO_LISTING_MAIN_IMAGE_REQUIRED",
    recoveryPoint: null, acceptedSlots: ["detail"], slots,
  });
  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 1, duplicate: false,
  });
  const update = calls.find(({ sql }) => /UPDATE auto_listing_job_items/u.test(sql));
  assert.equal(update.values[5], "BLOCKED");
  const event = calls.find(({ sql }) => /INSERT INTO auto_listing_events/u.test(sql));
  assert.equal(event.values[4], "BLOCKED");
  const outbox = calls.find(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql));
  assert.match(JSON.stringify(outbox.values), /main/iu);
  assert.doesNotMatch(JSON.stringify(outbox.values), /detail/iu);
});

test("an incomplete configured image set can retry every skipped role without repeating accepted slots", async () => {
  const slots = [
    { slotKey: "main", role: "MAIN", visualGroupKey: "group-a" },
    { slotKey: "detail", role: "DETAIL", visualGroupKey: "group-a" },
    { slotKey: "selling", role: "SELLING_POINT", visualGroupKey: "group-a" },
  ];
  const { repository, calls } = harness({
    status: "BLOCKED", failureCode: "AUTO_LISTING_MINIMUM_IMAGE_COUNT_NOT_MET",
    recoveryPoint: null, acceptedSlots: ["main"], skippedSlots: ["detail", "selling"], slots,
  });
  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 2, duplicate: false,
  });
  const payloads = calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql))
    .map(({ values }) => JSON.stringify(values));
  assert.equal(payloads.length, 2);
  assert.match(payloads[0], /detail/iu);
  assert.match(payloads[1], /selling/iu);
  assert.equal(payloads.some((payload) => /"main"/iu.test(payload)), false);
});

test("a repaired generation context contract resumes the same blocked task", async () => {
  const slots = [
    { slotKey: "main", role: "MAIN", visualGroupKey: "group-a" },
    { slotKey: "detail", role: "DETAIL", visualGroupKey: "group-a" },
  ];
  const { repository, calls } = harness({
    status: "BLOCKED", failureCode: "AUTO_LISTING_AI_PHASE_CONTEXT_EVIDENCE_INVALID",
    recoveryPoint: null, slots,
  });

  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 2, duplicate: false,
  });
  assert.equal(calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql)).length, 2);
});

test("a fixed rich-content input block resumes from accepted image evidence after the code boundary is repaired", async () => {
  const slots = Array.from({ length: 6 }, (_, index) => ({
    slotKey: index === 0 ? "main" : `slot-${index}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: "group-a",
  }));
  const { repository, calls } = harness({
    status: "BLOCKED", failureCode: "AUTO_LISTING_RICH_CONTENT_INPUT_INVALID",
    recoveryPoint: null, acceptedSlots: slots.map((slot) => slot.slotKey), slots,
  });
  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 1, duplicate: false,
  });
  const outbox = calls.find(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql));
  assert.match(JSON.stringify(outbox.values), /GENERATE_RICH_CONTENT/iu);
});

test("an exhausted old rich-content input resumes only rich content after evidence normalization changes its hash", async () => {
  const slots = Array.from({ length: 6 }, (_, index) => ({
    slotKey: index === 0 ? "main" : `slot-${index}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: "group-a",
  }));
  const { repository, calls } = harness({
    status: "BLOCKED", failureCode: "AUTO_LISTING_RICH_CONTENT_ATTEMPTS_EXHAUSTED",
    recoveryPoint: null, acceptedSlots: slots.map((slot) => slot.slotKey), slots,
  });

  assert.deepEqual(await repository.retryAutoListingAiItem(command), {
    status: "GENERATING", statusVersion: 5, recoveryPoint: "GENERATION", enqueued: 1, duplicate: false,
  });
  const outbox = calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql));
  assert.equal(outbox.length, 1);
  assert.match(JSON.stringify(outbox[0].values), /GENERATE_RICH_CONTENT/iu);
  assert.doesNotMatch(JSON.stringify(outbox[0].values), /GENERATE_IMAGE_SLOT/iu);
});

test("GENERATION retry regenerates every skipped configured slot so the final role counts stay complete", async () => {
  const group = (name) => Array.from({ length: 7 }, (_, index) => ({
    slotKey: `${name}-${index}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: name,
  }));
  const slots = [...group("group-a"), ...group("group-b")];
  const acceptedSlots = [
    ...Array.from({ length: 5 }, (_, index) => `group-a-${index}`),
    ...Array.from({ length: 6 }, (_, index) => `group-b-${index}`),
  ];
  const { repository, calls } = harness({
    recoveryPoint: "GENERATION", slots, acceptedSlots,
    skippedSlots: ["group-a-5", "group-a-6", "group-b-6"],
  });
  assert.equal((await repository.retryAutoListingAiItem(command)).enqueued, 3);
  const payloads = calls.filter(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql))
    .map(({ values }) => JSON.stringify(values));
  assert.equal(payloads.length, 3);
  assert.match(payloads[0], /group-a-5/iu);
  assert.match(payloads[1], /group-a-6/iu);
  assert.match(payloads[2], /group-b-6/iu);
});

test("GENERATION retry resumes rich content when all images are terminal and at least six include MAIN", async () => {
  const slots = Array.from({ length: 6 }, (_, index) => ({
    slotKey: index === 0 ? "main" : `slot-${index}`,
    role: index === 0 ? "MAIN" : "DETAIL",
    visualGroupKey: "group-a",
  }));
  const { repository, calls } = harness({
    recoveryPoint: "GENERATION", acceptedSlots: slots.map((slot) => slot.slotKey), slots,
  });
  assert.equal((await repository.retryAutoListingAiItem(command)).enqueued, 1);
  assert.match(JSON.stringify(calls.find(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql)).values), /GENERATE_RICH_CONTENT/iu);
});

test("retry fails closed on wrong version/recovery and rolls back without outbox writes", async () => {
  const { repository, calls } = harness({ recoveryPoint: "UPLOAD" });
  await assert.rejects(repository.retryAutoListingAiItem(command), {
    code: "AUTO_LISTING_AI_RETRY_NOT_RECOVERABLE",
  });
  assert.equal(calls.some(({ sql }) => /INSERT INTO auto_listing_ai_outbox/u.test(sql)), false);
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("the same idempotency key on two distinct status-version retry cycles cannot alias one audit command", async () => {
  const first = harness({ statusVersion: 4 });
  await first.repository.retryAutoListingAiItem(command);
  const second = harness({ statusVersion: 8 });
  await second.repository.retryAutoListingAiItem({ ...command, expectedStatusVersion: 8 });
  const eventId = ({ calls }) => calls.find(({ sql }) => /INSERT INTO auto_listing_events/u.test(sql)).values[0];
  assert.notEqual(eventId(first), eventId(second));
});

test("retry repository factory rejects hidden and adversarial configuration without invoking accessors", () => {
  let reads = 0;
  const thrown = {};
  Object.defineProperty(thrown, "code", {
    get() { reads += 1; throw new Error("password=raw"); },
  });
  assert.throws(() => createPostgresAutoListingAiRetryRepository(new Proxy({}, {
    ownKeys() { throw thrown; },
  })), (error) => error?.code === "AUTO_LISTING_AI_RETRY_INVALID"
    && !/password|raw/iu.test(error.message));
  assert.equal(reads, 0);

  const options = {};
  Object.defineProperty(options, "pool", {
    enumerable: true,
    get() { reads += 1; return null; },
  });
  assert.throws(() => createPostgresAutoListingAiRetryRepository(options), {
    code: "AUTO_LISTING_AI_RETRY_INVALID",
  });
  assert.equal(reads, 0);
});
