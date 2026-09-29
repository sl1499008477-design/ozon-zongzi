import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION,
  AUTO_LISTING_AI_MESSAGE_MAX_UTF8_BYTES,
  AUTO_LISTING_AI_PHASES,
  autoListingAiMessageDedupeKey,
  autoListingAiMessagePhaseTarget,
  canonicalizeAutoListingAiMessage,
  normalizeAutoListingAiMessage,
} from "../auto-listing-ai-message.mjs";

const message = (phase = "PLAN_CONTENT", overrides = {}) => ({
  contractVersion: "V3",
  accountId: "account-a",
  itemId: "item-a",
  phase,
  expectedStatusVersion: 2,
  correlationId: "correlation-a",
  ...(phase === "MATERIALIZE_SOURCE_ASSET" ? { sourceAssetId: "source-a" } : {}),
  ...(phase === "ANALYZE_SOURCE_IMAGE_BATCH" ? { analysisBatchId: "batch-a" } : {}),
  ...(["CLEAN_SOURCE_IMAGE_OVERLAY", "CHECK_SOURCE_IMAGE_CLEANUP"].includes(phase)
    ? { analysisRunId: "run-a", derivativeAttemptId: "derivative-attempt-a" } : {}),
  ...(phase === "RECONCILE_SOURCE_IMAGE_ANALYSIS" ? { analysisRunId: "run-a" } : {}),
  ...(phase === "GENERATE_IMAGE_SLOT" ? { slotKey: "main-1" } : {}),
  ...(phase === "CHECK_IMAGE_GROUP" ? { visualGroupKey: "group-a" } : {}),
  ...overrides,
});

const v3Message = (phase, target = {}) => ({
  contractVersion: "V3",
  accountId: "account-a",
  itemId: "item-a",
  phase,
  expectedStatusVersion: 2,
  correlationId: "correlation-a",
  ...target,
});

const legacyMessage = (contractVersion) => message("PLAN_CONTENT", { contractVersion });

test("V3 phases accept only their exact target key", () => {
  const batch = normalizeAutoListingAiMessage(v3Message("ANALYZE_SOURCE_IMAGE_BATCH", {
    analysisBatchId: "batch-1",
  }));
  const reconcile = normalizeAutoListingAiMessage(v3Message("RECONCILE_SOURCE_IMAGE_ANALYSIS", {
    analysisRunId: "run-1",
  }));
  const group = normalizeAutoListingAiMessage(v3Message("CHECK_IMAGE_GROUP", {
    visualGroupKey: "group-1",
  }));
  assert.equal(batch.analysisBatchId, "batch-1");
  assert.equal(reconcile.analysisRunId, "run-1");
  assert.equal(group.visualGroupKey, "group-1");
  assert.equal(autoListingAiMessagePhaseTarget(batch), "batch-1");
  assert.equal(autoListingAiMessagePhaseTarget(reconcile), "run-1");
  assert.equal(autoListingAiMessagePhaseTarget(group), "group-1");
  assert.throws(
    () => normalizeAutoListingAiMessage(v3Message("CHECK_IMAGE_GROUP", { slotKey: "main-1" })),
    { code: "AUTO_LISTING_AI_MESSAGE_INVALID" },
  );
});

test("cleanup phases require their run scope and share the derivative target without sharing dedupe", () => {
  const clean = normalizeAutoListingAiMessage(v3Message("CLEAN_SOURCE_IMAGE_OVERLAY", {
    analysisRunId: "run-1",
    derivativeAttemptId: "attempt-1",
  }));
  const check = normalizeAutoListingAiMessage(v3Message("CHECK_SOURCE_IMAGE_CLEANUP", {
    analysisRunId: "run-1",
    derivativeAttemptId: "attempt-1",
  }));

  assert.equal(autoListingAiMessagePhaseTarget(clean), "attempt-1");
  assert.equal(autoListingAiMessagePhaseTarget(check), "attempt-1");
  assert.notEqual(autoListingAiMessageDedupeKey(clean), autoListingAiMessageDedupeKey(check));
  assert.throws(
    () => normalizeAutoListingAiMessage(v3Message("CLEAN_SOURCE_IMAGE_OVERLAY", {
      derivativeAttemptId: "attempt-1",
    })),
    { code: "AUTO_LISTING_AI_MESSAGE_INVALID" },
  );
  assert.throws(
    () => normalizeAutoListingAiMessage(v3Message("CHECK_SOURCE_IMAGE_CLEANUP", {
      analysisRunId: "run-1",
      derivativeAttemptId: "attempt-1",
      sourceAssetId: "must-not-trust-queue-data",
    })),
    { code: "AUTO_LISTING_AI_MESSAGE_INVALID" },
  );
});

