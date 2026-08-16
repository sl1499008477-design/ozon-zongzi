import assert from "node:assert/strict";
import { createOzonCategoryRouteHandler } from "../ozon-category-routes.mjs";

const meta = {
  source: "OZON_API",
  fetchedAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2026-07-28T06:00:00.000Z",
};

function createFixture({
  requireAuth = () => ({ id: "acct-auth" }),
  activeStore = (_state, storeId, accountId) => (
    storeId === "store-query" && accountId === "acct-auth"
      ? { id: "store-query", ownerAccountId: "acct-auth" }
      : null
  ),
  categoryService: categoryServiceOverride = {},
} = {}) {
  const calls = {
    activeStore: [],
    categoryService: [],
    sendError: [],
    sendJson: [],
    storeSelection: [],
    reportError: [],
  };
  const categoryService = {
    getCategoryTree: async (input) => {
      calls.categoryService.push({ method: "getCategoryTree", input });
      return { items: [{ description_category_id: 10 }], meta };
    },
    getCategoryAttributes: async (input) => {
      calls.categoryService.push({ method: "getCategoryAttributes", input });
      return { items: [{ id: 30 }], meta };
    },
    getCategoryAttributeValues: async (input) => {
      calls.categoryService.push({ method: "getCategoryAttributeValues", input });
      return { items: [{ id: 40, value: "No brand" }], meta };
    },
    resolveDescriptionCategoryId: async (input) => {
      calls.categoryService.push({ method: "resolveDescriptionCategoryId", input });
      return 10;
    },
    ...categoryServiceOverride,
  };
  const handler = createOzonCategoryRouteHandler({
    categoryService,
    requireAuth,
    storeIdForAccountRequest: (state, account, requestedStoreId) => {
      calls.storeSelection.push({ state, account, requestedStoreId });
      return requestedStoreId || "store-current";
    },
    activeStore: (state, storeId, accountId) => {
      calls.activeStore.push({ state, storeId, accountId });
      return activeStore(state, storeId, accountId);
    },
    sendJson: (res, status, body) => calls.sendJson.push({ res, status, body }),
    sendError: (res, status, message, code) => calls.sendError.push({ res, status, message, code }),
    reportError: (diagnostic) => calls.reportError.push(diagnostic),
  });
  return { calls, handler };
}

function request(path, { method = "GET", headers = {} } = {}) {
  return {
    req: { method, headers },
    res: { id: "response" },
    state: { id: "state" },
    url: new URL(`http://local.test${path}`),
  };
}

{
  const { calls, handler } = createFixture();
  const handled = await handler(request("/ozon/categories/tree/"));
  assert.equal(handled, false);
  assert.deepEqual(calls, {
    activeStore: [],
    categoryService: [],
    sendError: [],
    sendJson: [],
    storeSelection: [],
    reportError: [],
  });
}

{
  const { calls, handler } = createFixture();
  const handled = await handler(request(
    "/ozon/categories/tree?storeId=store-query&language=ZH_HANS&accountId=acct-forged",
    { headers: { "x-ozon-store-id": "store-header" } },
  ));
  assert.equal(handled, true);
  assert.deepEqual(calls.storeSelection[0].requestedStoreId, "store-query");
  assert.deepEqual(calls.activeStore[0], {
    state: { id: "state" },
    storeId: "store-query",
    accountId: "acct-auth",
  });
  assert.deepEqual(calls.categoryService, [{
    method: "getCategoryTree",
    input: {
      accountId: "acct-auth",
      store: { id: "store-query", ownerAccountId: "acct-auth" },
      language: "ZH_HANS",
    },
  }]);
  assert.deepEqual(calls.sendJson, [{
    res: { id: "response" },
    status: 200,
    body: {
      data: [{ description_category_id: 10 }],
      items: [{ description_category_id: 10 }],
      total: 1,
      language: "ZH_HANS",
      meta,
    },
  }]);
}

{
  const { calls, handler } = createFixture();
  const handled = await handler(request(
    "/ozon/description-category/20/attributes?storeId=store-query&description_category_id=10&account_id=acct-forged",
  ));
  assert.equal(handled, true);
  assert.deepEqual(calls.categoryService, [{
    method: "getCategoryAttributes",
    input: {
      accountId: "acct-auth",
      store: { id: "store-query", ownerAccountId: "acct-auth" },
      descriptionCategoryId: 10,
      typeId: 20,
      language: "DEFAULT",
    },
  }]);
  assert.deepEqual(calls.sendJson[0].body, {
    data: [{ id: 30 }],
    items: [{ id: 30 }],
    total: 1,
    typeId: 20,
    categoryId: 10,
    meta,
  });
}

