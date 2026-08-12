import assert from "node:assert/strict";
import test from "node:test";
import { createOzonSourceCategoryLookup } from "../ozon-source-category-lookup.mjs";

function createLookup(responses) {
  const calls = [];
  const lookup = createOzonSourceCategoryLookup({
    transport: async (_store, path, body, _timeout, options) => {
      calls.push({ path, body: structuredClone(body), options: structuredClone(options) });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
    now: () => new Date("2026-08-12T04:00:00.000Z"),
  });
  return { calls, lookup };
}

const input = {
  accountId: "account-a",
  store: { id: "store-a", ownerAccountId: "account-a", clientId: "client", apiKey: "secret" },
  ozonProductId: 4862904234,
  sourceSku: "offer-a",
};

test("exact product ID wins and attributes are fetched only when category facts are missing", async () => {
  const { calls, lookup } = createLookup([
    { result: { id: 4862904234, offer_id: "offer-a" } },
    { result: [{ id: 4862904234, offer_id: "offer-a", description_category_id: 17028702, type_id: 94405, attributes: [] }] },
  ]);
  const result = await lookup.lookup(input);

  assert.equal(result.status, "RESOLVED");
  assert.equal(result.sourceDescriptionCategoryId, 17028702);
  assert.equal(result.sourceTypeId, 94405);
  assert.deepEqual(calls.map(({ path }) => path), [
    "/v2/product/info", "/v4/product/info/attributes",
  ]);
  assert.deepEqual(calls[0].body, { product_id: 4862904234 });
  assert.deepEqual(calls[1].body, { filter: { product_id: ["4862904234"] }, limit: 1 });
  assert.equal(calls.every(({ options }) => options.maxResponseBytes > 0), true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(Object.isFrozen(result), true);
});

test("absent product ID falls back once to exact offer and never performs fuzzy search", async () => {
  const { calls, lookup } = createLookup([
    { result: null },
    { result: { id: 4862904234, offer_id: "offer-a", description_category_id: 17028702, type_id: 94405 } },
  ]);
  const result = await lookup.lookup(input);
  assert.equal(result.status, "RESOLVED");
  assert.deepEqual(calls.map(({ body }) => body), [
    { product_id: 4862904234 }, { offer_id: "offer-a" },
  ]);
  assert.equal(calls.some(({ path }) => /list|search/i.test(path)), false);
});

test("mismatch, authentication, network, malformed, and oversized responses fail closed", async () => {
  const failures = [
    [{ result: { id: 999, offer_id: "other", description_category_id: 1, type_id: 2 } }],
    [Object.assign(new Error("raw credential error"), { status: 401, code: "OZON_HTTP_401" })],
    [Object.assign(new Error("socket ambiguity"), { code: "ECONNRESET" })],
    [{ unexpected: true }],
    [{ result: { id: 4862904234, offer_id: "offer-a", description_category_id: 1, type_id: 2, padding: "x".repeat(300_000) } }],
  ];
  for (const responses of failures) {
    const { lookup } = createLookup(responses);
    const result = await lookup.lookup(input);
    assert.deepEqual(result, {
      status: "UNRESOLVED",
      reasonCode: "OZON_SOURCE_LOOKUP_UNRESOLVED",
    });
    assert.equal(JSON.stringify(result).includes("raw"), false);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("every non-empty requested identity and the attributes identity must match exactly", async () => {
  const cases = [
    [{ result: { id: 4862904234, description_category_id: 1, type_id: 2 } }],
    [{ result: { offer_id: "offer-a", description_category_id: 1, type_id: 2 } }],
    [{ result: { id: 4862904234, offer_id: "other", description_category_id: 1, type_id: 2 } }],
    [
      { result: { id: 4862904234, offer_id: "offer-a" } },
      { result: [{ id: 4862904234, description_category_id: 1, type_id: 2 }] },
    ],
  ];
  for (const responses of cases) {
    const { lookup } = createLookup(responses);
    assert.deepEqual(await lookup.lookup(input), {
      status: "UNRESOLVED",
      reasonCode: "OZON_SOURCE_LOOKUP_UNRESOLVED",
    });
  }
});

test("credential inputs with accessors or proxies fail closed before transport", async () => {
  let calls = 0;
  const lookup = createOzonSourceCategoryLookup({
    transport: async () => { calls += 1; return { result: null }; },
  });
  for (const store of [
    Object.defineProperty({
      id: "store-a", ownerAccountId: "account-a", apiKey: "secret",
    }, "clientId", { enumerable: true, get() { throw new Error("must not execute"); } }),
    new Proxy({
      id: "store-a", ownerAccountId: "account-a", clientId: "client", apiKey: "secret",
    }, { get() { throw new Error("must not execute"); } }),
  ]) {
    const result = await lookup.lookup({ ...input, store });
    assert.equal(result.status, "UNRESOLVED");
  }
  assert.equal(calls, 0);
});
