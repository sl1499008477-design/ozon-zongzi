import "./support/dedicated-postgres-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createAiListingSubmissionPorts } from "../ai-listing-submission.mjs";
import { createAiListingRuntime } from "../ai-listing-runtime.mjs";
import { createAiListingRepository } from "../ai-listing-repository.mjs";
import { mirrorCollectItemV3, listCollectItemsV3 } from "../listing-pipeline.mjs";
import { closePostgresPool } from "../db/connection.mjs";
import ExcelJS from "exceljs";

const enabled = process.env.SONLI_POSTGRES_TESTS === "1";
const categoryResolution = {status:"ACTIVE",currentDescriptionCategoryId:10,currentTypeId:20};
const availableQuota = {daily_create:{limit:1000,usage:0},total:{limit:1000,usage:0},operation_limits:{limit:0,limit_type:"UNSPECIFIED"}};
const readyProducts = body => ({items:body.offer_id.map(offer_id=>({offer_id,id:321,statuses:{status:"price_sent"}}))});
async function deleteFixtureAccount(pool,accountId){
  await pool.query("DELETE FROM accounts WHERE id=$1",[accountId]);
}
test("accepted task ID survives a failed first journal update and resumes by retry or direct polling", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const accountId = `ai-accepted-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  let failFirstAcceptedSave = false; let imports = 0; let stocks = 0; let polls = 0;
  const faultPool = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, values) {
          if (failFirstAcceptedSave && sql.startsWith("UPDATE ai_image_listing_submissions") && JSON.parse(values[2]).status === "IMPORTED") {
            failFirstAcceptedSave = false;
            throw new Error("test-only transient journal update failure");
          }
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  };
  try {
    const dependencies = { pool: faultPool, reserveCapacity:async()=>({allowed:true}),
      validateTarget: async () => ({ store: { currencyCode: "RUB" }, warehouse: { platformWarehouseId: "123" } }),
      readCredential: async () => ({}), normalizeItems: async items => ({ items }),
      callOzonSellerApi: async (_store, endpoint, body) => {
        if(endpoint === "/v4/product/info/limit")return availableQuota;
        if(endpoint === "/v3/product/info/list")return readyProducts(body);
        if (endpoint === "/v3/product/import") { imports++; return { result: { task_id: 444 } }; }
        if (endpoint === "/v1/product/import/info") {
          polls++; assert.deepEqual(body, { task_id: 444 });
          return { result: { items: [{ offer_id: "offer", product_id: 321, status: "imported", errors: [] }] } };
        }
        assert.equal(endpoint, "/v2/products/stocks"); stocks++;
        return { result: [{ offer_id: "offer", warehouse_id: 123, updated: true, errors: [] }] };
      },
    };
    for (const recovery of ["retry", "poll"]) {
      const input = { accountId, taskId: `task-${recovery}`, idempotencyKey: recovery,
        config: { targetStoreId: "s", targetWarehouseId: "w", stock: 5, priceMultiplier: "1", priceAdjustmentKopecks: 0, brandMode: "PREFER_SOURCE" },
        source: { categoryResolution, sku: "sku", sourceSnapshot: { currency: "RUB", price: "100" }, items: [{ sku: "sku", images: ["https://original/a"], listingItem: { offer_id: "offer" } }] },
        images: [{ sku: "sku", index: 0, generatedUrl: "https://generated/a" }] };
      failFirstAcceptedSave = true;
      await createAiListingSubmissionPorts(dependencies).submitListing(input);
      const row = (await pool.query("SELECT id,body FROM ai_image_listing_submissions WHERE account_id=$1 AND idempotency_key=$2", [accountId, recovery])).rows[0];
      assert.equal(row.body.status, "UNCERTAIN"); assert.equal(row.body.ozonTaskId, "444");
      const restarted = createAiListingSubmissionPorts(dependencies);
      if (recovery === "retry") assert.deepEqual(await restarted.submitListing(input), { submissionId: row.id });
      assert.equal((await restarted.readSubmission({ accountId, submissionId: row.id })).status, "COMPLETED");
      assert.deepEqual(await restarted.submitListing(input), { submissionId: row.id });
    }
    assert.equal(imports, 2); assert.equal(polls, 2); assert.equal(stocks, 2);
  } finally {
    await deleteFixtureAccount(pool,accountId);
    await pool.end();
  }
});

test("submission journal resumes accepted import after restart, checkpoints stock and never resends ambiguous import", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const accountId = `ai-test-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  try {
    const input = { accountId, taskId: "task", idempotencyKey: "stable-key",
      config: { targetStoreId: "s", targetWarehouseId: "w", stock: 5, priceMultiplier: "1", priceAdjustmentKopecks: 0, brandMode: "PREFER_SOURCE" },
      source: { categoryResolution, sku: "sku", sourceSnapshot: { currency: "RUB", price: "100" }, items: [{ sku: "sku", images: ["https://original/a"],
        listingItem: { scraped_sku: "sku", offer_id: "offer", name: "Item", currency_code: "RUB", price: "100" } }] },
      images: [{ sku: "sku", index: 0, generatedUrl: "https://generated/a" }] };
    let imports = 0; let stocks = 0; let ambiguous = false;
    const dependencies = { pool, reserveCapacity:async()=>({allowed:true}),
      validateTarget: async () => ({ store: { id: "s", currencyCode: "RUB" }, warehouse: { platformWarehouseId: "123" } }),
      readCredential: async () => ({ id: "s" }),
      normalizeItems: async items => ({ items }),
      callOzonSellerApi: async (_store, endpoint, body) => {
        if(endpoint === "/v4/product/info/limit")return availableQuota;
        if(endpoint === "/v3/product/info/list")return readyProducts(body);
        if (endpoint === "/v3/product/import") {
          const journal = (await pool.query("SELECT body FROM ai_image_listing_submissions WHERE account_id=$1 AND idempotency_key=$2", [accountId, input.idempotencyKey])).rows[0].body;
          assert.equal(journal.status, "IMPORTING"); assert.equal(journal.items[0].images[0], "https://generated/a");
          imports++; if (ambiguous) throw new Error("network reset");
          return { result: { task_id: 444 } };
        }
        if (endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "offer", product_id: 321, status: "imported", errors: [] }] } };
        assert.equal(endpoint, "/v2/products/stocks"); stocks++;
        assert.deepEqual(body.stocks, [{ offer_id: "offer", warehouse_id: 123, stock: 5 }]);
        return { result: [{ offer_id: "offer", warehouse_id: 123, updated: true, errors: [] }] };
      } };
    const first = createAiListingSubmissionPorts(dependencies);
    const accepted = await first.submitListing(input);
    const restarted = createAiListingSubmissionPorts(dependencies);
    assert.deepEqual(await restarted.submitListing(input), accepted);
    assert.equal((await restarted.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "COMPLETED");
    assert.equal((await restarted.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "COMPLETED");
    assert.equal(imports, 1); assert.equal(stocks, 1);
    await assert.rejects(restarted.readSubmission({ accountId: "other", submissionId: accepted.submissionId }), { statusCode: 404 });
    input.idempotencyKey = "ambiguous"; ambiguous = true;
    const uncertain = await first.submitListing(input);
    await restarted.submitListing({...input,retryAttempt:1});
    assert.equal((await restarted.readSubmission({accountId,submissionId:uncertain.submissionId})).status,"UNCERTAIN");
    assert.equal(imports, 2);
  } finally {
    await deleteFixtureAccount(pool,accountId);
    await pool.end();
  }
});

