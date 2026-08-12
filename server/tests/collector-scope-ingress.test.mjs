import assert from "node:assert/strict";
import test from "node:test";
import { createJsonAccountScopedCollectionHandler } from "../account-scoped-collection-routes.mjs";
import {
  assertCollectorScopeFieldsAbsentV4,
  prepareCollectRequestV4,
} from "../collection-pipeline.mjs";

const retiredKeys = [
  "account-id",
  "created_by",
  "Client_Id",
  "store_id",
  "LOCAL-STORE-ID",
  "operating_store_id",
  "data-collection-store-id",
  "Data_Collection_Stores",
  "data_collection_store_ids",
  "current-data-collection-store-id",
  "CURRENT_DATA_COLLECTION_STORE_IDS_BY_ACCOUNT",
  "seller-company-id",
  "Seller_Company",
  "legacy-scope",
  "storeId",
  "operatingStoreId",
  "dataCollectionStoreId",
];

const serverOwnedCategoryResolutionKeys = [
  "taxonomyScope",
  "category_resolution",
  "targetDescriptionCategoryId",
  "target_type_id",
  "taxonomyFingerprint",
  "credentialStoreId",
  "failureCode",
  "nextAttemptAt",
  "leaseToken",
  "validatedAt",
];

test("V4 ingress rejects every canonical retired scope key at nested array/object depth", () => {
  for (const key of retiredKeys) {
    const input = {
      source: "ozon",
      sourceSku: `sku-${key}`,
      requestId: `request-${key}`,
      payload: {
        keep: true,
        nested: [{ deeper: { [key]: "attacker-controlled" } }],
      },
    };
    assert.throws(
      () => assertCollectorScopeFieldsAbsentV4(input),
      (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
      key,
    );
    assert.throws(
      () => prepareCollectRequestV4({
        authenticatedAccount: { id: "account-authoritative" },
        input,
      }),
      (error) => error?.status === 400 && error?.code === "COLLECTOR_SCOPE_FIELD_FORBIDDEN",
      key,
    );
  }
});

test("V4 ingress accepts a store-neutral nested payload", () => {
  const prepared = prepareCollectRequestV4({
    authenticatedAccount: { id: "account-authoritative" },
    input: {
      source: "ozon",
      sourceSku: "sku-safe",
      requestId: "request-safe",
      payload: { nested: [{ keep: "safe" }] },
    },
  });
  assert.equal(prepared.identity.accountId, "account-authoritative");
  assert.deepEqual(prepared.normalizedItem.nested, [{ keep: "safe" }]);
});

test("V4 ingress rejects server-owned taxonomy and resolution fields at every depth", () => {
  for (const key of serverOwnedCategoryResolutionKeys) {
    assert.throws(
      () => prepareCollectRequestV4({
        authenticatedAccount: { id: "account-authoritative" },
        input: {
          source: "ozon",
          sourceSku: `sku-resolution-${key}`,
          requestId: `request-resolution-${key}`,
          payload: {
            title: "safe",
            variants: [{ evidence: { [key]: "collector-controlled" } }],
          },
        },
      }),
      (error) => error?.status === 400
        && error?.code === "COLLECTOR_RESOLUTION_FIELD_FORBIDDEN"
        && !String(error?.message || "").includes("collector-controlled"),
      key,
    );
  }
});

test("V4 ingress rejects credential-shaped keys at nested array and object depth", () => {
  const sensitiveKeys = [
    "Authorization",
    "SET_COOKIE",
    "client-secret",
    "apiKey",
    "X-API-KEY",
    "PRIVATE_KEY",
    "access_token",
    "RefreshTokenValue",
    "session-token",
    "passwordHash",
    "Credentials",
    "requestHeaders",
    "proxy_headers",
    "auth",
    "jwt",
    "session",
    "cookieJar",
  ];

  for (const sensitiveKey of sensitiveKeys) {
    assert.throws(
      () => prepareCollectRequestV4({
        authenticatedAccount: { id: "account-authoritative" },
        input: {
          source: "ozon",
          sourceSku: `sku-sensitive-key-${sensitiveKey}`,
          requestId: `request-sensitive-key-${sensitiveKey}`,
          payload: {
            sku: "safe-sku",
            variants: [{ attributes: [{ [sensitiveKey]: "must-not-persist" }] }],
          },
        },
      }),
      (error) => error?.status === 400
        && error?.code === "COLLECT_PAYLOAD_SENSITIVE"
        && !String(error?.message || "").includes("must-not-persist"),
      sensitiveKey,
    );
  }
});

test("V4 ingress rejects defensible secret-shaped values without echoing them", () => {
  const fakeLongDigits = ["01234", "56789"].join("");
  const secretValues = [
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "Basic dXNlcjpwYXNzd29yZC1sb25nLWVub3VnaA==",
    "Collector cst_0123456789abcdefghijklmnop",
    "ctt_0123456789abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv",
    "sk-proj-0123456789abcdefghijklmnop",
    "github_pat_11AA0123456789abcdefghijklmnopqrstuv",
    `api_key=${fakeLongDigits}abcdefghijklmnop`,
    "https://cdn.example.test/image.jpg?access_token=0123456789abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
  ];

  for (const [index, secretValue] of secretValues.entries()) {
    assert.throws(
      () => prepareCollectRequestV4({
        authenticatedAccount: { id: "account-authoritative" },
        input: {
          source: "ozon",
          sourceSku: `sku-sensitive-value-${index}`,
          requestId: `request-sensitive-value-${index}`,
          payload: {
            sku: "safe-sku",
            variants: [{ attributes: [{ key: "8229", value: secretValue }] }],
          },
        },
      }),
      (error) => error?.status === 400
        && error?.code === "COLLECT_PAYLOAD_SENSITIVE"
        && !String(error?.message || "").includes(secretValue),
      `secret value ${index}`,
    );
  }
});

test("V4 ingress rejects a secret-shaped value used as an object member name", () => {
  const secretMemberName = "Bearer abcdefghijklmnopqrstuvwxyz012345";
  assert.throws(
    () => prepareCollectRequestV4({
      authenticatedAccount: { id: "account-authoritative" },
      input: {
        source: "ozon",
        sourceSku: "sku-secret-member-name",
        requestId: "request-secret-member-name",
        payload: { attributesByName: { [secretMemberName]: true } },
      },
    }),
    (error) => error?.status === 400
      && error?.code === "COLLECT_PAYLOAD_SENSITIVE"
      && !String(error?.message || "").includes(secretMemberName),
  );
});

test("V4 ingress permits normal catalog prose and URLs that contain auth-related words", () => {
  const payload = {
    sku: "catalog-safe",
    name: "Collector Edition cookie cutter",
    description: "Bearer unavailable; API key sold separately; secret compartment included.",
    secretaryName: "Catalog contact",
    tokenizerModel: "Product taxonomy tokenizer",
    productUrl: "https://shop.example.test/collector-cookie-cutter?tokenized=true&variant=blue",
    images: ["https://cdn.example.test/catalog/bearer-collector.jpg?size=large"],
  };

  const prepared = prepareCollectRequestV4({
    authenticatedAccount: { id: "account-authoritative" },
    input: {
      source: "ozon",
      sourceSku: "catalog-safe",
      requestId: "request-catalog-safe",
      payload,
    },
  });

  assert.equal(prepared.normalizedItem.name, payload.name);
  assert.equal(prepared.normalizedItem.description, payload.description);
  assert.equal(prepared.normalizedItem.secretaryName, payload.secretaryName);
  assert.equal(prepared.normalizedItem.tokenizerModel, payload.tokenizerModel);
  assert.equal(prepared.normalizedItem.productUrl, payload.productUrl);
  assert.deepEqual(prepared.normalizedItem.images, payload.images);
});

function jsonIngressHarness(body) {
  const state = { caches: { collectBox: [] }, collectRequests: [] };
  const response = {};
  let normalized = 0;
  let saved = 0;
  const handler = createJsonAccountScopedCollectionHandler({
    authenticate: async () => ({ id: "account-authoritative" }),
    readJson: async () => body,
    normalizeItem: (item) => {
      normalized += 1;
      return item;
    },
    loadState: async () => state,
    saveState: async () => { saved += 1; },
    stateTransaction: { run: async (operation) => operation() },
    enqueueForCollect: async () => { throw new Error("complete fixture must not enqueue"); },
    completeLinkedJobsFromCollectEvidence: async () => [],
    sendJson: (_res, status, data) => Object.assign(response, { status, body: data }),
    sendError: (_res, status, message, code) => Object.assign(response, {
      status,
      body: { ok: false, message, code },
    }),
    countAccountItems: (nextState) => nextState.caches.collectBox.length,
  });
  return {
    state,
    response,
    get normalized() { return normalized; },
    get saved() { return saved; },
    invoke: () => handler(
      { method: "POST" },
      {},
      new URL("http://localhost/sources/ozon/collect"),
      state,
    ),
  };
}

function completeJsonInput(payload) {
  return {
    source: "ozon",
    sourceSku: String(payload.sku),
    requestId: `request-${payload.sku}`,
    sourceUrl: `https://shop.example.test/product/${payload.sku}`,
    capturedAt: "2026-08-02T00:00:00.000Z",
    payload: {
      ...payload,
      descriptionCategoryId: 17000001,
      logistics: { weightG: 500, lengthMm: 300, widthMm: 200, heightMm: 100 },
    },
  };
}

test("JSON ingress rejects sensitive raw evidence before normalization or persistence", async () => {
  const harness = jsonIngressHarness(completeJsonInput({
    sku: "json-sensitive",
    nested: [{ api_key: "must-not-persist" }],
  }));

  await harness.invoke();

  assert.equal(harness.response.status, 400);
  assert.equal(harness.response.body.code, "COLLECT_PAYLOAD_SENSITIVE");
  assert.equal(harness.normalized, 0);
  assert.equal(harness.saved, 0);
  assert.deepEqual(harness.state.caches.collectBox, []);
  assert.deepEqual(harness.state.collectRequests, []);
});

test("JSON ingress rejects collector-controlled taxonomy state before normalization or persistence", async () => {
  const harness = jsonIngressHarness(completeJsonInput({
    sku: "json-forged-resolution",
    variants: [{
      categoryResolution: {
        status: "MATCHED",
        method: "MANUAL",
        taxonomyScope: "OZON:FORGED",
        targetDescriptionCategoryId: 1,
        targetTypeId: 2,
      },
    }],
  }));

  await harness.invoke();

  assert.equal(harness.response.status, 400);
  assert.equal(harness.response.body.code, "COLLECTOR_RESOLUTION_FIELD_FORBIDDEN");
  assert.equal(harness.normalized, 0);
  assert.equal(harness.saved, 0);
  assert.deepEqual(harness.state.caches.collectBox, []);
  assert.deepEqual(harness.state.collectRequests, []);
});

test("JSON ingress rejects opaque semantic credential containers before normalization or persistence", async () => {
  const fixtures = [
    { auth: "opaque-credential-123" },
    { jwt: "opaque-credential-456" },
    { session: "opaque-credential-789" },
    { cookieJar: [{ name: "sid", value: "short-secret" }] },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const harness = jsonIngressHarness(completeJsonInput({
      sku: `json-sensitive-semantic-${index}`,
      nested: [fixture],
    }));
    await harness.invoke();
    assert.equal(harness.response.status, 400, JSON.stringify(fixture));
    assert.equal(harness.response.body.code, "COLLECT_PAYLOAD_SENSITIVE");
    assert.equal(harness.normalized, 0);
    assert.equal(harness.saved, 0);
    assert.deepEqual(harness.state.caches.collectBox, []);
    assert.deepEqual(harness.state.collectRequests, []);
    assert.doesNotMatch(JSON.stringify(harness.response.body), /opaque-credential|short-secret/);
  }
});

test("JSON ingress preserves validated raw evidence byte-for-value in both audit locations", async () => {
  const input = completeJsonInput({
    sku: "json-safe-raw",
    name: "Collector Edition cookie cutter",
    secretaryName: "Catalog contact",
    productUrl: "https://shop.example.test/collector-cookie-cutter?tokenized=true",
    variants: [{ color: "Bearer blue", images: ["https://cdn.example.test/one.jpg"] }],
  });
  const harness = jsonIngressHarness(input);

  await harness.invoke();

  assert.equal(harness.response.status, 200);
  assert.equal(harness.saved, 1);
  assert.deepEqual(harness.state.caches.collectBox[0].raw, input.payload);
  assert.deepEqual(harness.state.collectRequests[0].rawEvidence.payload, input.payload);
});
