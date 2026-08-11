import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingRfbsWarehouseVerifier } from "../auto-listing-rfbs-warehouse-verifier.mjs";

const OBSERVED_AT = "2026-08-11T12:00:00.000Z";

function localTarget(overrides = {}) {
  return {
    id: "warehouse-a",
    accountId: "account-a",
    storeId: "store-a",
    warehouse_id: "1001",
    warehouse_type: "rFBS",
    status: "active",
    is_active: true,
    is_archived: false,
    ...overrides,
  };
}

function remoteWarehouse(overrides = {}) {
  return {
    warehouse_id: "1001",
    warehouse_type: "RFBS",
    status: "active",
    is_active: true,
    is_archived: false,
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    accountId: "account-a",
    actorAccountId: "account-a",
    targetStoreId: "store-a",
    targetWarehouseId: "warehouse-a",
    correlationId: "corr-a",
    ...overrides,
  };
}

function harness({
  target = localTarget(),
  credential = { id: "store-a", clientId: "client-a", apiKey: "api-key-secret" },
  response = { result: { warehouses: [remoteWarehouse()] } },
  loadTarget,
  readCredential,
  callOzonSellerApi,
  now = () => new Date(OBSERVED_AT),
  ttlMs,
} = {}) {
  const calls = [];
  const verifier = createAutoListingRfbsWarehouseVerifier({
    loadTarget: loadTarget || (async (input) => {
      calls.push({ port: "loadTarget", input });
      return target;
    }),
    readCredential: readCredential || (async (input) => {
      calls.push({ port: "readCredential", input });
      return credential;
    }),
    callOzonSellerApi: callOzonSellerApi || (async (receivedCredential, path, body, timeoutMs, options) => {
      calls.push({ port: "callOzonSellerApi", credential: receivedCredential, path, body, timeoutMs, options });
      return response;
    }),
    now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  return { verifier, calls };
}

async function rejectsSafely(operation, code, retryable = false) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.retryable, retryable);
    assert.equal(/api-key-secret|password|authorization|bearer|raw-production-secret/iu.test(String(error?.message)), false);
    assert.equal(Object.hasOwn(error || {}, "body"), false);
    return true;
  });
}

test("returns closed normalized evidence after exactly one read-only warehouse-list call", async () => {
  const { verifier, calls } = harness();

  const evidence = await verifier.verifyRfbsWarehouse(validInput());

  assert.deepEqual(calls.map(({ port }) => port), ["loadTarget", "readCredential", "callOzonSellerApi"]);
  assert.deepEqual(calls[0].input, {
    accountId: "account-a", targetStoreId: "store-a", targetWarehouseId: "warehouse-a",
  });
  assert.deepEqual(calls[1].input, { accountId: "account-a", targetStoreId: "store-a" });
  assert.equal(calls[2].path, "/v2/warehouse/list");
  assert.deepEqual(calls[2].body, {});
  assert.equal(calls[2].timeoutMs, 15_000);
  assert.deepEqual(calls[2].options, { maxResponseBytes: 2 * 1024 * 1024 });
  assert.deepEqual(Object.keys(evidence), [
    "schemaVersion", "accountId", "storeId", "warehouseRecordId", "platformWarehouseId",
    "fulfillmentType", "status", "outcome", "observedAt", "expiresAt", "evidenceHash",
    "correlationId", "actorAccountId",
  ]);
  assert.equal(evidence.schemaVersion, "AUTO_LISTING_RFBS_WAREHOUSE_EVIDENCE_V1");
  assert.equal(evidence.accountId, "account-a");
  assert.equal(evidence.storeId, "store-a");
  assert.equal(evidence.warehouseRecordId, "warehouse-a");
  assert.equal(evidence.platformWarehouseId, "1001");
  assert.equal(evidence.fulfillmentType, "RFBS");
  assert.equal(evidence.status, "ACTIVE");
  assert.equal(evidence.outcome, "PASSED");
  assert.equal(evidence.observedAt, OBSERVED_AT);
  assert.equal(evidence.expiresAt, "2026-08-11T12:10:00.000Z");
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.correlationId, "corr-a");
  assert.equal(evidence.actorAccountId, "account-a");
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(JSON.stringify(evidence).includes("api-key-secret"), false);
});