test("historical V1 and V2 messages remain readable", () => {
  assert.equal(normalizeAutoListingAiMessage(legacyMessage("V1")).contractVersion, "V1");
  assert.equal(normalizeAutoListingAiMessage(legacyMessage("V2")).contractVersion, "V2");
});

test("normalizes current V3 work while keeping legacy V1 rows readable", () => {
  assert.equal(AUTO_LISTING_AI_MESSAGE_CONTRACT_VERSION, "V3");
  assert.deepEqual(AUTO_LISTING_AI_PHASES, [
    "MATERIALIZE_SOURCE_ASSET",
    "ANALYZE_SOURCE_IMAGE_BATCH",
    "CLEAN_SOURCE_IMAGE_OVERLAY",
    "CHECK_SOURCE_IMAGE_CLEANUP",
    "RECONCILE_SOURCE_IMAGE_ANALYSIS",
    "PLAN_CONTENT",
    "FINALIZE_MATERIALIZED_PLAN",
    "GENERATE_IMAGE_SLOT",
    "CHECK_IMAGE_GROUP",
    "GENERATE_RICH_CONTENT",
  ]);
  for (const phase of AUTO_LISTING_AI_PHASES) {
    const normalized = normalizeAutoListingAiMessage(message(phase));
    assert.deepEqual(normalized, message(phase));
    assert.ok(Object.isFrozen(normalized));
  }
  assert.deepEqual(
    normalizeAutoListingAiMessage(message("PLAN_CONTENT", { contractVersion: "V1" })),
    message("PLAN_CONTENT", { contractVersion: "V1" }),
  );
});

test("rejects missing, extra, and wrong phase-specific keys", () => {
  const malformed = [
    { ...message(), contractVersion: undefined },
    { ...message(), accountId: undefined },
    { ...message(), itemId: undefined },
    { ...message(), phase: undefined },
    { ...message(), expectedStatusVersion: undefined },
    { ...message(), correlationId: undefined },
    message("MATERIALIZE_SOURCE_ASSET", { sourceAssetId: undefined }),
    message("GENERATE_IMAGE_SLOT", { slotKey: undefined }),
    message("PLAN_CONTENT", { sourceAssetId: "source-a" }),
    message("GENERATE_RICH_CONTENT", { slotKey: "main-1" }),
    message("PLAN_CONTENT", { price: 123 }),
    message("PLAN_CONTENT", { rawResponse: "hidden" }),
  ];
  for (const value of malformed) {
    assert.throws(() => normalizeAutoListingAiMessage(value), (error) => error?.code === "AUTO_LISTING_AI_MESSAGE_INVALID");
  }
});

test("rejects non-plain objects, inherited payloads, invalid versions and unsafe identifiers", () => {
  class CustomMessage {}
  const inherited = Object.create(message());
  const nullPrototype = Object.assign(Object.create(null), message());
  for (const value of [null, [], new CustomMessage(), inherited, nullPrototype]) {
    assert.throws(() => normalizeAutoListingAiMessage(value), (error) => error?.code === "AUTO_LISTING_AI_MESSAGE_INVALID");
  }
  for (const value of [
    message("PLAN_CONTENT", { contractVersion: 1 }),
    message("PLAN_CONTENT", { contractVersion: "V4" }),
    message("UNKNOWN"),
    message("PLAN_CONTENT", { expectedStatusVersion: 0 }),
    message("PLAN_CONTENT", { expectedStatusVersion: 2 ** 31 }),
    message("PLAN_CONTENT", { correlationId: " has-space" }),
    message("PLAN_CONTENT", { correlationId: "https://example.invalid/secret" }),
    message("PLAN_CONTENT", { correlationId: "api-key-secret" }),
  ]) {
    assert.throws(() => normalizeAutoListingAiMessage(value), (error) => error?.code === "AUTO_LISTING_AI_MESSAGE_INVALID");
  }
});