test("real PostgreSQL routes cover scoped persisted collect source, Excel parser/collection, review, automatic submission and restart", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const accountId = `ai-route-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  let runtime; let account = { id: accountId, role: "admin" }; const submits = [];
  const original = { id: `collect-${randomUUID()}`, sku: "100001", name: "Persisted product", currency: "RUB", price: "100",
    images: Array.from({ length: 8 }, (_, n) => `https://original.example/${n}.jpg`), listingDraft: { sku: "100001", title: "Persisted product" } };
  try {
    await mirrorCollectItemV3(original, { accountId, collectId: original.id, captureRaw: true });
    const before = await listCollectItemsV3({ accountId, ids: [original.id] });
    assert.equal(before.length, 1);
    assert.deepEqual(await listCollectItemsV3({ accountId, ids: ["not-owned"] }), []);
    // This database contains retained audit data: worker claims and background
    // price queries must never reach another account, even in test runtimes.
    const repository=createAiListingRepository({pool});
    repository.claimNext=async({now,leaseMs,leaseToken})=>{
      const claimed=await pool.query(`WITH candidate AS (SELECT id FROM ai_image_listing_tasks WHERE account_id=$1 AND status IN ('QUEUED','COLLECTING','GENERATING','READY_TO_SUBMIT','SUBMITTING','SUBMITTED') AND next_run_at<=$2 AND (lease_token IS NULL OR lease_expires_at<=$2) ORDER BY next_run_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE ai_image_listing_tasks t SET lease_token=$3,lease_expires_at=$2::bigint+$4::bigint,version=t.version+1 FROM candidate WHERE t.id=candidate.id AND t.account_id=$1 RETURNING t.id`,[accountId,now,leaseToken,leaseMs]);
      return claimed.rows[0]?repository.get({accountId,taskId:claimed.rows[0].id}):null;
    };
    const runtimePool={connect:()=>pool.connect(),query:(sql,values)=>sql.includes('FROM ai_user_channels c')?Promise.resolve({rows:[]}):pool.query(sql,values)};
    const ports = { repository, resolvePool: async () => runtimePool, authenticate: async () => account,
      readJson: async req => req.body, sendJson: (res, status, body) => Object.assign(res, { status, body }),
      validateTarget: async ({ config }) => { if (config.targetStoreId !== "store") throw Object.assign(new Error("scope"), { statusCode: 403 }); },
      checkAccount: async () => account,
      buildListingItems: item => [{ scraped_sku: item.sku, offer_id: item.sku, name: item.name, description_category_id:10,type_id:20,weight:230,depth:120,width:130,height:140 }],
      generateImage: async ({ index }) => ({ generatedUrl: `https://generated.example/${index}.png` }),
      submitListing: async input => { submits.push(input); return { submissionId: `submission-${submits.length}` }; },
      readSubmission: async () => ({ status: "COMPLETED" }),
      collectSku: async ({ account: scopedAccount, sku }) => {
        assert.equal(scopedAccount.id, accountId);
        const item = { ...original, id: `collect-${randomUUID()}`, sku };
        await mirrorCollectItemV3(item, { accountId, collectId: item.id, captureRaw: true });
        return { item };
      },
    };
    runtime = createAiListingRuntime(ports);
    // Vite strips /api before forwarding to the production server.
    const request = async (method, path, body) => { const res = {}; assert.equal(await runtime.handleRoute({ method, body }, res, new URL(`http://localhost/ai-listing${path}`)), true); return res; };
    const config = { targetStoreId: "store", targetWarehouseId: "warehouse", manualReview: true };
    const created = await request("POST", "/tasks/from-collect-box", { collectItemIds: [original.id], idempotencyKey: "collect", config });
    assert.equal(created.status, 201);
    const id = created.body.tasks[0].id;
    await runtime.start(); await runtime.stop();
    assert.equal((await request("GET", `/tasks/${id}`)).body.task.status, "AWAITING_REVIEW");
    assert.equal(submits.length, 0);
    runtime = createAiListingRuntime(ports);
    assert.equal((await request("GET", `/tasks/${id}`)).body.task.images.length, 8);
    await request("POST", `/tasks/${id}/approve`, {});
    await runtime.start(); await runtime.stop();
    assert.equal(submits.length, 1);
    assert.deepEqual(await listCollectItemsV3({ accountId, ids: [original.id] }), before);
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("SKU"); sheet.addRows([["SKU"], ["200002"], ["200002"]]);
    const contentBase64 = Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
    const excel = await request("POST", "/imports/excel", { name: "products.xlsx", contentBase64, idempotencyKey: "excel", config: { ...config, manualReview: false } });
    assert.equal(excel.status, 201); assert.equal(excel.body.tasks.length, 1); assert.equal(excel.body.errors.length, 1);
    await runtime.start(); await runtime.stop();
    assert.equal(submits.length, 2); assert.equal(submits[1].source.sku, "200002");
    const bad = await request("POST", "/tasks/from-collect-box", { collectItemIds: [original.id], idempotencyKey: "bad", config: { ...config, targetStoreId: "other" } });
    assert.equal(bad.status, 403);
    account = { id: "other", role: "admin" };
    assert.equal((await request("GET", `/tasks/${id}`)).status, 404);
    account = { id: accountId, role: "user" };
    const ownList=await request("GET", "/tasks");
    assert.equal(ownList.status,200);
    assert.ok(ownList.body.tasks.some(task=>task.id===id));
    assert.ok(ownList.body.tasks.every(task=>!("generationChannel" in task)&&!("channelHistory" in task)));
  } finally {
    await runtime?.stop();
    await pool.query("DELETE FROM collect_raw_payloads WHERE account_id=$1", [accountId]);
    await pool.query("DELETE FROM collect_items WHERE account_id=$1", [accountId]);
    await deleteFixtureAccount(pool,accountId);
    await pool.end(); await closePostgresPool();
  }
});