test("accepts the Ozon RFBS boolean only when it agrees with any explicit type", async () => {
  for (const row of [
    { warehouse_id: "1001", is_rfbs: true, status: "active" },
    { warehouse_id: "1001", is_rfbs: true, warehouse_type: "rfbs", status: "enabled" },
  ]) {
    const { verifier } = harness({ response: { result: [row] } });
    assert.equal((await verifier.verifyRfbsWarehouse(validInput())).fulfillmentType, "RFBS");
  }

  const { verifier } = harness({
    response: { result: [remoteWarehouse({ is_rfbs: false })] },
  });
  await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_WAREHOUSE_CHANGED");
});

test("rejects open, missing, accessor, and proxy inputs before touching any port", async () => {
  for (const input of [
    {},
    validInput({ extra: "open" }),
    { ...validInput(), actorAccountId: "account-b" },
    new Proxy(validInput(), {}),
    Object.defineProperty({ ...validInput() }, "accountId", { enumerable: true, get() { throw new Error("api-key-secret"); } }),
    new Proxy(validInput(), { ownKeys() { throw new Error("password=raw-production-secret"); } }),
  ]) {
    const { verifier, calls } = harness();
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(input), "RFBS_WAREHOUSE_SCOPE_MISMATCH");
    assert.equal(calls.length, 0);
  }
});

test("rejects transparent target and credential proxies before any later sensitive port", async () => {
  {
    const { verifier, calls } = harness({ target: new Proxy(localTarget(), {}) });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "AUTO_LISTING_RFBS_VALIDATION_FAILED");
    assert.deepEqual(calls.map(({ port }) => port), ["loadTarget"]);
  }
  {
    const credential = new Proxy({ id: "store-a", clientId: "client-a", apiKey: "api-key-secret" }, {});
    const { verifier, calls } = harness({ credential });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_VALIDATION_REQUIRED", true);
    assert.deepEqual(calls.map(({ port }) => port), ["loadTarget", "readCredential"]);
  }
});

test("enforces the exact tenant, store, local warehouse, and platform target before reading credentials", async () => {
  const cases = [
    [null, "RFBS_WAREHOUSE_NOT_FOUND"],
    [localTarget({ accountId: "account-b" }), "RFBS_WAREHOUSE_SCOPE_MISMATCH"],
    [localTarget({ storeId: "store-b" }), "RFBS_WAREHOUSE_SCOPE_MISMATCH"],
    [localTarget({ id: "warehouse-b" }), "RFBS_WAREHOUSE_SCOPE_MISMATCH"],
    [localTarget({ warehouse_id: "" }), "RFBS_WAREHOUSE_CHANGED"],
  ];
  for (const [target, code] of cases) {
    const { verifier, calls } = harness({ target });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), code);
    assert.deepEqual(calls.map(({ port }) => port), ["loadTarget"]);
  }
});

test("rejects a locally disabled or no-longer-RFBS target without credential or network access", async () => {
  const cases = [
    [localTarget({ is_active: false }), "RFBS_WAREHOUSE_DISABLED"],
    [localTarget({ is_archived: true }), "RFBS_WAREHOUSE_DISABLED"],
    [localTarget({ status: "blocked" }), "RFBS_WAREHOUSE_DISABLED"],
    [localTarget({ warehouse_type: "FBS" }), "RFBS_WAREHOUSE_CHANGED"],
  ];
  for (const [target, code] of cases) {
    const { verifier, calls } = harness({ target });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), code);
    assert.deepEqual(calls.map(({ port }) => port), ["loadTarget"]);
  }
});

