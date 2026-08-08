import assert from "node:assert/strict";
import test from "node:test";

import { createAutoListingUserWorkflowHttpHandler } from "../auto-listing-user-workflow-routes.mjs";

const actor = Object.freeze({ id: "account-a", role: "user" });
const config = Object.freeze({ targetStoreId: "store-a", targetWarehouseId: "warehouse-a", stock: 5 });

function harness({ enabled = true, limits = { maxBytes: 2_097_152, maxRows: 1_000 } } = {}) {
  const calls = [];
  const replies = [];
  const service = {
    async getOverview(input) { calls.push(["overview", input]); return { preference: null, imports: [] }; },
    async savePreferences(input) { calls.push(["save", input]); return { ...config, configVersion: 1 }; },
    async createExcelImport(input) { calls.push(["import", { ...input, buffer: Buffer.from(input.buffer) }]); return { id: "import-a" }; },
    async getImportDetail(input) { calls.push(["detail", input]); return { id: "import-a", rows: [] }; },
    async retryImport(input) { calls.push(["retry-import", input]); return { id: "import-child", retryOfImportId: "import-a" }; },
  };
  const handler = createAutoListingUserWorkflowHttpHandler({
    isEnabled: () => enabled,
    getExcelLimits: () => limits,
    authenticate: async () => actor,
    getService: async () => service,
    readJson: async (req) => req.body,
    sendJson: (_res, status, payload) => replies.push({ status, payload }),
  });
  return { handler, calls, replies };
}

test("preference GET and PUT use only the authenticated actor and closed version authority", async () => {
  const { handler, calls, replies } = harness();
  await handler({ method: "GET" }, {}, new URL("http://local/auto-listing/preferences"));
  await handler({ method: "PUT", body: {
    config, expectedVersion: 0, idempotencyKey: "pref-a", correlationId: "corr-a",
  } }, {}, new URL("http://local/auto-listing/preferences"));
  assert.deepEqual(calls, [
    ["overview", { actor, importLimit: 50 }],
    ["save", { actor, config, expectedVersion: 0, idempotencyKey: "pref-a", correlationId: "corr-a" }],
  ]);
  assert.deepEqual(replies.map(({ status }) => status), [200, 200]);
});

test("Excel route strictly decodes one bounded base64 body", async () => {
  const { handler, calls, replies } = harness();
  const bytes = Buffer.from("valid workbook bytes");
  await handler({ method: "POST", body: {
    name: "skus.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataBase64: bytes.toString("base64"), sizeBytes: bytes.length,
    config, idempotencyKey: "import-a", correlationId: "corr-a",
  } }, {}, new URL("http://local/auto-listing/imports/excel"));
  assert.equal(replies[0].status, 201);
  assert.deepEqual(calls[0][1].buffer, bytes);
  assert.equal(Object.hasOwn(calls[0][1], "accountId"), false);
});

test("Excel route applies the configured decoded-size limit before service initialization", async () => {
  const { handler, calls, replies } = harness({ limits: { maxBytes: 4, maxRows: 20 } });
  const bytes = Buffer.from("12345");
  await handler({ method: "POST", body: {
    name: "skus.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataBase64: bytes.toString("base64"), sizeBytes: bytes.length,
    config, idempotencyKey: "import-a", correlationId: "corr-a",
  } }, {}, new URL("http://local/auto-listing/imports/excel"));
  assert.equal(calls.length, 0);
  assert.equal(replies[0].status, 400);
});

test("import detail GET is bodyless, account-derived, and path scoped", async () => {
  const { handler, calls, replies } = harness();
  await handler({ method: "GET" }, {}, new URL("http://local/auto-listing/imports/import-a"));
  assert.deepEqual(calls, [["detail", { actor, importId: "import-a" }]]);
  assert.deepEqual(replies[0], { status: 200, payload: { ok: true, data: { id: "import-a", rows: [] } } });
});

test("bodyless GET contracts reject request bodies before service initialization", async () => {
  const { handler, calls, replies } = harness();
  await handler({ method: "GET", headers: { "content-length": "2" } }, {},
    new URL("http://local/auto-listing/imports/import-a"));
  assert.equal(calls.length, 0);
  assert.equal(replies[0].status, 400);
});

