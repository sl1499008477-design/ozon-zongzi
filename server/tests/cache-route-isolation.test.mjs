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
    token_c: { token: "token_c", accountId: "acct_c", issuedAt: "2026-07-27T00:00:00.000Z" },
  },
  accounts: [
    { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" },
    { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" },
    { id: "acct_c", username: "c", displayName: "C", role: "admin", status: "active" },
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
    collectBox: [
      {
        id: "collect_a",
        accountId: "acct_a",
        storeId: "store_a",
        localStoreId: "store_a",
        dataCollectionStoreId: "data_store_a",
        createdBy: "old-creator-a",
        sellerCompanyId: "old-seller-a",
        legacyScope: {
          operatingStoreId: "forged-operating-a",
          dataCollectionStoreId: "forged-data-a",
          sellerCompanyId: "forged-seller-a",
          arbitrary: "forged-a",
        },
        sku: "legacy-sku-a",
        name: "collect A",
      },
      {
        id: "collect_b",
        accountId: "acct_b",
        storeId: "store_b",
        localStoreId: "store_b",
        dataCollectionStoreId: "data_store_b",
        createdBy: "old-creator-b",
        sellerCompanyId: "old-seller-b",
        sku: "legacy-sku-b",
        name: "collect B",
      },
      {
        id: "collect_c_listing_ready",
        accountId: "acct_c",
        sku: "listing-ready-c",
        name: "collect C listing ready",
        listingDraft: {
          sku: "listing-ready-c",
          title: "Store-neutral listing item",
          price: "100",
          currencyCode: "CNY",
          descriptionCategoryId: 17028941,
          typeId: 91670,
          packageWeight: "799",
          packageLength: "350",
          packageWidth: "85",
          packageHeight: "50",
          listingWarehouseId: "1020003087687000",
          listingStock: "5",
          images: ["https://cdn.example.test/main.jpg"],
        },
      },
    ],
    favorites: scopedPair("favorite"),
    promotions: scopedPair("promotion"),
    returns: scopedPair("return"),
    refunds: scopedPair("refund"),
    announcements: [{ id: "announcement_global", title: "Global" }],
    messageTemplates: scopedPair("message_template"),
    messageHistory: scopedPair("message_history"),
    productTemplates: scopedPair("product_template"),
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
  const href = String(url);
  ozonRequests.push(href);
  if (href.endsWith("/scrape")) {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        url: "https://www.ozon.ru/product/scraped-zero-store-7003/",
        title: "Scraped without a bound store",
        price: "77",
        priceText: "77 ₽",
        primaryImage: "https://cdn.example.test/scraped.jpg",
        images: ["https://cdn.example.test/scraped.jpg"],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ code: "OZON_UNAVAILABLE" }), { status: 503 });
};

const firstId = (payload) => {
  const list = Array.isArray(payload) ? payload : payload?.data || payload?.items || payload?.records || [];
  return list.map((item) => item.id);
};

const retiredPublicScopeKeys = new Set([
  "accountid",
  "createdby",
  "clientid",
  "storeid",
  "localstoreid",
  "operatingstoreid",
  "datacollectionstoreid",
  "datacollectionstore",
  "datacollectionstores",
  "datacollectionstoreids",
  "currentdatacollectionstoreid",
  "currentdatacollectionstoreidsbyaccount",
  "sellercompanyid",
  "sellercompany",
  "legacyscope",
]);