test("rejects internal placeholder platform IDs locally before credentials and in remote evidence", async () => {
  for (const warehouseId of ["wh_internal", "WH_placeholder"]) {
    const { verifier, calls } = harness({ target: localTarget({ warehouse_id: warehouseId }) });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_WAREHOUSE_CHANGED");
    assert.deepEqual(calls.map(({ port }) => port), ["loadTarget"]);
  }

  const { verifier, calls } = harness({
    response: { result: { warehouses: [remoteWarehouse({ warehouse_id: "wh_internal" })] } },
  });
  await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_VALIDATION_REQUIRED", true);
  assert.equal(calls.filter(({ port }) => port === "callOzonSellerApi").length, 1);
});

test("fails closed on missing, wrong-store, or malformed credentials without calling Ozon", async () => {
  for (const [credential, expected] of [
    [null, "RFBS_VALIDATION_REQUIRED"],
    [{ id: "store-b", clientId: "client-a", apiKey: "api-key-secret" }, "RFBS_WAREHOUSE_SCOPE_MISMATCH"],
    [{ clientId: "client-a", apiKey: "api-key-secret" }, "RFBS_WAREHOUSE_SCOPE_MISMATCH"],
    [{ id: "store-a", clientId: "client-a", apiKey: "" }, "RFBS_VALIDATION_REQUIRED"],
    [Object.defineProperty({ id: "store-a", clientId: "client-a" }, "apiKey", {
      enumerable: true, get() { throw new Error("api-key-secret"); },
    }), "RFBS_VALIDATION_REQUIRED"],
  ]) {
    const { verifier, calls } = harness({ credential });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), expected, expected === "RFBS_VALIDATION_REQUIRED");
    assert.deepEqual(calls.map(({ port }) => port), ["loadTarget", "readCredential"]);
  }
});

test("passes only a frozen credential projection to the existing Ozon transport port", async () => {
  const { verifier, calls } = harness({
    credential: {
      id: "store-a",
      ownerAccountId: "account-a",
      clientId: "client-a",
      apiKey: "api-key-secret",
      authorization: "must-not-cross-port",
    },
  });

  await verifier.verifyRfbsWarehouse(validInput());

  const transported = calls.find(({ port }) => port === "callOzonSellerApi").credential;
  assert.deepEqual(transported, { id: "store-a", clientId: "client-a", apiKey: "api-key-secret" });
  assert.equal(Object.isFrozen(transported), true);
});

test("requires one unique exact platform warehouse match", async () => {
  const cases = [
    [{ result: { warehouses: [] } }, "RFBS_WAREHOUSE_NOT_FOUND"],
    [{ result: { warehouses: [remoteWarehouse({ warehouse_id: "1002" })] } }, "RFBS_WAREHOUSE_NOT_FOUND"],
    [{ result: { warehouses: [remoteWarehouse(), remoteWarehouse()] } }, "RFBS_WAREHOUSE_CHANGED"],
  ];
  for (const [response, code] of cases) {
    const { verifier, calls } = harness({ response });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), code);
    assert.equal(calls.filter(({ port }) => port === "callOzonSellerApi").length, 1);
  }
});

test("rejects remote FBS/FBO type changes and disabled states", async () => {
  const cases = [
    [remoteWarehouse({ warehouse_type: "FBS" }), "RFBS_WAREHOUSE_CHANGED"],
    [remoteWarehouse({ warehouse_type: "FBO" }), "RFBS_WAREHOUSE_CHANGED"],
    [remoteWarehouse({ status: "disabled" }), "RFBS_WAREHOUSE_DISABLED"],
    [remoteWarehouse({ is_active: false }), "RFBS_WAREHOUSE_DISABLED"],
    [remoteWarehouse({ is_archived: true }), "RFBS_WAREHOUSE_DISABLED"],
  ];
  for (const [warehouse, code] of cases) {
    const { verifier } = harness({ response: { result: { warehouses: [warehouse] } } });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), code);
  }
});