{
  const { calls, handler } = createFixture();
  const handled = await handler(request(
    "/ozon/description-category/20/attributes/30/values?storeId=store-query&limit=77",
  ));
  assert.equal(handled, true);
  assert.deepEqual(calls.categoryService, [
    {
      method: "resolveDescriptionCategoryId",
      input: {
        accountId: "acct-auth",
        store: { id: "store-query", ownerAccountId: "acct-auth" },
        typeId: 20,
        language: "DEFAULT",
      },
    },
    {
      method: "getCategoryAttributeValues",
      input: {
        accountId: "acct-auth",
        store: { id: "store-query", ownerAccountId: "acct-auth" },
        descriptionCategoryId: 10,
        typeId: 20,
        attributeId: 30,
        language: "DEFAULT",
        limit: "77",
      },
    },
  ]);
  assert.deepEqual(calls.sendJson[0].body, {
    data: [{ id: 40, value: "No brand" }],
    items: [{ id: 40, value: "No brand" }],
    total: 1,
    typeId: 20,
    categoryId: 10,
    attributeId: 30,
    meta,
  });
}

for (const invalidPath of [
  "/ozon/description-category/0/attributes?storeId=store-query&descriptionCategoryId=10",
  "/ozon/description-category/20/attributes?storeId=store-query&descriptionCategoryId=invalid",
  "/ozon/description-category/20/attributes/-1/values?storeId=store-query&descriptionCategoryId=10",
]) {
  const { calls, handler } = createFixture();
  const handled = await handler(request(invalidPath));
  assert.equal(handled, true);
  assert.deepEqual(calls.categoryService, []);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, [{
    res: { id: "response" },
    status: 400,
    message: "未能从 Ozon 获取真实类目数据，请重试",
    code: "OZON_CATEGORY_DATA_INVALID",
  }]);
}

{
  let ownershipChecks = 0;
  const { calls, handler } = createFixture({
    activeStore: () => {
      ownershipChecks += 1;
      return ownershipChecks === 1 ? { id: "store-query", ownerAccountId: "acct-auth" } : null;
    },
  });
  await assert.rejects(
    () => handler(request("/ozon/description-category/20/attributes?storeId=store-query")),
    (error) => error.status === 404 && error.code === "STORE_NOT_FOUND",
  );
  assert.deepEqual(calls.categoryService.map(({ method }) => method), ["resolveDescriptionCategoryId"]);
  assert.equal(calls.activeStore.length, 2);
  assert.deepEqual(calls.sendJson, []);
}

{
  let authChecks = 0;
  const { calls, handler } = createFixture({
    requireAuth: () => {
      authChecks += 1;
      if (authChecks === 2) throw Object.assign(new Error("revoked-session"), { status: 401 });
      return { id: "acct-auth" };
    },
  });
  await assert.rejects(
    () => handler(request("/ozon/description-category/20/attributes?storeId=store-query")),
    /revoked-session/,
  );
  assert.deepEqual(calls.categoryService.map(({ method }) => method), ["resolveDescriptionCategoryId"]);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, []);
}

{
  let authChecks = 0;
  const { calls, handler } = createFixture({
    requireAuth: () => {
      authChecks += 1;
      if (authChecks === 2) throw Object.assign(new Error("revoked-session"), { status: 401 });
      return { id: "acct-auth" };
    },
  });
  await assert.rejects(
    () => handler(request("/ozon/description-category/20/attributes/30/values?storeId=store-query")),
    /revoked-session/,
  );
  assert.deepEqual(calls.categoryService.map(({ method }) => method), ["resolveDescriptionCategoryId"]);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, []);
}

{
  let ownershipChecks = 0;
  const { calls, handler } = createFixture({
    activeStore: () => {
      ownershipChecks += 1;
      return ownershipChecks === 1 ? { id: "store-query", ownerAccountId: "acct-auth" } : null;
    },
  });
  await assert.rejects(
    () => handler(request("/ozon/description-category/20/attributes/30/values?storeId=store-query")),
    (error) => error.status === 404 && error.code === "STORE_NOT_FOUND",
  );
  assert.deepEqual(calls.categoryService.map(({ method }) => method), ["resolveDescriptionCategoryId"]);
  assert.equal(calls.activeStore.length, 2);
  assert.deepEqual(calls.sendJson, []);
}

{
  const { calls, handler } = createFixture({
    requireAuth: () => {
      throw Object.assign(new Error("需要登录"), { status: 401 });
    },
  });
  await assert.rejects(() => handler(request("/ozon/categories/tree?storeId=store-query")), /需要登录/);
  assert.deepEqual(calls.categoryService, []);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, []);
}

