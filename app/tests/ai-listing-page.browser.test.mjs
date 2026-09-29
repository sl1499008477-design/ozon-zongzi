import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const pixel = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function browserExecutable() {
  return [
    process.env.JZ_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find(existsSync);
}

function fixtureTask(status = "AWAITING_REVIEW") {
  return {
    id: "ai-task-1", sourceType: "COLLECT_BOX", sku: "SKU-A", name: "九图商品", thumbnail: pixel,
    config: {
      targetStoreId: "store-cny", targetWarehouseId: "warehouse-a", stock: 5,
      priceAdjustmentKopecks: 0, priceMultiplier: "1", brandMode: "FORCE_NO_BRAND",
      manualReview: true, image: { ratio: "3:4", language: "ru", resolution: "2K", quality: "high" },
      prompt: "fixture prompt",
    },
    status,
    images: Array.from({ length: 9 }, (_, index) => ({
      sku: index < 7 ? "SKU-A" : "SKU-B", index: index < 7 ? index : index - 7,
      sourceUrl: `${pixel}#source-${index}`, generatedUrl: `${pixel}#generated-${index}`,
      ...(index === 0 ? { previewUrl: `${pixel}#preview-${index}` } : {}), status: "COMPLETED",
    })),
    createdAt: "2026-09-06T01:00:00.000Z", updatedAt: "2026-09-06T01:02:00.000Z",
    errorMessage: null, submissionId: null,
  };
}

function taskSummary(task) {
  return {id:task.id,sku:task.sku,name:task.name,status:task.status,createdAt:task.createdAt,updatedAt:task.updatedAt,
    config:{targetStoreId:task.config.targetStoreId},progress:{total:9,completed:9},
    skuProgress:[{sku:'SKU-A',total:7,completed:7},{sku:'SKU-B',total:2,completed:2}]};
}

function localStateFixture() {
  return {
    account: { id: "account-a", username: "ai", displayName: "AI", role: "admin", status: "active" },
    token: "ai-listing-token", currentStoreId: "store-cny", binding: null,
    stores: [{ id: "store-cny", label: "人民币店铺", currencyCode: "CNY", credentialsSaved: true }],
    summary: {}, caches: {
      collectBox: [{ id: "collect-a", name: "已采集九图商品", sku: "SKU-A" }],
      warehouses: [{ id: "warehouse-a", warehouse_id: "1001", storeId: "store-cny", name: "人民币仓库",
        listingEligibility: { eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false } }],
    }, jobs: {},
  };
}

async function delayedFixture(t, handleAiRequest, role = "admin") {
  const vite = await createServer({ root: appRoot, logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  t.after(async () => { await context.close(); await browser.close(); await vite.close(); });
  await page.addInitScript(() => localStorage.setItem("token", "ai-listing-token"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/local/state") {
      await route.fulfill({ status: 200, json: { ...localStateFixture(), account: { ...localStateFixture().account, role } } });
      return;
    }
    if(path==='/api/ai-listing/capabilities'){await route.fulfill({json:{grid:{available:true}}});return;}
    if(path.startsWith('/api/ai-listing/presets/')) {await route.fulfill({json:path.endsWith('/prompts')?{items:[{id:'p1',name:'已保存提示词',content:'fixture prompt'}]}:path.endsWith('/prompts/p1')?{item:{id:'p1',content:'fixture prompt'}}:{items:[]}});return;}
    if (await handleAiRequest({ route, request, path })) return;
    if(path==='/api/ai-listing/tasks/ai-task-1'){await route.fulfill({json:{task:fixtureTask()}});return;}
    await route.fulfill({ status: 404, json: { message: `fixture missing ${path}` } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/ai-listing/?source=collect&ids=collect-a`);
  await page.getByRole("heading", { name: "AI 上架" }).waitFor();
  await page.getByLabel("提示词版本",{exact:true}).click();
  await page.locator(".ant-select-item-option-content").getByText("已保存提示词",{exact:true}).click();
  return page;
}

async function flushReact(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("AI listing creates from the collect query, serializes exact config, and renders all source pairs", async () => {
  const executablePath = browserExecutable();
  assert.ok(executablePath, "Chrome/Chromium is required for the AI-listing page regression");
  let vite;
  let browser;
  let context;
  let createdBody = null;
  let excelBody = null;
  let approved = false;
  let currentTask = fixtureTask();
  try {
    vite = await createServer({ root: appRoot, logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ executablePath, headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => localStorage.setItem("token", "ai-listing-token"));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/local/state") {
        await route.fulfill({ status: 200, json: {
          account: { id: "account-a", username: "ai", displayName: "AI", role: "admin", status: "active" },
          token: "ai-listing-token", currentStoreId: "store-cny", binding: null,
          stores: [{ id: "store-cny", label: "人民币店铺", currencyCode: "CNY", credentialsSaved: true }],
          summary: {}, caches: {
            collectBox: [{ id: "collect-a", name: "已采集九图商品", sku: "SKU-A" }],
            warehouses: [{ id: "warehouse-a", warehouse_id: "1001", storeId: "store-cny", name: "人民币仓库",
              listingEligibility: { eligible: true, code: "ELIGIBLE_ACTIVE_FBS", fulfillmentType: "FBS", evidenceRequired: false } }],
          }, jobs: {},
        } });
        return;
      }
    if(path==='/api/ai-listing/capabilities'){await route.fulfill({json:{grid:{available:true}}});return;}
    if(path.startsWith('/api/ai-listing/presets/')) {await route.fulfill({json:path.endsWith('/prompts')?{items:[{id:'p1',name:'已保存提示词',content:'fixture prompt'}]}:path.endsWith('/prompts/p1')?{item:{id:'p1',content:'fixture prompt'}}:{items:[]}});return;}
      if (path === "/api/ai-listing/tasks" && request.method() === "GET") {
        await route.fulfill({ status: 200, json: { tasks: [taskSummary(currentTask)],total:1,limit:50,offset:0 } });
        return;
      }
      if(path==='/api/ai-listing/tasks/ai-task-1'){await route.fulfill({json:{task:currentTask}});return;}
      if (path === "/api/ai-listing/tasks/from-collect-box") {
        createdBody = request.postDataJSON();
        await route.fulfill({ status: 201, json: { tasks: [currentTask] } });
        return;
      }
      if (path === "/api/ai-listing/imports/excel") {
        excelBody = request.postDataJSON();
        await route.fulfill({ status: 201, json: { tasks: [currentTask], errors: [
          { rowNumber: 3, rawSku: "bad sku", code: "INVALID_SKU" },
        ] } });
        return;
      }
      if (path === "/api/ai-listing/tasks/ai-task-1/approve") {
        approved = true;
        currentTask = { ...currentTask, status: "READY_TO_SUBMIT" };
        await route.fulfill({ status: 200, json: { task: currentTask } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: `fixture missing ${path}` } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/ai-listing/?tab=tasks`);
    await page.getByRole("tab", { name: /任务中心/ }).waitFor();
    assert.equal(await page.getByRole("tab", { name: /任务中心/ }).getAttribute("aria-selected"), "true");
    assert.equal(createdBody, null, "opening the task center must not create another AI task");

    await page.goto(`http://127.0.0.1:${address.port}/ozon/tools/ai-listing/?source=collect&ids=collect-a`);
    await page.getByRole("heading", { name: "AI 上架" }).waitFor();
  await page.getByLabel("提示词版本",{exact:true}).click();
  await page.locator(".ant-select-item-option-content").getByText("已保存提示词",{exact:true}).click();
    const menuLabels = await page.locator(".ant-menu-item").allTextContents();
    assert.ok(menuLabels.indexOf("提示词管理") === menuLabels.indexOf("AI 上架") + 1);
    await page.getByText("已采集九图商品", { exact: true }).waitFor();
    assert.equal(await page.getByRole("switch", { name: "使用采集品牌" }).getAttribute("aria-checked"), "false");
    assert.equal(await page.getByRole("switch", { name: "生成后人工审核" }).getAttribute("aria-checked"), "false");
    await page.getByText("全部图片生成成功后将自动提交到 Ozon", { exact: false }).waitFor();

    await page.getByLabel("售价加减").fill("-12.34");
    await page.getByLabel("价格倍率").fill("1.230001");
    await page.getByRole("button", { name: "创建 AI 上架任务" }).click();
    await page.getByText("任务已创建", { exact: true }).waitFor();
    assert.deepEqual(createdBody.collectItemIds, ["collect-a"]);
    assert.equal(createdBody.config.priceAdjustmentKopecks, -1234);
    assert.equal(createdBody.config.priceMultiplier, "1.230001");
    assert.equal(createdBody.config.manualReview, false);
    assert.equal(createdBody.config.brandMode, "FORCE_NO_BRAND");
    assert.equal(typeof createdBody.idempotencyKey, "string");

    await page.getByRole("tab", { name: "任务中心" }).click();
    await page.getByText("9 / 9", { exact: true }).waitFor();
    await page.getByRole("button",{name:"查看",exact:true}).click();
    await page.locator(".ai-listing-image-pair").first().waitFor();
    assert.equal(await page.locator(".ai-listing-image-pair").count(), 9);
    assert.deepEqual(await page.locator(".ai-listing-sku").allTextContents(), ["SKU-A", "SKU-B"]);
    assert.match(await page.locator(".ai-listing-image-pair").first().locator("img").nth(1).getAttribute("src"), /#preview-0$/);
    await page.locator(".ai-listing-image-pair").first().click();
    assert.match(await page.locator(".ai-listing-image-comparison section").nth(1).locator("img").getAttribute("src"), /#generated-0$/);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("button", { name: "审核通过并提交" }).click();
    await page.getByText("已通过审核，等待提交", { exact: true }).waitFor();
    assert.equal(approved, true);

    await page.getByRole("button",{name:"Close",exact:true}).last().click();
    await page.getByRole("tab", { name: "创建任务" }).click();
    await page.getByRole("tab", { name: "Excel SKU 上传" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "skus.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    });
    await page.getByRole("button", { name: "创建 AI 上架任务" }).click();
    await page.getByText("第 3 行 · bad sku · INVALID_SKU", { exact: true }).waitFor({ timeout: 3_000 });
    assert.equal(excelBody.name, "skus.xlsx");
    assert.equal(excelBody.contentBase64, "UEsDBA==");
    assert.equal(excelBody.config.priceAdjustmentKopecks, -1234);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await vite?.close();
  }
});

test("a list request started before creation cannot erase the created task", async (t) => {
  const pendingLists = [];
  let creationCompleted = false;
  let preCreateListRequests = 0;
  let postCreateListRequests = 0;
  let listSeenResolve;
  const listSeen = new Promise((resolve) => { listSeenResolve = resolve; });
  const page = await delayedFixture(t, async ({ route, request, path }) => {
    if (path === "/api/ai-listing/tasks" && request.method() === "GET") {
      if (creationCompleted) {
        postCreateListRequests++;
        await route.fulfill({ status: 200, json: { tasks: [taskSummary(fixtureTask())], total: 1, limit: 50, offset: 0 } });
        return true;
      }
      preCreateListRequests++;
      pendingLists.push(route);
      listSeenResolve();
      return true;
    }
    if (path === "/api/ai-listing/tasks/from-collect-box") {
      creationCompleted = true;
      await route.fulfill({ status: 201, json: { tasks: [fixtureTask()] } });
      return true;
    }
    return false;
  });
  await listSeen;
  await page.getByRole("button", { name: "创建 AI 上架任务" }).click();
  await page.getByText("任务已创建", { exact: true }).waitFor();
  await Promise.all(pendingLists.map((route) => route.fulfill({ status: 200, json: { tasks: [] } })));
  await flushReact(page);
  assert.ok(preCreateListRequests > 0, "the regression must hold at least one list response started before creation");
  assert.ok(postCreateListRequests > 0, "the task tab must refresh from a current post-create snapshot");
  assert.equal(await page.locator(".ai-listing-product-cell").count(), 1);
});

test("a list request started during approval cannot restore the stale review status", async (t) => {
  const awaiting = fixtureTask();
  const approved = { ...awaiting, status: "READY_TO_SUBMIT" };
  let holdList = false;
  let heldList;
  let listSeenResolve;
  let approveRoute;
  let approvalComplete=false;
  let approveSeenResolve;
  const listSeen = new Promise((resolve) => { listSeenResolve = resolve; });
  const approveSeen = new Promise((resolve) => { approveSeenResolve = resolve; });
  const page = await delayedFixture(t, async ({ route, request, path }) => {
    if (path === "/api/ai-listing/tasks" && request.method() === "GET") {
      if (holdList) { heldList = route; listSeenResolve(); }
      else await route.fulfill({ status: 200, json: { tasks: [taskSummary(awaiting)],total:1,limit:50,offset:0 } });
      return true;
    }
    if(path==="/api/ai-listing/tasks/ai-task-1"){await route.fulfill({json:{task:approvalComplete?approved:awaiting}});return true;}
    if (path === "/api/ai-listing/tasks/ai-task-1/approve") {
      approveRoute = route;
      approveSeenResolve();
      return true;
    }
    return false;
  });
  await page.getByRole("tab", { name: "任务中心" }).click();
  await page.getByRole("button",{name:"查看",exact:true}).click();
  await page.getByRole("button", { name: "审核通过并提交" }).click();
  await approveSeen;
  const detailDialog=page.getByRole("dialog");
  await detailDialog.getByText("任务详情",{exact:true}).waitFor();
  assert.equal(await detailDialog.getByRole("button",{name:/取消任务/}).isDisabled(),true);
  holdList = true;
  await listSeen;
  approvalComplete=true;
  await approveRoute.fulfill({ status: 200, json: { task: approved } });
  await page.getByText("已通过审核，等待提交", { exact: true }).waitFor();
  await heldList.fulfill({ status: 200, json: { tasks: [taskSummary(awaiting)],total:1,limit:50,offset:0 } });
  await flushReact(page);
  assert.ok(await page.getByText("等待提交", { exact: true }).count()>=1);
  assert.equal(await page.getByRole("button", { name: "审核通过并提交" }).count(), 0);
});

test("quiet polling waits for the foreground request and clears its spinner", async (t) => {
  const active = fixtureTask("READY_TO_SUBMIT");
  let holdForeground = false;
  let foregroundRoute;
  let foregroundSeenResolve;
  let extraRequests=0;
  const foregroundSeen = new Promise((resolve) => { foregroundSeenResolve = resolve; });

  const page = await delayedFixture(t, async ({ route, request, path }) => {
    if (path !== "/api/ai-listing/tasks" || request.method() !== "GET") return false;
    if (!holdForeground) {
      await route.fulfill({ status: 200, json: { tasks: [taskSummary(active)],total:1,limit:50,offset:0 } });
    } else if (!foregroundRoute) {
      foregroundRoute = route;
      foregroundSeenResolve();
    } else {
      await route.fulfill({ status: 200, json: { tasks: [taskSummary(active)],total:1,limit:50,offset:0 } });
      extraRequests++;
    }
    return true;
  });
  await page.getByRole("tab", { name: "任务中心" }).click();
  await page.locator(".ai-listing-product-cell").waitFor();
  holdForeground = true;
  await page.getByRole("button", { name: "刷新任务" }).click();
  await foregroundSeen;
  await page.waitForTimeout(3500);
  assert.equal(extraRequests,0);
  await foregroundRoute.fulfill({ status: 200, json: { tasks: [taskSummary(active)],total:1,limit:50,offset:0 } });
  await flushReact(page);
  assert.equal(await page.locator(".ai-listing-loading").count(), 0);
  assert.equal(await page.locator(".ai-listing-product-cell").count(), 1);
  assert.equal(await page.getByRole("button", { name: "刷新任务" }).getAttribute("class").then((value) => value.includes("ant-btn-loading")), false);
});


for (const role of ["admin", "user"]) test(`AI task channel visibility and billing navigation for ${role}`, async t => {
  const task = { ...fixtureTask(), generationChannel: "Private provider", generationDurationMs: 90000,
    channelHistory: [{ name: "Private provider", status: "SUCCEEDED" }] };
  let billingReads = 0;
  const page = await delayedFixture(t, async ({route,path}) => {
    if(path === "/api/ai-listing/tasks") { await route.fulfill({json:{tasks:[{...taskSummary(task),generationChannel:task.generationChannel,generationDurationMs:90000}],total:1}}); return true; }
    if(path === "/api/ai-listing/tasks/ai-task-1") { await route.fulfill({json:{task}}); return true; }
    if(path === "/api/ai-listing/billing") { billingReads++; await route.fulfill({json:{wallets:[],entries:[],products:[],costs:[]}}); return true; }
  }, role);
  await page.getByRole("tab", {name:/任务中心/}).click();
  assert.equal(await page.getByRole("tab",{name:"费用账单",exact:true}).count(),0);
  assert.equal(await page.getByRole("columnheader",{name:"生图通道",exact:true}).count(),role === "admin" ? 1 : 0);
  assert.equal(await page.getByText("Private provider",{exact:true}).count(),role === "admin" ? 1 : 0);
  await page.getByRole("button",{name:"查看",exact:true}).click();
  await page.getByRole("dialog").getByText("原图 1",{exact:true}).first().waitFor();
  assert.equal(await page.getByRole("dialog").getByText("通道请求记录（耗时包含失败尝试，不含排队）",{exact:true}).count(),role === "admin" ? 1 : 0);
  await page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}).click();
  if(role === "admin") {
    await page.getByRole("button",{name:/管理员配置/}).click();
    await page.getByRole("menuitem",{name:"费用账单",exact:true}).click();
    await page.getByRole("heading",{name:"费用账单",exact:true}).waitFor();
    await page.waitForFunction(() => document.body.textContent.includes("余额"));
    assert.ok(billingReads > 0);
  } else {
    assert.equal(await page.getByRole("button",{name:/管理员配置/}).count(),0);
    await page.goto(new URL("/ozon/settings/ai-billing/",page.url()).href);
    await page.getByText("仅管理员可查看费用账单",{exact:true}).waitFor();
    assert.equal(billingReads,0);
  }
});

test("AI task list confirms cancellation, preserves images and excludes submitted tasks", async t => {
  let task = fixtureTask("GENERATING"), cancelCalls=0;
  const page = await delayedFixture(t, async ({route,path,request}) => {
    if(path === "/api/ai-listing/tasks") { await route.fulfill({json:{tasks:[taskSummary(task),{...taskSummary(fixtureTask("SUBMITTING")),id:"submitted",sku:"SUBMITTED"}],total:2}}); return true; }
    if(path === "/api/ai-listing/tasks/ai-task-1") { await route.fulfill({json:{task}}); return true; }
    if(path === "/api/ai-listing/tasks/ai-task-1/cancel") {
      assert.equal(request.method(),"POST"); cancelCalls++; task={...task,status:"CANCELLED"};
      await route.fulfill({json:{task}}); return true;
    }
  },"user");
  await page.getByRole("tab",{name:/任务中心/}).click();
  const row = page.locator("tr[data-row-key='ai-task-1']");
  assert.equal(await page.locator("tr[data-row-key='submitted']").getByRole("button",{name:"操作任务 SUBMITTED",exact:true}).isDisabled(),true);
  await row.getByRole("button",{name:"操作任务 SKU-A",exact:true}).click();
  await page.getByRole("menuitem",{name:"取消任务",exact:true}).click();
  let actionDialog=page.getByRole("dialog");
  await actionDialog.getByText("取消任务",{exact:true}).waitFor();
  assert.equal(cancelCalls,0);
  await actionDialog.getByRole("button",{name:"返回",exact:true}).click();
  assert.equal(cancelCalls,0);
  await row.getByRole("button",{name:"操作任务 SKU-A",exact:true}).click();
  await page.getByRole("menuitem",{name:"取消任务",exact:true}).click();
  actionDialog=page.getByRole("dialog");
  await actionDialog.getByText("取消任务",{exact:true}).waitFor();
  await actionDialog.getByRole("button",{name:"确认取消",exact:true}).click();
  await row.getByText("已取消",{exact:true}).waitFor();
  assert.equal(cancelCalls,1);
  assert.equal(await row.getByRole("button",{name:"操作任务 SKU-A",exact:true}).isDisabled(),true);
  await row.getByRole("button",{name:"查看",exact:true}).click();
  const detailDialog=page.getByRole("dialog");
  await detailDialog.getByText("任务详情",{exact:true}).waitFor();
  await detailDialog.locator(".ai-listing-image-pair").first().waitFor();
  assert.equal(await detailDialog.locator(".ai-listing-image-pair").count(),9);
  assert.equal(task.images.filter(image=>image.generatedUrl).length,9);
});

test('AI tables show thumbnail and split creation/completion dates without detail requests', async t => {
  const task={...fixtureTask('READY_TO_SUBMIT'),thumbnail:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2256%22 height=%2256%22%3E%3Crect width=%2256%22 height=%2256%22 fill=%22blue%22/%3E%3C/svg%3E'};
  let detailReads=0;
  const page=await delayedFixture(t,async({route,path,request})=>{
    if(path==='/api/ai-listing/tasks'){
      const completed=new URL(request.url()).searchParams.get('view')==='completed';
      await route.fulfill({json:{tasks:[{...taskSummary(task),thumbnail:task.thumbnail,status:completed?'COMPLETED':task.status}],total:1}});return true;
    }
    if(path==='/api/ai-listing/tasks/ai-task-1'){detailReads++;await route.fulfill({json:{task}});return true;}
  });
  await page.getByRole('tab',{name:/任务中心/}).click();
  const row=page.locator('tr[data-row-key="ai-task-1"]');
  await row.locator('time').waitFor();
  assert.equal(await row.locator('time').getAttribute('datetime'),task.createdAt);
  assert.equal(await row.locator('img.ai-listing-product-thumbnail').getAttribute('src'),task.thumbnail);
  const lines=await row.locator('time span').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));
  assert.ok(lines[1]>lines[0]);
  await row.locator('summary').click();
  assert.ok((await row.innerText()).includes('SKU-B'));
  await page.goto(new URL('/ozon/products/import-history/',page.url()).href);
  await page.getByRole('columnheader',{name:'完成时间',exact:true}).waitFor();
  assert.equal(await row.locator('time').getAttribute('datetime'),task.updatedAt);
  assert.equal(await row.locator('img.ai-listing-product-thumbnail').count(),1);
  assert.equal(detailReads,0);
  await row.getByRole('button',{name:'查看',exact:true}).click();
  await page.getByRole('dialog',{name:'任务详情'}).locator('.ai-listing-image-pair').first().waitFor();
  assert.equal(detailReads,1);
});

test('completed listing details show card warnings beside successful import and stock results', async t => {
  const task = { ...fixtureTask('COMPLETED'), submissionResults: [
    { sku: 'SKU-A', offerId: 'BSC005E', importStatus: 'SUCCEEDED', stockStatus: 'COMPLETED', errors: [],
      publicationWarnings: ['warning_attribute_values_out_of_range'],
      publicationWarningDetails: [{ code: 'warning_attribute_values_out_of_range', attribute_id: 10175, description: 'Значение вне диапазона' }] },
    { sku: 'SKU-B', offerId: 'BSC003', importStatus: 'SUCCEEDED', stockStatus: 'COMPLETED', errors: [] },
  ] };
  const page = await delayedFixture(t, async ({ route, path }) => {
    if (path === '/api/ai-listing/tasks') { await route.fulfill({ json: { tasks: [taskSummary(task)], total: 1 } }); return true; }
    if (path === '/api/ai-listing/tasks/ai-task-1') { await route.fulfill({ json: { task } }); return true; }
  });
  await page.goto(new URL('/ozon/products/import-history/', page.url()).href);
  await page.locator('tr[data-row-key="ai-task-1"]').getByRole('button', { name: '查看', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '任务详情' });
  await dialog.locator('tr[data-row-key="SKU-A:BSC005E"]').waitFor();
  const warningRow = await dialog.locator('tr[data-row-key="SKU-A:BSC005E"]').innerText();
  assert.match(warningRow, /成功\s+成功/);
  assert.match(warningRow, /属性值超出.*10175.*Значение вне диапазона/);
  assert.match(await dialog.locator('.ant-alert-warning').innerText(), /上架完成，商品卡片有警告/);
  assert.match(await dialog.locator('.ant-alert-warning').innerText(), /SKU-A.*属性值超出.*10175/);
  assert.match(await dialog.locator('tr[data-row-key="SKU-B:BSC003"]').innerText(), /成功\s+成功\s+—/);
});