test("rejects symbol, non-enumerable, and accessor fields instead of silently dropping hidden data", () => {
  const withSymbol = message();
  withSymbol[Symbol("secret")] = "hidden";
  const withHidden = message();
  Object.defineProperty(withHidden, "rawSecret", { value: "hidden", enumerable: false });
  const withAccessor = message();
  Object.defineProperty(withAccessor, "correlationId", {
    enumerable: true,
    get() { throw new Error("raw database password"); },
  });
  for (const value of [withSymbol, withHidden, withAccessor]) {
    assert.throws(() => normalizeAutoListingAiMessage(value), (error) => {
      assert.equal(error?.code, "AUTO_LISTING_AI_MESSAGE_INVALID");
      assert.doesNotMatch(error?.message || "", /raw database password|hidden/);
      return true;
    });
  }
});

test("keeps the aggregate UTF-8 byte ceiling above the largest valid closed message", () => {
  const atIdentifierLimit = `a${"界".repeat(79)}aa`;
  const largestClosedMessage = message("GENERATE_IMAGE_SLOT", {
    accountId: atIdentifierLimit,
    itemId: atIdentifierLimit,
    correlationId: atIdentifierLimit,
    slotKey: atIdentifierLimit,
  });
  assert.equal(AUTO_LISTING_AI_MESSAGE_MAX_UTF8_BYTES, 2_048);
  assert.ok(Buffer.byteLength(JSON.stringify(largestClosedMessage), "utf8") <= AUTO_LISTING_AI_MESSAGE_MAX_UTF8_BYTES);
  assert.doesNotThrow(() => normalizeAutoListingAiMessage(largestClosedMessage));
});

test("uses one 240 UTF-8 byte identifier contract for every message identifier", () => {
  const atAsciiLimit = "a".repeat(240);
  const overAsciiLimit = "a".repeat(241);
  const atMultibyteLimit = `a${"界".repeat(79)}aa`;
  const overMultibyteLimit = `a${"界".repeat(80)}`;
  assert.equal(Buffer.byteLength(atMultibyteLimit, "utf8"), 240);
  assert.equal(Buffer.byteLength(overMultibyteLimit, "utf8"), 241);

  for (const key of ["accountId", "itemId", "correlationId"]) {
    assert.doesNotThrow(() => normalizeAutoListingAiMessage(message("PLAN_CONTENT", { [key]: atAsciiLimit })));
    assert.doesNotThrow(() => normalizeAutoListingAiMessage(message("PLAN_CONTENT", { [key]: atMultibyteLimit })));
    for (const value of [overAsciiLimit, overMultibyteLimit]) {
      assert.throws(
        () => normalizeAutoListingAiMessage(message("PLAN_CONTENT", { [key]: value })),
        (error) => error?.code === "AUTO_LISTING_AI_MESSAGE_INVALID",
      );
    }
  }
  for (const [phase, key] of [["MATERIALIZE_SOURCE_ASSET", "sourceAssetId"], ["GENERATE_IMAGE_SLOT", "slotKey"]]) {
    assert.doesNotThrow(() => normalizeAutoListingAiMessage(message(phase, { [key]: atMultibyteLimit })));
    assert.throws(
      () => normalizeAutoListingAiMessage(message(phase, { [key]: overMultibyteLimit })),
      (error) => error?.code === "AUTO_LISTING_AI_MESSAGE_INVALID",
    );
  }
});

