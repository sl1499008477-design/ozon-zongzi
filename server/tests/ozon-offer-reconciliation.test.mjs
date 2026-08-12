import assert from "node:assert/strict";
import test from "node:test";
import { createOzonOfferReconciliation } from "../ozon-offer-reconciliation.mjs";

const input = () => ({
  offers: [{ offerId: "offer-a", sku: "sku-a" }, { offerId: "offer-b", sku: "sku-b" }],
  credential: { clientId: "client-secret", apiKey: "api-secret" },
});

test("confirmOfferAbsent makes one exact bounded product-list read and freezes ABSENT", async () => {
  const calls = [];
  const service = createOzonOfferReconciliation({
    callOzon: async (...args) => {
      calls.push(args);
      return { result: { items: [], total: 0, last_id: "" } };
    },
  });
  const source = input();
  const result = await service.confirmOfferAbsent(source);
  assert.deepEqual(result, { status: "ABSENT", code: "OZON_OFFERS_CONFIRMED_ABSENT" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "/v3/product/list");
  assert.deepEqual(calls[0][2], { filter: { offer_id: ["offer-a", "offer-b"] }, limit: 2 });
});

test("matching offer, matching SKU, or product identity is conservatively PRESENT", async () => {
  for (const item of [
    { offer_id: "offer-a", product_id: 123 },
    { offer_id: "unrelated", sku: "sku-b", product_id: 456 },
  ]) {
    const service = createOzonOfferReconciliation({
      callOzon: async () => ({ result: { items: [item], total: 1, last_id: "" } }),
    });
    assert.deepEqual(await service.confirmOfferAbsent(input()), {
      status: "PRESENT", code: "OZON_OFFER_PRESENT",
    });
  }
});

test("pagination, identity mismatch, malformed response and transport loss are never ABSENT", async () => {
  const outcomes = [
    async () => ({ result: { items: [], total: 1, last_id: "next" } }),
    async () => ({ result: { items: [{ offer_id: "other", product_id: 7 }], total: 1, last_id: "" } }),
    async () => ({ result: { items: [], total: "0", last_id: "" } }),
    async () => { throw new Error("api-secret vendor-message"); },
  ];
  for (const callOzon of outcomes) {
    const service = createOzonOfferReconciliation({ callOzon });
    const result = await service.confirmOfferAbsent(input());
    assert.equal(result.status, "UNKNOWN");
    assert.doesNotMatch(JSON.stringify(result), /secret|vendor-message/u);
  }
});

test("hostile or oversized input fails closed before every port call", async () => {
  const hostile = [];
  const getter = input();
  Object.defineProperty(getter.offers[0], "offerId", { enumerable: true, get() { throw new Error("secret"); } });
  hostile.push(getter);
  hostile.push({ ...input(), offers: new Proxy([], {}) });
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  hostile.push({ ...input(), offers: revoked.proxy });
  const credentialGetter = input();
  Object.defineProperty(credentialGetter.credential, "apiKey", {
    enumerable: true, get() { throw new Error("credential-secret"); },
  });
  hostile.push(credentialGetter);
  hostile.push({ ...input(), offers: [{ offerId: "x".repeat(2_000_001), sku: "sku" }] });
  const cyclic = input();
  cyclic.offers[0].cycle = cyclic.offers[0];
  hostile.push(cyclic);
  const custom = input();
  Object.setPrototypeOf(custom.offers, null);
  hostile.push(custom);

  for (const candidate of hostile) {
    let calls = 0;
    const service = createOzonOfferReconciliation({ callOzon: async () => { calls += 1; } });
    const result = await service.confirmOfferAbsent(candidate);
    assert.deepEqual(result, { status: "UNKNOWN", code: "OZON_OFFER_RECONCILIATION_INVALID" });
    assert.equal(calls, 0);
  }
});

test("hostile and oversized response carriers stay UNKNOWN without leaking or re-reading", async () => {
  const getterResponse = { result: {} };
  Object.defineProperty(getterResponse.result, "items", {
    enumerable: true, get() { throw new Error("response-secret"); },
  });
  Object.defineProperties(getterResponse.result, {
    total: { enumerable: true, value: 0 }, last_id: { enumerable: true, value: "" },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const responses = [
    getterResponse,
    revoked.proxy,
    { result: { items: [{ offer_id: "x".repeat(2_000_001) }], total: 1, last_id: "" } },
  ];
  for (const response of responses) {
    let calls = 0;
    const service = createOzonOfferReconciliation({ callOzon: async () => { calls += 1; return response; } });
    const result = await service.confirmOfferAbsent(input());
    assert.equal(result.status, "UNKNOWN");
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret/u);
  }
});