{
  const { calls, handler } = createFixture({ activeStore: () => null });
  await assert.rejects(
    () => handler(request("/ozon/categories/tree?storeId=store-foreign")),
    (error) => error.status === 404 && error.code === "STORE_NOT_FOUND" &&
      error.message === "店铺不存在或不属于当前账号",
  );
  assert.deepEqual(calls.categoryService, []);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, []);
}

{
  const categoryError = Object.assign(new Error("未能从 Ozon 获取真实类目数据，请重试"), {
    status: 502,
    code: "OZON_CATEGORY_TREE_UNAVAILABLE",
    body: { operation: "TREE" },
    cause: null,
  });
  Object.defineProperty(categoryError, "diagnostic", {
    value: Object.freeze({ operation: "TREE", sourceCode: "OZON_TIMEOUT", sourceStatus: null, retryable: true }),
    enumerable: false,
  });
  const { calls, handler } = createFixture({
    categoryService: { getCategoryTree: async () => { throw categoryError; } },
  });
  const handled = await handler(request("/ozon/categories/tree?storeId=store-query"));
  assert.equal(handled, true);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, [{
    res: { id: "response" },
    status: 502,
    message: "未能从 Ozon 获取真实类目数据，请重试",
    code: "OZON_CATEGORY_TREE_UNAVAILABLE",
  }]);
  assert.deepEqual(calls.reportError, [{
    operation: "TREE",
    sourceCode: "OZON_TIMEOUT",
    sourceStatus: null,
    retryable: true,
  }]);
}

{
  const unsafeStableCodeError = Object.assign(new Error("raw upstream credential text"), {
    status: 200,
    code: "OZON_CATEGORY_TREE_UNAVAILABLE",
  });
  const { calls, handler } = createFixture({
    categoryService: { getCategoryTree: async () => { throw unsafeStableCodeError; } },
  });
  const handled = await handler(request("/ozon/categories/tree?storeId=store-query"));
  assert.equal(handled, true);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, [{
    res: { id: "response" },
    status: 502,
    message: "未能从 Ozon 获取真实类目数据，请重试",
    code: "OZON_CATEGORY_TREE_UNAVAILABLE",
  }]);
}

{
  const invalidInputError = Object.assign(new Error("raw caller value"), {
    status: 400,
    code: "OZON_CATEGORY_DATA_INVALID",
    body: { operation: "INPUT" },
    cause: null,
  });
  const { calls, handler } = createFixture({
    categoryService: { getCategoryTree: async () => { throw invalidInputError; } },
  });
  const handled = await handler(request("/ozon/categories/tree?storeId=store-query"));
  assert.equal(handled, true);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, [{
    res: { id: "response" },
    status: 400,
    message: "未能从 Ozon 获取真实类目数据，请重试",
    code: "OZON_CATEGORY_DATA_INVALID",
  }]);
}

{
  const missingTypeError = Object.assign(new Error("raw upstream tree"), {
    status: 422,
    code: "OZON_CATEGORY_TYPE_NOT_FOUND",
    body: { operation: "TYPE" },
    cause: null,
  });
  const { calls, handler } = createFixture({
    categoryService: { resolveDescriptionCategoryId: async () => { throw missingTypeError; } },
  });
  const handled = await handler(request(
    "/ozon/description-category/999/attributes?storeId=store-query",
  ));
  assert.equal(handled, true);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, [{
    res: { id: "response" },
    status: 422,
    message: "未能从 Ozon 获取真实类目数据，请重试",
    code: "OZON_CATEGORY_TYPE_NOT_FOUND",
  }]);
}

{
  const unknownCategoryError = Object.assign(new Error("unexpected category error"), {
    status: 502,
    code: "OZON_CATEGORY_UNEXPECTED",
  });
  const { calls, handler } = createFixture({
    categoryService: { getCategoryTree: async () => { throw unknownCategoryError; } },
  });
  await assert.rejects(
    () => handler(request("/ozon/categories/tree?storeId=store-query")),
    /unexpected category error/,
  );
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, []);
}

{
  const { calls, handler } = createFixture({
    categoryService: { getCategoryTree: async () => { throw new Error("programmer error"); } },
  });
  await assert.rejects(() => handler(request("/ozon/categories/tree?storeId=store-query")), /programmer error/);
  assert.deepEqual(calls.sendJson, []);
  assert.deepEqual(calls.sendError, []);
}

console.log("ozon category routes tests passed");
