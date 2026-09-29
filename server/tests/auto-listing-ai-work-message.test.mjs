import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_LISTING_AI_WORK_CONTRACT_VERSION,
  autoListingAiWorkSingletonKey,
  normalizeAutoListingAiWorkMessage,
} from "../auto-listing-ai-work-message.mjs";

const now = Date.parse("2026-08-28T00:00:00.000Z");
const message = Object.freeze({
  contractVersion: "V1",
  accountId: "account-a",
  itemId: "item-a",
  phase: "PLAN_CONTENT",
  expectedStatusVersion: 3,
  correlationId: "correlation-a",
});

function workMessage(overrides = {}) {
  return {
    workContractVersion: "CHANNEL_WORK_V1",
    message,
    execution: {
      outboxId: "outbox-a",
      dispatchGeneration: 1,
      channelId: "channel-a",
      connectionId: "connection-a",
      connectionVersion: 2,
      leaseOwner: "relay-a",
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-08-28T00:05:00+00:00",
      ...overrides,
    },
  };
}

test("CHANNEL_WORK_V1 normalizes the exact fenced execution envelope and preserves the normalized business message", () => {
  const normalized = normalizeAutoListingAiWorkMessage(workMessage(), { now });

  assert.equal(AUTO_LISTING_AI_WORK_CONTRACT_VERSION, "CHANNEL_WORK_V1");
  assert.deepEqual(normalized, {
    workContractVersion: "CHANNEL_WORK_V1",
    message,
    execution: {
      outboxId: "outbox-a",
      dispatchGeneration: 1,
      channelId: "channel-a",
      connectionId: "connection-a",
      connectionVersion: 2,
      leaseOwner: "relay-a",
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-08-28T00:05:00.000Z",
    },
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.execution), true);
});

test("work envelopes reject unknown, cross-account and sensitive fields at every contract boundary", () => {
  for (const value of [
    { ...workMessage(), tenantId: "tenant-a" },
    { ...workMessage(), execution: { ...workMessage().execution, accountId: "account-b" } },
    { ...workMessage(), execution: { ...workMessage().execution, apiKey: "sk-raw-secret" } },
    { ...workMessage(), execution: { ...workMessage().execution, baseUrl: "https://gateway.example.test" } },
    { ...workMessage(), execution: { ...workMessage().execution, rawError: "password=raw" } },
    { ...workMessage(), message: { ...message, accountId: "account-a", secret: "raw" } },
  ]) {
    assert.throws(
      () => normalizeAutoListingAiWorkMessage(value, { now }),
      (error) => error?.code === "AUTO_LISTING_AI_WORK_MESSAGE_INVALID"
        && !/password|secret|gateway|tenant/iu.test(error.message),
    );
  }
});

test("work envelopes reject unsafe identifiers and non-positive execution versions", () => {
  for (const overrides of [
    { outboxId: "https://internal.example.test/outbox" },
    { channelId: "channel@example.test" },
    { connectionId: "sk-proj-rawcredential123" },
    { leaseOwner: "worker\nforged" },
    { leaseToken: "" },
    { dispatchGeneration: 0 },
    { dispatchGeneration: 1.5 },
    { connectionVersion: 0 },
    { connectionVersion: Number.POSITIVE_INFINITY },
  ]) assert.throws(
    () => normalizeAutoListingAiWorkMessage(workMessage(overrides), { now }),
    { code: "AUTO_LISTING_AI_WORK_MESSAGE_INVALID" },
  );
});

test("work envelopes distinguish expired leases from malformed leases", () => {
  for (const leaseExpiresAt of [
    "2026-08-28T00:00:00.000Z",
    "2026-08-27T23:59:59.999Z",
  ]) assert.throws(
    () => normalizeAutoListingAiWorkMessage(workMessage({ leaseExpiresAt }), { now }),
    { code: "AUTO_LISTING_AI_WORK_MESSAGE_EXPIRED" },
  );

  for (const leaseExpiresAt of [
    "not-a-date",
    "August 29, 2026 00:00:00 GMT",
    "2026-08-29",
    "275760-09-13T00:00:00.000Z",
    1_787_875_500_000,
  ]) assert.throws(
    () => normalizeAutoListingAiWorkMessage(workMessage({ leaseExpiresAt }), { now }),
    { code: "AUTO_LISTING_AI_WORK_MESSAGE_INVALID" },
  );
});

test("work singleton identity dedupes one generation and changes for the next generation", () => {
  const first = autoListingAiWorkSingletonKey(workMessage(), { now });
  const replay = autoListingAiWorkSingletonKey(workMessage({ leaseToken: "lease-replay" }), { now });
  const next = autoListingAiWorkSingletonKey(workMessage({ dispatchGeneration: 2 }), { now });

  assert.equal(first, "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8:1");
  assert.equal(replay, first);
  assert.equal(next, "5e6f8a19b642d50cef84bb57627e8310fca0cfc9b43de27510796eee9c79bfb8:2");
});