function findRetiredPublicScopePath(value, currentPath = "$") {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRetiredPublicScopePath(value[index], `${currentPath}[${index}]`);
      if (found) return found;
    }
    return "";
  }
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${currentPath}.${key}`;
    const canonicalKey = key.replace(/[_-]/g, "").toLowerCase();
    if (retiredPublicScopeKeys.has(canonicalKey)) return childPath;
    const found = findRetiredPublicScopePath(nested, childPath);
    if (found) return found;
  }
  return "";
}

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
    stateA.body.caches.collectBox[0].legacyScope,
    { operatingStoreId: "store_a", dataCollectionStoreId: "data_store_a" },
    "local state must expose historical collection stores only through legacyScope",
  );
  assert.equal("storeId" in stateA.body.caches.collectBox[0], false);
  assert.equal("localStoreId" in stateA.body.caches.collectBox[0], false);
  assert.equal("dataCollectionStoreId" in stateA.body.caches.collectBox[0], false);
  assert.equal("createdBy" in stateA.body.caches.collectBox[0], false);
  assert.equal("sellerCompanyId" in stateA.body.caches.collectBox[0], false);
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
    if (pathname === "/ozon/collect-box") {
      assert.deepEqual(
        response.body.data[0].legacyScope,
        { operatingStoreId: "store_a", dataCollectionStoreId: "data_store_a" },
        "collect-box reads must match the PostgreSQL legacyScope shape",
      );
      assert.equal("storeId" in response.body.data[0], false);
      assert.equal("localStoreId" in response.body.data[0], false);
      assert.equal("dataCollectionStoreId" in response.body.data[0], false);
      assert.equal("createdBy" in response.body.data[0], false);
      assert.equal("sellerCompanyId" in response.body.data[0], false);
    }
  }

  const createCollectEcho = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box",
    {
      id: "collect_create_echo",
      sku: "create-echo-sku",
      productUrl: "https://www.ozon.ru/product/create-echo/",
      createdBy: "caller-creator",
      sellerCompanyId: "caller-seller",
    },
    "token_a",
    "store_a",
  );
  assert.equal(createCollectEcho.status, 200);
  assert.equal(createCollectEcho.body.id, "collect_create_echo");
  assert.equal("createdBy" in createCollectEcho.body, false);
  assert.equal("sellerCompanyId" in createCollectEcho.body, false);

  const zeroStoreSingle = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box",
    {
      id: "collect_zero_store_single",
      productUrl: "https://www.ozon.ru/product/zero-store-single-7001/",
      name: "Zero-store single",
      accountId: "acct_b",
      createdBy: "caller-controlled",
      storeId: "forged-store",
      raw: {
        localStoreId: "forged-nested-store",
        data_collection_store_id: "forged-nested-data-store",
      },
    },
    "token_c",
  );
  assert.equal(zeroStoreSingle.status, 200, "a signed-in account can collect before binding a store");
  assert.equal(zeroStoreSingle.body.id, "collect_zero_store_single");
  assert.equal(findRetiredPublicScopePath(zeroStoreSingle.body), "", "single-add response must be store-neutral");

  const zeroStorePatch = await requestJson(
    handle,
    "PATCH",
    "/ozon/collect-box/collect_zero_store_single",
    {
      name: "Zero-store single updated",
      storeId: "forged-update-store",
      raw: {
        dataCollectionStoreId: "forged-update-data-store",
      },
    },
    "token_c",
  );
  assert.equal(zeroStorePatch.status, 200);
  assert.equal(zeroStorePatch.body.name, "Zero-store single updated");
  assert.equal(findRetiredPublicScopePath(zeroStorePatch.body), "", "updates must not add runtime store scope");

  const zeroStoreScrape = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box/scrape",
    { sku: "7003" },
    "token_c",
  );
  assert.equal(zeroStoreScrape.status, 200, "SKU scrape can save before the account binds a store");
  assert.equal(zeroStoreScrape.body.scraped, true);
  assert.equal(zeroStoreScrape.body.data.sku, "7003");
  assert.equal(findRetiredPublicScopePath(zeroStoreScrape.body.data), "", "scrape response must be store-neutral");

  const zeroStoreBatch = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box/batch",
    {
      items: [{
        id: "collect_zero_store_batch",
        sku: "7002",
        name: "Zero-store batch",
        accountId: "acct_b",
        storeId: "forged-store",
        raw: {
          operatingStoreId: "forged-nested-operating-store",
          dataCollectionStoreId: "forged-nested-data-store",
        },
      }],
    },
    "token_c",
  );
  assert.equal(zeroStoreBatch.status, 200, "legacy Web batch collection can save without a store");
  assert.equal(zeroStoreBatch.body.imported, 1);
  assert.equal(zeroStoreBatch.body.data[0].id, "collect_zero_store_batch");
  assert.equal(findRetiredPublicScopePath(zeroStoreBatch.body.data[0]), "", "batch response must be store-neutral");

  const missingPreviewTarget = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box/collect_c_listing_ready/listing/preview",
    {},
    "token_c",
  );
  assert.equal(missingPreviewTarget.status, 422);
  assert.equal(missingPreviewTarget.body.code, "TARGET_STORE_REQUIRED");

  const missingSubmitTarget = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box/collect_c_listing_ready/listing/submit",
    { idempotencyKey: "zero-store-submit" },
    "token_c",
  );
  assert.equal(missingSubmitTarget.status, 422);
  assert.equal(missingSubmitTarget.body.code, "TARGET_STORE_REQUIRED");

  const ownCollectPatch = await requestJson(
    handle,
    "PATCH",
    "/ozon/collect-box/collect_a",
    { name: "updated legacy item" },
    "token_a",
    "store_a",
  );
  assert.equal(ownCollectPatch.status, 200);
  assert.equal(ownCollectPatch.body.name, "updated legacy item");
  assert.deepEqual(
    ownCollectPatch.body.legacyScope,
    { operatingStoreId: "store_a", dataCollectionStoreId: "data_store_a" },
    "collect-box updates must return the same public legacyScope shape as reads",
  );
  assert.equal("storeId" in ownCollectPatch.body, false);
  assert.equal("localStoreId" in ownCollectPatch.body, false);
  assert.equal("dataCollectionStoreId" in ownCollectPatch.body, false);
  assert.equal("createdBy" in ownCollectPatch.body, false);
  assert.equal("sellerCompanyId" in ownCollectPatch.body, false);

  const ownCollectDraft = await requestJson(
    handle,
    "POST",
    "/ozon/collect-box/collect_a/ai-listing-draft",
    { title: "draft without public scope" },
    "token_a",
    "store_a",
  );
  assert.equal(ownCollectDraft.status, 200);
  assert.equal("createdBy" in ownCollectDraft.body.item, false);
  assert.equal("sellerCompanyId" in ownCollectDraft.body.item, false);

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
    ["/ozon/description-category/20/attributes", "OZON_CATEGORY_TREE_UNAVAILABLE"],
    ["/ozon/description-category/20/attributes/30/values", "OZON_CATEGORY_TREE_UNAVAILABLE"],
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
  const persistedHistoricalCollect = persisted.caches.collectBox
    .find((item) => item.id === "collect_a");
  assert.equal(persistedHistoricalCollect.createdBy, "old-creator-a");
  assert.equal(persistedHistoricalCollect.sellerCompanyId, "old-seller-a");
  for (const id of [
    "collect_zero_store_single",
    "7003",
    "collect_zero_store_batch",
  ]) {
    const item = persisted.caches.collectBox.find((row) => row.id === id);
    assert.ok(item, `${id} must be persisted`);
    assert.equal(item.accountId, "acct_c", `${id} account scope must come from the authenticated session`);
    assert.equal(item.createdBy, "acct_c", `${id} creator must come from the authenticated session`);
    assert.equal("storeId" in item, false);
    assert.equal("localStoreId" in item, false);
    assert.equal("dataCollectionStoreId" in item, false);
    assert.equal(findRetiredPublicScopePath(item.raw), "", `${id} nested raw data must not retain scope fields`);
  }
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