test("stock retry after restart preserves completed variants and never imports a second time", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const accountId = `ai-stock-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  let imports = 0; const stocks = []; let failSecond = true;
  try {
    const input = { accountId, taskId: "task-stock", idempotencyKey: "stock-key", config: { targetStoreId: "s", targetWarehouseId: "w", stock: 5,
      priceMultiplier: "1", priceAdjustmentKopecks: 0, brandMode: "PREFER_SOURCE" },
      source: { categoryResolution, sku: "a", sourceSnapshot: { currency: "RUB", price: "100", listingDraft: { variants: [{ sku: "b", currency: "RUB", price: "120" }] } },
        items: ["a", "b"].map(sku => ({ sku, images: [`https://original/${sku}`], listingItem: { scraped_sku: sku, offer_id: sku } })) },
      images: ["a", "b"].map(sku => ({ sku, index: 0, generatedUrl: `https://generated/${sku}` })) };
    const ports = { pool, reserveCapacity:async()=>({allowed:true}), validateTarget: async () => ({ store: { currencyCode: "RUB" }, warehouse: { platformWarehouseId: "123" } }),
      readCredential: async () => ({}), normalizeItems: async items => ({ items }),
      callOzonSellerApi: async (_store, endpoint, body) => {
        if(endpoint === "/v4/product/info/limit")return availableQuota;
        if(endpoint === "/v3/product/info/list")return readyProducts(body);
        if (endpoint === "/v3/product/import") { imports++; return { result: { task_id: 567 } }; }
        if (endpoint === "/v1/product/import/info") return { result: { items: ["a", "b"].map((offer_id, i) => ({ offer_id, product_id: 400 + i, status: "imported", errors: [] })) } };
        const result=body.stocks.map(stock=>{stocks.push(stock.offer_id);if(stock.offer_id==="b"&&failSecond){failSecond=false;return {...stock,updated:false,errors:[{code:"WAREHOUSE_NOT_AVAILABLE"}]};}return {...stock,updated:true,errors:[]};});
        return {result};
      } };
    const first = createAiListingSubmissionPorts(ports); const accepted = await first.submitListing(input);
    assert.equal((await first.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "FAILED");
    const restarted = createAiListingSubmissionPorts(ports);
    await restarted.submitListing({...input,retryAttempt:1});
    assert.equal((await restarted.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "COMPLETED");
    assert.equal(imports, 1); assert.deepEqual(stocks, ["a", "b", "b"]);
  } finally { await deleteFixtureAccount(pool,accountId); await pool.end(); }
});

