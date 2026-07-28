import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-cache-route-isolation-"));

process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, method, pathname, body, token, storeId = "") {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = { "content-type": "application/json" };
  if (token) req.headers.authorization = `Bearer ${token}`;
  if (storeId) req.headers["x-ozon-store-id"] = storeId;
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  try {
    await handle(req, res);
  } catch (error) {
    res.writeHead(Number(error?.status || 500));
    res.end(JSON.stringify({
      ok: false,
      code: error?.code || "LOCAL_ERROR",
      message: error?.message || "本地服务异常",
    }));
  }
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}

const scopedPair = (prefix) => ([
  { id: `${prefix}_a`, accountId: "acct_a", storeId: "store_a", name: `${prefix} A` },
  { id: `${prefix}_b`, accountId: "acct_b", storeId: "store_b", name: `${prefix} B` },
]);

const fixture = {
  token: "",
  currentAccountId: "",
  sessionIssuedAt: "",
  sessions: {
    token_a: { token: "token_a", accountId: "acct_a", issuedAt: "2026-07-27T00:00:00.000Z" },
    token_b: { token: "token_b", accountId: "acct_b", issuedAt: "2026-07-27T00:00:00.000Z" },
  },
  accounts: [
    { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" },
    { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" },
  ],
  currentStoreId: "",
  currentStoreIdsByAccount: { acct_a: "store_a", acct_b: "store_b" },
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", apiKey: "mock-key-a", label: "A store" },
    { id: "store_b", ownerAccountId: "acct_b", clientId: "client_b", apiKey: "mock-key-b", label: "B store" },
  ],
  currentDataCollectionStoreId: "",
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
  caches: {
    products: [
      { id: "product_a", accountId: "acct_a", storeId: "store_a", description_category_id: "category_a", type_id: "type_a", category: "Local inferred category A" },
      { id: "product_b", accountId: "acct_b", storeId: "store_b", description_category_id: "category_b", type_id: "type_b", category: "Local inferred category B" },
    ],
    postings: scopedPair("posting"),
    warehouses: scopedPair("warehouse"),
    collectBox: scopedPair("collect"),
    favorites: scopedPair("favorite"),
    promotions: scopedPair("promotion"),
    returns: scopedPair("return"),
    refunds: scopedPair("refund"),
    announcements: [{ id: "announcement_global", title: "Global" }],
    messageTemplates: scopedPair("message_template"),
    messageHistory: scopedPair("message_history"),
    productTemplates: scopedPair("product_template"),
    watermarkTemplates: scopedPair("watermark_template"),
    files: [
      { id: "file_a", createdBy: "acct_a", key: "a.xlsx" },
      { id: "file_b", createdBy: "acct_b", key: "b.xlsx" },
    ],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {
    import_a: { id: "import_a", accountId: "acct_a", storeId: "store_a", type: "PRODUCT_IMPORT", listing: true },
    import_b: { id: "import_b", accountId: "acct_b", storeId: "store_b", type: "PRODUCT_IMPORT", listing: true },
  },
  reports: [],
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const originalFetch = globalThis.fetch;
const ozonRequests = [];
globalThis.fetch = async (url) => {
  ozonRequests.push(String(url));
  return new Response(JSON.stringify({ code: "OZON_UNAVAILABLE" }), { status: 503 });
};

const firstId = (payload) => {
  const list = Array.isArray(payload) ? payload : payload?.data || payload?.items || payload?.records || [];
  return list.map((item) => item.id);
};

try {
  await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(fixture), "utf8");
  const { handle } = await import("../index.mjs");

  const stateA = await requestJson(handle, "GET", "/local/state", undefined, "token_a");
  assert.deepEqual(
    stateA.body.caches.productTemplates.map((item) => item.id),
    ["product_template_a"],
    "ordinary admin state must remain scoped to the signed-in account",
  );
  assert.deepEqual(
    stateA.body.caches.collectBox.map((item) => item.id),
    ["collect_a"],
    "ordinary admin state must not expose another account's collection items",
  );
  assert.deepEqual(
    Object.keys(stateA.body.jobs),
    ["import_a"],
    "ordinary admin state must not expose another account's jobs",
  );
  assert.deepEqual(
    stateA.body.caches.files.map((item) => item.id),
    ["file_a"],
    "ordinary admin state must not expose another account's files",
  );

  const reads = [
    ["/ozon/watermark-settings", ["watermark_template_a"]],
    ["/ozon/collect-box", ["collect_a"]],
    ["/ozon/favorites", ["favorite_a"]],
    ["/ozon/warehouses", ["warehouse_a"]],
    ["/ozon/returns", ["return_a", "refund_a"]],
    ["/ozon/templates", ["product_template_a"]],
    ["/ozon/message-templates", ["message_template_a"]],
    ["/ozon/message-history", ["message_history_a"]],
  ];
  for (const [pathname, expectedIds] of reads) {
    const response = await requestJson(handle, "GET", pathname, undefined, "token_a", "store_a");
    assert.equal(response.status, 200, `${pathname} must be readable`);
    assert.deepEqual(firstId(response.body), expectedIds, `${pathname} must not expose another account`);
  }

  const crossTemplate = await requestJson(
    handle,
    "POST",
    "/ozon/templates/product_template_b/apply",
    {},
    "token_a",
    "store_a",
  );
  assert.equal(crossTemplate.status, 404, "another account's template must not be discoverable");

  const crossDelete = await requestJson(
    handle,
    "DELETE",
    "/ozon/message-templates/message_template_b",
    undefined,
    "token_a",
    "store_a",
  );
  assert.equal(crossDelete.status, 404, "another account's template must not be deletable");

  const crossCollectPatch = await requestJson(
    handle,
    "PATCH",
    "/ozon/collect-box/collect_b",
    { name: "stolen" },
    "token_a",
    "store_a",
  );
  assert.equal(crossCollectPatch.status, 404, "another account's collect item must not be editable");

  const importTasks = await requestJson(
    handle,
    "GET",
    "/ozon/products/import-by-sku/tasks",
    undefined,
    "token_a",
    "store_a",
  );
  assert.deepEqual(firstId(importTasks.body), ["import_a"], "import task history must be account scoped");

  for (const [pathname, expectedCode] of [
    ["/ozon/categories/tree", "OZON_CATEGORY_TREE_UNAVAILABLE"],
    ["/ozon/description-category/type_a/attributes", "OZON_CATEGORY_TREE_UNAVAILABLE"],
    ["/ozon/description-category/type_a/attributes/attribute_a/values", "OZON_CATEGORY_TREE_UNAVAILABLE"],
  ]) {
    const categoryResponse = await requestJson(
      handle,
      "GET",
      pathname,
      undefined,
      "token_a",
      "store_a",
    );
    assert.notEqual(categoryResponse.status, 200, `${pathname} must fail closed when Ozon is unavailable`);
    assert.equal(categoryResponse.body.code, expectedCode);
    const serialized = JSON.stringify(categoryResponse.body);
    for (const localValue of [
      "category_a",
      "category_b",
      "type_a",
      "type_b",
      "Local inferred category A",
      "Local inferred category B",
    ]) {
      assert.equal(serialized.includes(localValue), false, `${pathname} must not expose ${localValue}`);
    }
  }
  assert.equal(ozonRequests.length >= 3, true, "category routes must use only the mocked Ozon client");

  const createTemplate = await requestJson(
    handle,
    "POST",
    "/ozon/message-templates",
    { templateName: "Owned", content: "hello", accountId: "acct_b", storeId: "store_b" },
    "token_a",
    "store_a",
  );
  assert.equal(createTemplate.status, 200);
  assert.equal(createTemplate.body.item.accountId, "acct_a", "server must own the account scope");
  assert.equal(createTemplate.body.item.storeId, "store_a", "server must own the store scope");

  const announcementWrite = await requestJson(
    handle,
    "POST",
    "/ozon/announcements/batch",
    { items: [{ title: "user write" }] },
    "token_b",
    "store_b",
  );
  assert.equal(announcementWrite.status, 403, "global announcements must only be written by an admin");
  assert.equal(announcementWrite.body.code, "PERMISSION_FORBIDDEN");

  const readByB = await requestJson(
    handle,
    "POST",
    "/ozon/announcements/read-all",
    {},
    "token_b",
    "store_b",
  );
  assert.equal(readByB.status, 200);
  const announcementsA = await requestJson(handle, "GET", "/ozon/announcements", undefined, "token_a");
  const announcementsB = await requestJson(handle, "GET", "/ozon/announcements", undefined, "token_b");
  assert.equal(announcementsA.body.data[0].read, false, "one account must not mark announcements read for another");
  assert.equal(announcementsB.body.data[0].read, true);

  const persisted = JSON.parse(await readFile(path.join(dataDir, "local-state.json"), "utf8"));
  assert.ok(
    persisted.caches.messageTemplates.some(
      (item) => item.templateName === "Owned" && item.accountId === "acct_a" && item.storeId === "store_a",
    ),
  );

  console.log("cache route account isolation test passed");
} finally {
  globalThis.fetch = originalFetch;
  await rm(dataDir, { recursive: true, force: true });
}
