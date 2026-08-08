import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAutoListingAiRetryRepository } from "../auto-listing-ai-retry-postgres.mjs";

const command = Object.freeze({
  accountId: "account-a", jobId: "job-a", itemId: "item-a",
  expectedStatusVersion: 4, idempotencyKey: "retry-a",
});

function harness({ recoveryPoint = "PLANNING", acceptedSlots = [], slots = [], statusVersion = 4 } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/set_config\('statement_timeout'/u.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM auto_listing_events[\s\S]*?WHERE id=\$1/u.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM auto_listing_job_items AS i[\s\S]*?FOR UPDATE OF i/u.test(sql)) return {
        rows: [{ status: "RETRYABLE_ERROR", status_version: statusVersion, recovery_point: recoveryPoint,
          active_content_plan_id: recoveryPoint === "GENERATION" ? "plan-a" : null }], rowCount: 1,
      };
      if (/SELECT p\.plan/u.test(sql)) return { rows: [{ plan: { slots } }], rowCount: 1 };
      if (/FROM ai_generation_assets/u.test(sql)) return { rows: acceptedSlots.map((slot_key) => ({ slot_key })), rowCount: acceptedSlots.length };
      if (/FROM auto_listing_events/u.test(sql) && /AI_IMAGE_SLOT_SKIPPED/u.test(sql)) return { rows: [], rowCount: 0 };
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