test("production target boundary scopes persisted stores and RFBS warehouses before external writes", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const accountId = `ai-target-${randomUUID()}`;
  const storeId = `store-${randomUUID()}`; const warehouseId = `warehouse-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  try {
    await pool.query(`INSERT INTO stores(id,client_id,owner_account_id,status,currency_code,currency_source,currency_synced_at)
      VALUES($1,$1,$2,'active','CNY','OZON_SELLER_INFO',NOW())`, [storeId, accountId]);
    await pool.query("INSERT INTO store_credentials(store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES($1,$1,'test','test','test')", [storeId]);
    await pool.query("INSERT INTO warehouses(id,store_id,warehouse_id,warehouse_type,status) VALUES($1,$2,'1001','RFBS','active')", [warehouseId, storeId]);
    const routes=[];
    const ports = createAiListingSubmissionPorts({ pool,
      readCredential: async ({ accountId: scopedAccount, targetStoreId }) => {
        assert.equal(scopedAccount, accountId); assert.equal(targetStoreId, storeId);
        return { id: storeId, clientId: "test-client", apiKey: "test-only",ozonRoute:'CN' };
      },
      callOzonSellerApi: async (credential, endpoint) => {
        assert.equal(endpoint, "/v2/warehouse/list");routes.push(credential.ozonRoute);
        if(credential.ozonRoute==='CN')throw Object.assign(new Error('fixture bad gateway'),{code:'ZONGZI_HTTP_502',status:502});
        return { result: { warehouses: [{ warehouse_id: "1001", warehouse_type: "RFBS", status: "active", is_active: true, is_archived: false }] } };
      },
    });
    const config = { targetStoreId: storeId, targetWarehouseId: warehouseId,ozonRoute:'CN' },before=structuredClone(config);
    const result = await ports.validateTarget({ accountId, config });
    assert.equal(result.store.currencyCode, "CNY"); assert.equal(result.warehouse.platformWarehouseId, "1001");
    await assert.rejects(ports.validateTarget({ accountId: "other", config }), { code: "TARGET_STORE_NOT_FOUND" });
    await pool.query("UPDATE warehouses SET is_active=false WHERE id=$1", [warehouseId]);
    await assert.rejects(ports.validateTarget({ accountId, config }), { code: "RFBS_WAREHOUSE_DISABLED" });
    assert.deepEqual(routes,['CN','RU']);assert.deepEqual(config,before,'read fallback never rewrites the frozen submission route');
  } finally {
    await pool.query("DELETE FROM stores WHERE id=$1", [storeId]);
    await deleteFixtureAccount(pool,accountId); await pool.end();
  }
});

test("production FBS target uses persisted active association and completes import/stock without RFBS verification", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const accountId = `ai-fbs-${randomUUID()}`;
  const storeId = `store-${randomUUID()}`; const warehouseId = `warehouse-${randomUUID()}`; const productId = `product-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  try {
    await pool.query(`INSERT INTO stores(id,client_id,owner_account_id,status,currency_code,currency_source,currency_synced_at)
      VALUES($1,$1,$2,'active','CNY','OZON_SELLER_INFO',NOW())`, [storeId, accountId]);
    await pool.query("INSERT INTO store_credentials(store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES($1,$1,'test','test','test')", [storeId]);
    await pool.query("INSERT INTO warehouses(id,store_id,warehouse_id,warehouse_type,status) VALUES($1,$2,'1001','FBS','active')", [warehouseId, storeId]);
    await pool.query("INSERT INTO products(id,store_id) VALUES($1,$2)", [productId, storeId]);
    await pool.query("INSERT INTO product_stocks(product_id,warehouse_id,store_id,source,present) VALUES($1,$2,$3,'fbs',0)", [productId, warehouseId, storeId]);
    let imports = 0; let stocks = 0;
    const ports = createAiListingSubmissionPorts({ pool, reserveCapacity:async()=>({allowed:true}), normalizeItems: async items => ({ items }),
      readCredential: async () => ({ id: storeId, clientId: "test-client", apiKey: "test-only" }),
      callOzonSellerApi: async (_credential, endpoint, body) => {
        if(endpoint === "/v4/product/info/limit")return availableQuota;
        if(endpoint === "/v3/product/info/list")return readyProducts(body);
        assert.notEqual(endpoint, "/v2/warehouse/list");
        if (endpoint === "/v3/product/import") { imports++; return { result: { task_id: 444 } }; }
        if (endpoint === "/v1/product/import/info") return { result: { items: [{ offer_id: "offer", product_id: 321, status: "imported", errors: [] }] } };
        assert.equal(endpoint, "/v2/products/stocks"); stocks++;
        assert.deepEqual(body.stocks, [{ offer_id: "offer", warehouse_id: 1001, stock: 5 }]);
        return { result: [{ offer_id: "offer", warehouse_id: 1001, updated: true, errors: [] }] };
      },
    });
    const config = { targetStoreId: storeId, targetWarehouseId: warehouseId, stock: 5, priceMultiplier: "1", priceAdjustmentKopecks: 0, brandMode: "PREFER_SOURCE" };
    const target = await ports.validateTarget({ accountId, config });
    assert.equal(target.warehouse.platformWarehouseId, "1001"); assert.equal(target.warehouse.fulfillmentType, "FBS");
    const accepted = await ports.submitListing({ accountId, config, taskId: "task-fbs", idempotencyKey: "fbs",
      source: { categoryResolution, sku: "sku", sourceSnapshot: { currency: "CNY", price: "100" }, items: [{ sku: "sku", images: ["https://original/a"], listingItem: { offer_id: "offer" } }] },
      images: [{ sku: "sku", index: 0, generatedUrl: "https://generated/a" }] });
    assert.equal((await ports.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "COMPLETED");
    assert.equal(imports, 1); assert.equal(stocks, 1);
    await assert.rejects(ports.validateTarget({ accountId: "other", config }), { code: "TARGET_STORE_NOT_FOUND" });
    await assert.rejects(ports.validateTarget({ accountId, config: { ...config, targetWarehouseId: "foreign-warehouse" } }), { code: "LISTING_WAREHOUSE_NOT_ELIGIBLE" });
    for (const change of ["is_active=false", "is_active=true,is_archived=true", "is_archived=false,warehouse_type='FBO'"]) {
      await pool.query(`UPDATE warehouses SET ${change} WHERE id=$1`, [warehouseId]);
      await assert.rejects(ports.validateTarget({ accountId, config }), { code: "LISTING_WAREHOUSE_NOT_ELIGIBLE" });
    }
    await pool.query("UPDATE warehouses SET warehouse_type='FBS' WHERE id=$1", [warehouseId]);
    await pool.query("UPDATE products SET is_archived=true WHERE id=$1", [productId]);
    await assert.rejects(ports.validateTarget({ accountId, config }), { code: "LISTING_WAREHOUSE_NOT_ELIGIBLE" });
  } finally { await pool.query("DELETE FROM stores WHERE id=$1", [storeId]); await deleteFixtureAccount(pool,accountId); await pool.end(); }
});