test("rejects URL, IP, and common raw credential values without rejecting safe raw-prefixed IDs", () => {
  for (const value of [
    "evil.example.com",
    "169.254.169.254",
    "2001:db8::1",
    "sk-proj-abcdefghijklmnop",
    "AKIAABCDEFGHIJKLMNOP",
  ]) {
    assert.throws(
      () => normalizeAutoListingAiMessage(message("PLAN_CONTENT", { correlationId: value })),
      (error) => error?.code === "AUTO_LISTING_AI_MESSAGE_INVALID",
    );
  }
  assert.equal(normalizeAutoListingAiMessage(message("PLAN_CONTENT", { correlationId: "raw-source-1" })).correlationId, "raw-source-1");
});

test("normalizes every proxy trap failure to the fixed safe message error", () => {
  const rawSecret = "DATABASE_PASSWORD=leaked";
  for (const proxy of [
    new Proxy(message(), { getPrototypeOf() { throw new Error(rawSecret); } }),
    new Proxy(message(), { ownKeys() { throw new Error(rawSecret); } }),
    new Proxy(message(), { getOwnPropertyDescriptor() { throw new Error(rawSecret); } }),
  ]) {
    assert.throws(() => normalizeAutoListingAiMessage(proxy), (error) => {
      assert.equal(error?.code, "AUTO_LISTING_AI_MESSAGE_INVALID");
      assert.equal(error?.message, "自动上架 AI 消息无效");
      assert.doesNotMatch(error?.message || "", /DATABASE_PASSWORD/);
      return true;
    });
  }
});

test("canonical serialization and dedupe are deterministic and never include forbidden data", () => {
  const first = message("GENERATE_IMAGE_SLOT");
  const reordered = {
    slotKey: first.slotKey,
    correlationId: first.correlationId,
    expectedStatusVersion: first.expectedStatusVersion,
    phase: first.phase,
    itemId: first.itemId,
    accountId: first.accountId,
    contractVersion: first.contractVersion,
  };
  assert.equal(canonicalizeAutoListingAiMessage(first), canonicalizeAutoListingAiMessage(reordered));
  assert.equal(autoListingAiMessageDedupeKey(first), autoListingAiMessageDedupeKey(reordered));
  assert.match(autoListingAiMessageDedupeKey(first), /^[a-f0-9]{64}$/);
  assert.equal(canonicalizeAutoListingAiMessage(first), '{"accountId":"account-a","contractVersion":"V3","correlationId":"correlation-a","expectedStatusVersion":2,"itemId":"item-a","phase":"GENERATE_IMAGE_SLOT","slotKey":"main-1"}');
});

test("dedupe follows stable business identity while the normalized message keeps correlation trace data", () => {
  const first = message("PLAN_CONTENT", { correlationId: "trace-first" });
  const retraced = message("PLAN_CONTENT", { correlationId: "trace-retry" });

  assert.equal(normalizeAutoListingAiMessage(retraced).correlationId, "trace-retry");
  assert.equal(autoListingAiMessageDedupeKey(first), autoListingAiMessageDedupeKey(retraced));

  assert.notEqual(
    autoListingAiMessageDedupeKey(first),
    autoListingAiMessageDedupeKey(message("PLAN_CONTENT", { correlationId: "trace-first", expectedStatusVersion: 3 })),
  );
  assert.notEqual(
    autoListingAiMessageDedupeKey(first),
    autoListingAiMessageDedupeKey(message("GENERATE_RICH_CONTENT", { correlationId: "trace-first" })),
  );
  assert.notEqual(
    autoListingAiMessageDedupeKey(message("MATERIALIZE_SOURCE_ASSET", { correlationId: "trace-first", sourceAssetId: "source-a" })),
    autoListingAiMessageDedupeKey(message("MATERIALIZE_SOURCE_ASSET", { correlationId: "trace-retry", sourceAssetId: "source-b" })),
  );
  assert.notEqual(
    autoListingAiMessageDedupeKey(message("GENERATE_IMAGE_SLOT", { correlationId: "trace-first", slotKey: "main-1" })),
    autoListingAiMessageDedupeKey(message("GENERATE_IMAGE_SLOT", { correlationId: "trace-retry", slotKey: "detail-1" })),
  );
});