test("treats malformed, oversized, accessor, and proxy responses as retryable validation requirements", async () => {
  const accessor = { result: {} };
  Object.defineProperty(accessor.result, "warehouses", {
    enumerable: true, get() { throw new Error("api-key-secret"); },
  });
  const proxy = new Proxy({ result: [] }, {
    getOwnPropertyDescriptor() { throw new Error("password=raw-production-secret"); },
  });
  const transparentRootProxy = new Proxy({ result: { warehouses: [remoteWarehouse()] } }, {});
  const transparentArrayProxy = { result: { warehouses: new Proxy([remoteWarehouse()], {}) } };
  const transparentRowProxy = { result: { warehouses: [new Proxy(remoteWarehouse(), {})] } };
  const responses = [
    null,
    { result: { warehouses: "not-an-array" } },
    { result: { warehouses: [remoteWarehouse({ warehouse_id: 1001 })] } },
    { result: { warehouses: [remoteWarehouse({ padding: "x".repeat(2 * 1024 * 1024) })] } },
    accessor,
    proxy,
    transparentRootProxy,
    transparentArrayProxy,
    transparentRowProxy,
  ];
  for (const response of responses) {
    const { verifier, calls } = harness({ response });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_VALIDATION_REQUIRED", true);
    assert.equal(calls.filter(({ port }) => port === "callOzonSellerApi").length, 1);
  }
});

test("maps timeouts and 5xx failures to retryable safe errors without retrying the read", async () => {
  for (const apiError of [
    Object.assign(new Error("api-key-secret timeout"), { code: "OZON_TIMEOUT", status: 504 }),
    Object.assign(new Error("password=raw-production-secret"), { code: "OZON_HTTP_503", status: 503 }),
  ]) {
    let calls = 0;
    const { verifier } = harness({
      callOzonSellerApi: async () => { calls += 1; throw apiError; },
    });
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_VALIDATION_REQUIRED", true);
    assert.equal(calls, 1);
  }
});

test("maps Ozon authentication failures to a non-retryable scope mismatch", async () => {
  let calls = 0;
  const { verifier } = harness({
    callOzonSellerApi: async () => {
      calls += 1;
      throw Object.assign(new Error("authorization Bearer api-key-secret"), { code: "OZON_HTTP_403", status: 403 });
    },
  });
  await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_WAREHOUSE_SCOPE_MISMATCH");
  assert.equal(calls, 1);
});

test("maps unexpected port and clock failures to one stable internal code without third-party text", async () => {
  const cases = [
    { loadTarget: async () => { throw new Error("password=raw-production-secret"); } },
    { readCredential: async () => { throw new Error("api-key-secret"); } },
    { now: () => { throw new Error("authorization Bearer api-key-secret"); } },
  ];
  for (const overrides of cases) {
    const { verifier } = harness(overrides);
    await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "AUTO_LISTING_RFBS_VALIDATION_FAILED");
  }
});

test("rejects evidence that cannot have a future expiry", async () => {
  const { verifier } = harness({ ttlMs: 0 });
  await rejectsSafely(() => verifier.verifyRfbsWarehouse(validInput()), "RFBS_WAREHOUSE_EVIDENCE_EXPIRED");
});

test("factory exposes only the verifier method and rejects invalid dependency contracts", () => {
  const { verifier } = harness();
  assert.deepEqual(Object.keys(verifier), ["verifyRfbsWarehouse"]);
  assert.equal(Object.isFrozen(verifier), true);
  for (const overrides of [
    { loadTarget: null },
    { readCredential: null },
    { callOzonSellerApi: null },
    { now: null },
  ]) {
    assert.throws(() => createAutoListingRfbsWarehouseVerifier({
      loadTarget: async () => null,
      readCredential: async () => null,
      callOzonSellerApi: async () => null,
      now: () => new Date(),
      ...overrides,
    }), TypeError);
  }
});