test("accepted RFBS import keeps polling through warehouse outage but stock waits for one valid batch check", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const accountId = `ai-poll-${randomUUID()}`;
  const storeId = `store-${randomUUID()}`; const warehouseId = `warehouse-${randomUUID()}`;
  await pool.query("INSERT INTO accounts(id,username,role) VALUES($1,$1,'admin')", [accountId]);
  try {
    await pool.query(`INSERT INTO stores(id,client_id,owner_account_id,status,currency_code,currency_source,currency_synced_at)
      VALUES($1,$1,$2,'active','RUB','OZON_SELLER_INFO',NOW())`, [storeId, accountId]);
    await pool.query("INSERT INTO store_credentials(store_id,client_id,encrypted_api_key,iv,auth_tag) VALUES($1,$1,'test','test','test')", [storeId]);
    await pool.query("INSERT INTO warehouses(id,store_id,warehouse_id,warehouse_type,status) VALUES($1,$2,'1001','RFBS','active')", [warehouseId, storeId]);
    let unavailable = false; let imported = false; let warehouseReads = 0; let polls = 0; let stocks = 0;
    const ports = createAiListingSubmissionPorts({ pool, reserveCapacity:async()=>({allowed:true}), normalizeItems: async items => ({ items }),
      readCredential: async () => ({ id: storeId, clientId: "test-client", apiKey: "test-only" }),
      callOzonSellerApi: async (_credential, endpoint, body) => {
        if(endpoint === "/v4/product/info/limit")return availableQuota;
        if(endpoint === "/v3/product/info/list")return readyProducts(body);
        if (endpoint === "/v2/warehouse/list") {
          warehouseReads++; if (unavailable) throw new Error("test-only warehouse provider unavailable");
          return { result: { warehouses: [{ warehouse_id: "1001", warehouse_type: "RFBS", status: "active", is_active: true, is_archived: false }] } };
        }
        if (endpoint === "/v3/product/import") return { result: { task_id: 444 } };
        if (endpoint === "/v1/product/import/info") {
          polls++;
          return imported ? { result: { items: ["a", "b"].map((offer_id, i) => ({ offer_id, product_id: 321 + i, status: "imported", errors: [] })) } }
            : { result: { status: "processing" } };
        }
        assert.equal(endpoint, "/v2/products/stocks"); stocks++;
        return { result: body.stocks.map(stock=>({...stock,updated:true,errors:[]})) };
      },
    });
    const config = { targetStoreId: storeId, targetWarehouseId: warehouseId, stock: 5, priceMultiplier: "1", priceAdjustmentKopecks: 0, brandMode: "PREFER_SOURCE" };
    const accepted = await ports.submitListing({ accountId, config, taskId: "task-poll", idempotencyKey: "poll",
      source: { categoryResolution, sku: "a", sourceSnapshot: { currency: "RUB", price: "100", listingDraft: { variants: [{ sku: "b", currency: "RUB", price: "100" }] } },
        items: ["a", "b"].map(sku => ({ sku, images: [`https://original/${sku}`], listingItem: { offer_id: sku } })) },
      images: ["a", "b"].map(sku => ({ sku, index: 0, generatedUrl: `https://generated/${sku}` })) });
    unavailable = true;
    assert.equal((await ports.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "SUBMITTED");
    assert.equal(polls, 1); assert.equal(warehouseReads, 1); assert.equal(stocks, 0);
    await pool.query("UPDATE stores SET status='disabled' WHERE id=$1", [storeId]);
    await assert.rejects(ports.readSubmission({ accountId, submissionId: accepted.submissionId }), { code: "TARGET_STORE_DISABLED" });
    assert.equal(polls, 1);
    await pool.query("UPDATE stores SET status='active' WHERE id=$1", [storeId]);
    imported = true;
    await assert.rejects(ports.readSubmission({ accountId, submissionId: accepted.submissionId }));
    assert.equal(polls, 2); assert.equal(stocks, 0);
    unavailable = false;
    assert.equal((await ports.readSubmission({ accountId, submissionId: accepted.submissionId })).status, "COMPLETED");
    assert.equal(polls, 2); assert.equal(stocks, 1); assert.equal(warehouseReads, 3);
  } finally { await pool.query("DELETE FROM stores WHERE id=$1", [storeId]); await deleteFixtureAccount(pool,accountId); await pool.end(); }
});