test("import retry accepts only versioned idempotent commands", async () => {
  const { handler, calls, replies } = harness();
  await handler({ method: "POST", body: {
    expectedStatusVersion: 4, idempotencyKey: "retry-1", correlationId: "corr-1",
  } }, {}, new URL("http://local/auto-listing/imports/import-a/retry"));
  assert.deepEqual(calls, [["retry-import", { actor, importId: "import-a", expectedStatusVersion: 4,
    idempotencyKey: "retry-1", correlationId: "corr-1" }]]);
  assert.equal(replies[0].status, 202);

  const invalid = harness();
  await invalid.handler({ method: "POST", body: {
    expectedStatusVersion: 4, idempotencyKey: "retry-1", correlationId: "corr-1", accountId: "account-b",
  } }, {}, new URL("http://local/auto-listing/imports/import-a/retry"));
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.replies[0].status, 400);
});

test("disabled, malformed, extra-field, and forged-scope requests fail before service initialization", async () => {
  for (const [enabled, body] of [
    [false, { config, expectedVersion: 0, idempotencyKey: "x", correlationId: "x" }],
    [true, { config, expectedVersion: 0, idempotencyKey: "x", correlationId: "x", accountId: "account-b" }],
    [true, { name: "skus.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      dataBase64: "@@@@", sizeBytes: 3, config, idempotencyKey: "x", correlationId: "x" }],
  ]) {
    let services = 0;
    const replies = [];
    const handler = createAutoListingUserWorkflowHttpHandler({
      isEnabled: () => enabled,
      authenticate: async () => actor,
      getService: async () => { services += 1; return {}; },
      readJson: async () => body,
      sendJson: (_res, status, payload) => replies.push({ status, payload }),
    });
    const path = Object.hasOwn(body, "name") ? "/auto-listing/imports/excel" : "/auto-listing/preferences";
    await handler({ method: path.includes("imports") ? "POST" : "PUT" }, {}, new URL(`http://local${path}`));
    assert.equal(services, 0);
    assert.ok([400, 503].includes(replies[0].status));
  }
});

test("unknown errors and unsupported methods expose stable envelopes", async () => {
  const replies = [];
  const handler = createAutoListingUserWorkflowHttpHandler({
    isEnabled: () => true,
    authenticate: async () => actor,
    getService: async () => ({ getOverview: async () => { throw new Error("password=prod-secret"); } }),
    readJson: async () => ({}),
    sendJson: (_res, status, payload) => replies.push({ status, payload }),
  });
  await handler({ method: "GET" }, {}, new URL("http://local/auto-listing/preferences"));
  await handler({ method: "DELETE" }, {}, new URL("http://local/auto-listing/preferences"));
  assert.deepEqual(replies.map(({ status, payload }) => [status, payload.code]), [
    [500, "AUTO_LISTING_USER_INTERNAL_ERROR"], [405, "AUTO_LISTING_USER_METHOD_NOT_ALLOWED"],
  ]);
  assert.equal(JSON.stringify(replies).includes("prod-secret"), false);
});

test("only explicitly stable business codes cross the user workflow HTTP boundary", async () => {
  const replies = [];
  const errors = [
    Object.assign(new Error("safe business conflict"), {
      code: "AUTO_LISTING_IMPORT_NOT_FOUND", status: 404,
    }),
    Object.assign(new Error("password=prod-secret"), {
      code: "AUTO_LISTING_IMPORT_SQL_DUMP_SECRET", status: 418,
    }),
  ];
  const handler = createAutoListingUserWorkflowHttpHandler({
    isEnabled: () => true,
    authenticate: async () => actor,
    getService: async () => ({ getOverview: async () => { throw errors.shift(); } }),
    readJson: async () => ({}),
    sendJson: (_res, status, payload) => replies.push({ status, payload }),
  });

  await handler({ method: "GET" }, {}, new URL("http://local/auto-listing/preferences"));
  await handler({ method: "GET" }, {}, new URL("http://local/auto-listing/preferences"));

  assert.deepEqual(replies.map(({ status, payload }) => [status, payload.code]), [
    [404, "AUTO_LISTING_IMPORT_NOT_FOUND"],
    [500, "AUTO_LISTING_USER_INTERNAL_ERROR"],
  ]);
  assert.equal(JSON.stringify(replies).includes("prod-secret"), false);
  assert.equal(JSON.stringify(replies).includes("SQL_DUMP"), false);
});
