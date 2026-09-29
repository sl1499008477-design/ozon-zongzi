import test from "node:test";
import assert from "node:assert/strict";
import { createAiListingImagePort, buildAiListingSource, loadAiListingCollectSources, validateAiListingOptions, createAiListingRuntime, prepareAiListingImageForPublication } from "../ai-listing-runtime.mjs";
import * as imageGenerator from "../auto-listing-image-generator.mjs";

test("gateway receives one original and image instructions, never listing metadata or inspection", async () => {
  const sharp = (await import("sharp")).default;
  const generated = await sharp({ create: { width: 12, height: 16, channels: 3, background: "#778899" } }).png().toBuffer();
  let request; const stored=[];
  const generate = createAiListingImagePort({
    loadProfile: async () => ({ id: "profile", configVersion: 3, textModel: "orchestrator", accountId: "account", enabled: true, imageModel: "gpt-image-2", secret: "DO_NOT_COPY" }),
    gateway: { generateImage: async (input) => { request = input; return { bytes: generated, contentType: "image/png" }; },
      inspectImage: () => { throw new Error("must not inspect"); } },
    downloadImage: async () => ({ buffer: Buffer.from("original"), contentType: "image/jpeg" }),
    putObject: async (input) => { stored.push(input); },
    publication: { baseUrl: "https://media.example/", prefix: "listing-media/v1" },
  });
  const result = await generate({ accountId: "account", taskId: "task", sku: "SKU_PRIVATE_MARKER", index: 0,
    sourceUrl: "https://source.example/image.jpg", prompt: "preserve logo", image: { ratio: "3:4", resolution: "2K", quality: "high", language: "ru" },
    requestKey: "request", title: "TITLE_PRIVATE_MARKER", attributes: "ATTRIBUTE_PRIVATE_MARKER" });
  assert.deepEqual(result.generationConfig, { profileId: "profile", configVersion: 3, textModel: "orchestrator", imageModel: "gpt-image-2" });
  assert.equal(request.sourceImages.length, 1);
  assert.equal(Buffer.from(request.sourceImages[0].bytes).toString(), "original");
  assert.equal(request.size, "1536x2048");
  assert.match(request.prompt, /preserve logo/);
  assert.match(request.prompt, /ru/);
  for (const marker of ["SKU_PRIVATE_MARKER", "TITLE_PRIVATE_MARKER", "ATTRIBUTE_PRIVATE_MARKER", "DO_NOT_COPY"]) assert.ok(!JSON.stringify(request).includes(marker));
  assert.equal(stored[0].buffer, generated);
  assert.match(result.generatedUrl, /^https:\/\/media.example\/listing-media\/v1\/ai-image-listing\/[a-f0-9]{64}\.png$/);
});

test("public provider size mapping uses native model bounds and legacy supported sizes", () => {
  assert.equal(typeof imageGenerator.gatewayImageSize, "function");
  for (const [model, ratio, target, expected] of [
    ["gpt-image-2", "3:2", "2048x1365", "2064x1376"],
    ["gpt-image-2", "16:9", "4096x2304", "3840x2160"],
    ["gpt-image-2", "3:4", "3072x4096", "2448x3264"],
    ["gpt-image-1", "3:4", "3072x4096", "1024x1536"],
  ]) assert.equal(imageGenerator.gatewayImageSize(model, ratio, target), expected);
});

test("image port passes native requested dimensions and preserves returned formal dimensions", async () => {
  const sharp = (await import("sharp")).default;
  const generated = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#112233" } }).png().toBuffer();
  let request; let formal;
  const generate = createAiListingImagePort({ loadProfile: async () => ({ imageModel: "gpt-image-2" }),
    gateway: { generateImage: async input => { request = input; return { bytes: generated, contentType: "image/png" }; } },
    downloadImage: async () => ({ buffer: Buffer.from("original"), contentType: "image/png" }),
    putObject: async input => { if (input.contentType !== "image/webp") formal = input; },
    publication: { baseUrl: "https://media.example/", prefix: "listing-media/v1" },
  });
  await generate({ prompt: "keep logo", image: { ratio: "3:2", resolution: "2K", quality: "high", language: "ru" } });
  assert.equal(request.size, "2064x1376");
  const metadata = await sharp(formal.buffer).metadata(); assert.equal(metadata.width, 30); assert.equal(metadata.height, 20);
});

test("selected SKU keeps its full original gallery and siblings never borrow it", () => {
  const original = { id: "collect", sku: "a", images: ["https://x/a1", "https://x/a2"],
    listingDraft: { variants: [{ sku: "a", image: "https://x/a1" }, { sku: "b", image: "https://x/b1" }] } };
  const before = structuredClone(original);
  const result = buildAiListingSource(original, "store", () => [
    { scraped_sku: "a", images: ["https://x/a1"] }, { scraped_sku: "b", images: ["https://x/a1"] },
  ]);
  assert.deepEqual(result.items.map(i => i.images), [["https://x/a1", "https://x/a2"], ["https://x/b1"]]);
  assert.deepEqual(original, before);
});

test("unsupported image options and imprecise multiplier fail before paid work", () => {
  for (const config of [{ priceMultiplier: "1.0000001" }, { image: { ratio: "invalid" } }]) {
    assert.throws(() => validateAiListingOptions({ targetStoreId: "s", targetWarehouseId: "w", ...config }), { statusCode: 400 });
  }
});

test("variant source gallery attributes are retained instead of its single thumbnail", () => {
  const result = buildAiListingSource({ id: "c", sku: "a", images: ["https://x/a", "https://x/a"],
    listingDraft: { variants: [{ sku: "a" }, { sku: "b", image: "https://x/b0" }] } }, "s", () => [
    { scraped_sku: "a" }, { scraped_sku: "b", _sourceVariant: { attributes: [
      { id: 4195, values: [{ value: "https://x/b0" }, { value: "https://x/b1" }] },
    ] } },
  ]);
  assert.deepEqual(result.items.map(item => item.images), [["https://x/a", "https://x/a"], ["https://x/b0", "https://x/b1"]]);
});

test("independent generated preview serves stored bytes with old upload toggle off and rejects guessed non-image paths", async () => {
  let reads = 0; let bytes; let responseStatus;
  const runtime = createAiListingRuntime({ env: { AUTO_LISTING_UPLOAD_ENABLED: "false", LISTING_ASSET_PUBLIC_BASE_URL: "https://media.example/" },
    getObject: async key => { reads++; assert.equal(key, `listing-media/v1/ai-image-listing/${"a".repeat(64)}.png`); return Buffer.from("stored"); },
    authenticate: () => { throw new Error("public images do not require an Ozon bearer token"); },
    sendJson: (_res, status) => { responseStatus = status; },
  });
  const res = { writeHead: status => { responseStatus = status; }, end: body => { bytes = body; } };
  assert.equal(await runtime.handleRoute({ method: "GET" }, res, new URL(`https://media.example/listing-media/v1/ai-image-listing/${"a".repeat(64)}.png`)), true);
  assert.equal(responseStatus, 200); assert.equal(bytes.toString(), "stored");
  await runtime.handleRoute({ method: "GET" }, res, new URL("https://media.example/listing-media/v1/ai-image-listing/secrets.json"));
  assert.equal(responseStatus, 404); assert.equal(reads, 1);
});

test("large generated PNGs publish as smaller JPEGs with unchanged dimensions", async () => {
  const sharp = (await import("sharp")).default;
  const original = await sharp({ create: { width: 1536, height: 2048, channels: 3, background: "#e0b080" } }).png({ compressionLevel: 0 }).toBuffer();
  const stored=[];
  const generate = createAiListingImagePort({
    loadProfile: async () => ({ imageModel: "gpt-image-2" }),
    gateway: { generateImage: async () => ({ bytes: original, contentType: "image/png" }) },
    downloadImage: async () => ({ buffer: Buffer.from("original"), contentType: "image/png" }),
    putObject: async data => { stored.push(data); },
    publication: { baseUrl: "https://media.example/", prefix: "listing-media/v1" },
  });
  const result = await generate({ prompt: "keep product", image: { ratio: "3:4", resolution: "2K", quality: "high", language: "ru" } });
  assert.equal(stored[0].contentType, "image/jpeg");
  assert.ok(stored[0].buffer.length < original.length / 2);
  const meta = await sharp(stored[0].buffer).metadata();
  assert.equal(meta.width, 1536); assert.equal(meta.height, 2048);
  assert.match(result.generatedUrl, /\.jpg$/);
});

test("publication uses decoded bytes over missing or misleading MIME and preserves supported formal formats", async () => {
  const sharp = (await import("sharp")).default;
  const webp = await sharp({ create: { width: 41, height: 29, channels: 4, background: { r: 90, g: 120, b: 150, alpha: 0.5 } } }).webp().toBuffer();
  const output = await prepareAiListingImageForPublication({ bytes: webp, contentType: "image/png" });
  assert.equal(output.contentType, "image/jpeg");
  const outputMetadata = await sharp(output.bytes).metadata();
  assert.equal(outputMetadata.width, 41); assert.equal(outputMetadata.height, 29); assert.equal(outputMetadata.format, "jpeg");

  const jpeg = await sharp({ create: { width: 23, height: 17, channels: 3, background: "#334455" } }).jpeg().toBuffer();
  const unchanged = await prepareAiListingImageForPublication({ bytes: jpeg, contentType: "application/octet-stream" });
  assert.equal(unchanged.bytes, jpeg); assert.equal(unchanged.contentType, "image/jpeg");
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#123456" } }).png().toBuffer();
  const normalizedPng = await prepareAiListingImageForPublication({ bytes: png });
  assert.equal(normalizedPng.bytes, png); assert.equal(normalizedPng.contentType, "image/png");
  await assert.rejects(prepareAiListingImageForPublication({ bytes: Buffer.from("not-an-image"), contentType: "image/png" }), /无法识别|无效/);
});

test("publication fully decodes small retained PNG and JPEG bytes before upload", async () => {
  const sharp = (await import("sharp")).default;
  for (const format of ["png", "jpeg"]) {
    const complete = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#123456" } })[format]().toBuffer();
    let truncated;
    for (let end = complete.length - 1; end > 24; end--) {
      const candidate = complete.subarray(0, end);
      try { await sharp(candidate).metadata(); }
      catch { continue; }
      try { await sharp(candidate, { limitInputPixels: 1_000_000 }).toBuffer(); }
      catch { truncated = candidate; break; }
    }
    assert.ok(truncated, `${format} fixture must retain a decodable header but have a corrupt body`);
    await assert.rejects(prepareAiListingImageForPublication({ bytes: truncated, contentType: `image/${format}` }), /无法识别|损坏|无效/);
  }
});

test("image publication uploads an independent 320px preview and survives preview upload failure", async () => {
  const sharp = (await import("sharp")).default;
  const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#886644" } }).jpeg().toBuffer();
  const uploads = [];
  const generate = createAiListingImagePort({
    loadProfile: async () => ({ imageModel: "gpt-image-2" }),
    gateway: { generateImage: async () => ({ bytes: original, contentType: "image/jpeg" }) },
    downloadImage: async () => ({ buffer: original, contentType: "image/jpeg" }),
    putObject: async input => { uploads.push(input); },
    publication: { baseUrl: "https://media.example/", prefix: "listing-media/v1" },
  });
  const result = await generate({ accountId: "account", taskId: "task", sku: "sku", index: 0,
    prompt: "keep product", image: { ratio: "4:3", resolution: "1K", quality: "high", language: "ru" } });
  assert.equal(uploads.length, 2);
  assert.match(uploads[0].key, /\.(?:jpg|png)$/);
  assert.match(uploads[1].key, /\/ai-image-listing\/[a-f0-9]{64}\.webp$/);
  assert.notEqual(uploads[0].key, uploads[1].key);
  assert.equal(uploads[1].contentType, "image/webp");
  const previewMeta = await sharp(uploads[1].buffer).metadata();
  assert.equal(previewMeta.width, 320); assert.equal(previewMeta.height, 240);
  assert.equal(result.previewUrl, new URL(uploads[1].key, "https://media.example/").href);

  uploads.length = 0;
  const small = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#886644" } }).jpeg().toBuffer();
  const fallback = createAiListingImagePort({
    loadProfile: async () => ({ imageModel: "gpt-image-2" }), gateway: { generateImage: async () => ({ bytes: small, contentType: "image/jpeg" }) },
    downloadImage: async () => ({ buffer: original, contentType: "image/jpeg" }), publication: { baseUrl: "https://media.example/", prefix: "listing-media/v1" },
    putObject: async input => { uploads.push(input); if (input.contentType === "image/webp") {
      const metadata = await sharp(input.buffer).metadata(); assert.equal(metadata.width, 40); assert.equal(metadata.height, 30);
      throw new Error("preview storage unavailable");
    } },
  });
  const preserved = await fallback({ accountId: "account", taskId: "task", sku: "sku", index: 1,
    prompt: "keep product", image: { ratio: "4:3", resolution: "1K", quality: "high", language: "ru" } });
  assert.match(preserved.generatedUrl, /\.jpg$/); assert.equal(preserved.previewUrl, undefined); assert.equal(uploads.length, 2);
});

test("invalid formal bytes fail before either formal or optional preview upload", async () => {
  const sharp = (await import("sharp")).default;
  const complete = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#123456" } }).png().toBuffer();
  const truncated = complete.subarray(0, complete.length - 17); let uploads = 0;
  const generate = createAiListingImagePort({ loadProfile: async () => ({ imageModel: "gpt-image-2" }),
    gateway: { generateImage: async () => ({ bytes: truncated, contentType: "image/png" }) },
    downloadImage: async () => ({ buffer: complete, contentType: "image/png" }), putObject: async () => { uploads++; },
    publication: { baseUrl: "https://media.example/", prefix: "listing-media/v1" } });
  await assert.rejects(generate({ accountId: "account", taskId: "task", sku: "sku", index: 0,
    prompt: "keep product", image: { ratio: "4:3", resolution: "1K", quality: "high", language: "ru" } }),
  error => error.code === "AI_LISTING_STORAGE_FAILED" && /完整解码|损坏/.test(error.cause?.message || ""));
  assert.equal(uploads, 0);
});

test("retry API rejects unassigned user channels without mutating the failed task or contacting a gateway", async () => {
  const task = { id: "task", accountId: "account-a", status: "GENERATION_FAILED", config: {},
    createdAt: 1, updatedAt: 1, images: [{ sku: "5489575013", index: 0, generatedUrl: "https://media.example/success.jpg" },
      { sku: "5489575013", index: 6, status: "GENERATION_FAILED" }] };
  const before = structuredClone(task);
  const runtime = createAiListingRuntime({
    authenticate: async () => ({ id: "account-a", role: "admin", status: "active" }),
    readJson: async () => ({}), sendJson: (res, status, body) => Object.assign(res, { status, body }),
    resolvePool: async () => ({ connect: async () => { throw new Error("no transaction expected"); },
      query: async (_sql, values) => {
        if (_sql.includes("ai_user_channels")) return { rows: [] };
        assert.deepEqual(values, ["account-a"]);
        return { rows: [{ id: "profile", text_model: "gpt-5.4", image_model: "gpt-image-2",
          runtime_catalog: { models: [{ id: "gpt-5.6-luna" }, { id: "gpt-image-2" }] } }] };
      } }),
    repository: { get: async ({ accountId, taskId }) => {
      assert.equal(accountId, "account-a"); assert.equal(taskId, "task"); return structuredClone(task);
    }, save: async () => { throw new Error("must not mutate task"); } },
  });
  const res = {};
  await runtime.handleRoute({ method: "POST" }, res, new URL("http://localhost/api/ai-listing/tasks/task/retry"));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "AI_LISTING_CHANNEL_UNAVAILABLE");
  assert.match(res.body.message, /分配并启用/);
  assert.deepEqual(task, before);
});


test("production source download uses the real downloader contract without policy metadata", async () => {
  const { downloadAiListingSourceImage } = await import("../ai-listing-runtime.mjs");
  const { createAutoListingSourceImageDownloader } = await import("../auto-listing-source-downloader.mjs");
  const { default: sharp } = await import("sharp");
  const buffer = await sharp({create:{width:32,height:32,channels:3,background:"white"}}).png().toBuffer();
  let calls = 0;
  const downloader = createAutoListingSourceImageDownloader({downloadImage:async (url) => {
    calls++; assert.equal(url,"https://ir.ozone.ru/example.png");
    return {buffer,contentType:"image/png"};
  }});
  const result = await downloadAiListingSourceImage("https://ir.ozone.ru/example.png",downloader);
  assert.equal(calls,1); assert.deepEqual(result,{buffer,contentType:"image/png"});
});

test("three independent worker lanes refill without waiting for a slow lane and stop drains work", async () => {
  let calls = 0; let active = 0; let peak = 0; const releases = [];
  const runtime = createAiListingRuntime({
    resolvePool: async () => ({}),
    repository: { claimNext: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => releases.push(resolve)); active--; return null;
    } },
  });
  const started = runtime.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 3);
    releases.shift()();
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(calls, 4, "free lane claims another task while two lanes remain busy");
    assert.equal(peak, 3);
  } finally {
    let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stopped, false);
    for (const release of releases) release();
    await stopping; await started;
  }
});

test('purge queue continues immediately, backs off when idle or failing, and stop drains one active sweep',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  let calls=0,release;
  const runtime=createAiListingRuntime({resolvePool:async()=>({}),repository:{claimNext:async()=>null},
    purge:{sweep:async()=>{
      calls++;
      if(calls<=2)return {taskId:'task',state:calls===1?'RUNNING':'COMPLETED'};
      if(calls===3)return null;
      if(calls===4)throw new Error('temporary COS failure');
      return new Promise(resolve=>{release=()=>resolve({taskId:'last',state:'COMPLETED'});});
    }}});
  try{
    await runtime.start();await flush();assert.equal(calls,1);
    t.mock.timers.tick(1);await flush();assert.equal(calls,2,'remaining work must not wait five seconds');
    t.mock.timers.tick(1);await flush();assert.equal(calls,3);
    t.mock.timers.tick(4999);await flush();assert.equal(calls,3,'idle queue does not spin');
    t.mock.timers.tick(1);await flush();assert.equal(calls,4);
    t.mock.timers.tick(4999);await flush();assert.equal(calls,4,'failed sweep backs off');
    t.mock.timers.tick(1);await flush();assert.equal(calls,5);
    t.mock.timers.tick(10000);await flush();assert.equal(calls,5,'sweeps never overlap');
    let stopped=false;const stopping=runtime.stop().then(()=>{stopped=true;});
    await flush();assert.equal(stopped,false,'shutdown waits for the in-flight sweep');
    release();await stopping;t.mock.timers.tick(10000);await flush();assert.equal(calls,5);
  }finally{release?.();await runtime.stop();}
});

test("a Seller completion racing the collect preview cannot mark an older incomplete draft ready", async () => {
  let status = "PENDING";
  const sources = await loadAiListingCollectSources({ accountId: "a", collectItemIds: ["c"], config: { targetStoreId: "s" },
    pool: { query: async sql => ({ rows: sql.includes("collector_ozon_enrichment_jobs")
      ? [{ collect_item_id: "c", sku: "123", status }] : [] }) },
    readCollectItems: async () => {
      const olderSnapshot = { id: "c", sku: "123", images: ["https://source.test/a"], listingDraft: { logistics: {} } };
      status = "SUCCESS"; // Seller completes after this old preview snapshot was read.
      return [olderSnapshot];
    },
    buildListingItems: () => [{ scraped_sku: "123" }],
  });
  assert.equal(status, "SUCCESS");
  assert.deepEqual(sources[0].enrichmentJobs, [{ sku: "123", status: "PENDING" }]);
  assert.equal(sources[0].items[0].listingItem.weight, undefined);
});

test("new collect creation reports missing packaging through its original boundary despite historical Seller FAILED", async () => {
  const runtime = createAiListingRuntime({
    authenticate: async () => ({ id: "a", role: "admin", status: "active" }),
    resolvePool: async () => ({ query: async () => ({ rows: [] }) }),
    repository: { getMany: async () => [], create: async () => { throw new Error("must not create"); } },
    generateImage: async () => { throw new Error("must not generate"); }, validateTarget: async () => ({}),
    loadSources: async () => [{ collectItemId: "c", items: [{ sku: "123", images: ["https://source.test/manual.jpg"],
      listingItem: { depth: 120, width: 130, height: 140 } }], enrichmentJobs: [{ sku: "123", status: "FAILED" }] }],
    readJson: async () => ({ collectItemIds: ["c"], idempotencyKey: "one", config: { targetStoreId: "s", targetWarehouseId: "w" } }),
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
  });
  const res = {};
  await runtime.handleRoute({ method: "POST" }, res, new URL("http://localhost/api/ai-listing/tasks/from-collect-box"));
  assert.equal(res.status, 201);assert.deepEqual(res.body.tasks,[]);assert.equal(res.body.errors[0].code,"AI_LISTING_LOGISTICS_REQUIRED");
  assert.equal(res.body.errors[0].collectItemId,'c');assert.equal(res.body.errors[0].definitelyNotCreated,true);assert.match(res.body.errors[0].message,/weight/);
});


test("channel pricing input errors reach the editor without exposing gateway errors", async () => {
  const runtime=createAiListingRuntime({
    authenticate:async()=>({id:"admin",role:"admin",status:"active"}),
    readJson:async()=>({imageModel:"image",billingAccount:"bill",pricing:{mode:"REQUEST",currency:"USD",requestPrice:"-1"}}),
    sendJson:(res,status,body)=>Object.assign(res,{status,body}),
    resolvePool:async()=>({query:async sql=>({rows:sql.startsWith("SELECT * FROM ai_user_channels")?[{id:"channel",account_id:"a",image_protocol:"SUB2API_OPENAI_IMAGES",image_model:"image",billing_account:"bill"}]:[]})}),
  });
  const res={};await runtime.handleRoute({method:"POST"},res,new URL("http://localhost/api/admin/ai-user-channels/channel/models"));
  assert.equal(res.status,400);assert.match(res.body.message,/非负单价/);
});

test("channel operations explain known gateway failures without exposing provider messages", async () => {
  for(const [code,message] of [
    ['INVALID_GATEWAY_RESPONSE','网关返回的模型目录无法解析，请检查网关兼容性'],
    ['NON_RETRYABLE_AUTH','网关鉴权失败，请检查 API Key 是否有效及其访问权限'],
    ['GATEWAY_TIMEOUT','查询网关超时，请稍后重试'],
    ['AI_GATEWAY_NETWORK_FAILED','无法连接 AI 网关，请检查 API 地址和网络'],
    ['UNRECOGNIZED_PROVIDER_FAILURE','通道操作未完成，请检查连接和模型配置'],
    ['__proto__','通道操作未完成，请检查连接和模型配置'],
  ]) {
    const runtime=createAiListingRuntime({
      authenticate:async()=>({id:'admin',role:'admin',status:'active'}),
      resolvePool:async()=>{throw Object.assign(new Error('private-key-and-provider-body'),{code});},
      sendJson:(res,status,body)=>Object.assign(res,{status,body}),
    });
    const res={};await runtime.handleRoute({method:'GET'},res,new URL('http://localhost/api/admin/ai-user-channels'));
    assert.equal(res.status,400);assert.equal(res.body.message,message);
    assert.doesNotMatch(JSON.stringify(res.body),/private-key-and-provider-body/);
  }
});


function taskAccessFixture(role = 'user', telemetryRows) {
  const account = { id: 'account-a', role, status: 'active' };
  const source = { collectItemId: 'collect-a', items: [{ sku: 'sku-a', images: ['https://source.test/a.jpg'],
    listingItem: { weight: 200, depth: 100, width: 100, height: 100 } }] };
  let task = { id: 'task-a', accountId: account.id, version: 1, status: 'AWAITING_REVIEW', source,
    config: { targetStoreId: 'store-a', targetWarehouseId: 'warehouse-a', manualReview: true, image: {} },
    createdAt: 1, updatedAt: 1, images: [{ sku: 'sku-a', index: 0, sourceUrl: source.items[0].images[0],
      generatedUrl: 'https://media.test/a.jpg', status: 'COMPLETED',
      generationConfig: { channelId: 'private-channel-id', profileId: 'private-profile-id' },
      channelAttempts: [{ channelId: 'private-attempt-channel' }], excludeChannelIds: ['private-excluded-channel'],
      activeAttemptId: 'private-attempt-id', lastError: { requestId: 'private-provider-request' } }] };
  const generated = [];
  let claimed = false;let sourceReads=0;
  const repository = {
    readCollectionSources: async ({accountId, taskIds}) => {
      sourceReads++;assert.equal(accountId, account.id);
      assert.deepEqual(taskIds, [task.id]);
      return new Map([[task.id,{type:'COLLECTOR_ASSISTANT',taskNames:['汽车用品选品']}]]);
    },
    get: async ({ accountId, taskId }) => accountId === task.accountId && taskId === task.id ? structuredClone(task) : null,
    list: async ({ accountId }) => accountId === task.accountId ? [structuredClone(task)] : [],
    listPage: async ({ accountId }) => ({ tasks: accountId === task.accountId ? [{ id: task.id, status: task.status,
      progress: { total: 1, completed: 1 } }] : [], total: accountId === task.accountId ? 1 : 0 }),
    listActionCandidates: async ({accountId}) => accountId===task.accountId && !task.deletedAt ? [structuredClone(task)] : [],
    requestControl: async ({task:next,expectedVersion}) => {
      assert.equal(next.accountId,account.id);assert.equal(expectedVersion,task.version);
      task={...structuredClone(next),version:task.version+1};return structuredClone(task);
    },
    save: async ({ task: next, expectedVersion }) => {
      assert.equal(next.accountId, account.id); assert.equal(expectedVersion, task.version);
      task = { ...structuredClone(next), version: task.version + 1 }; return structuredClone(task);
    },
    claimNext: async ({ leaseToken }) => {
      if (claimed) return null;
      claimed = true; task.leaseToken = leaseToken; task.version++; return structuredClone(task);
    },
  };
  const pool = { query: async (sql, values) => {
    if (sql.includes('SELECT r.task_id,c.name')) {
      assert.deepEqual(values, [account.id, [task.id]]);
      return { rows: telemetryRows || [{ task_id: task.id, name: 'private-channel-name', status: 'SUCCEEDED',
        error_code: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:02Z' }] };
    }
    if (sql.includes('FROM ai_user_channels c LEFT JOIN LATERAL')) {
      assert.deepEqual(values, [account.id]);
      return { rows: [{ id: 'private-channel-id', name: 'private-channel-name', enabled: true }] };
    }
    if (sql.includes('FROM accounts a LEFT JOIN ai_user_wallets')) {
      assert.deepEqual(values, [account.id]); assert.match(sql, /a\.id=\$1/);
      return { rows: [{ account_id: account.id, balance_cents: '500', reserved_cents: '100' }] };
    }
    if (sql.includes('FROM ai_wallet_entries e')) {
      assert.deepEqual(values, [account.id]); assert.match(sql, /e\.account_id=\$1/); return { rows: [] };
    }
    // The memory worker's price timer finds no accounts and cannot contact a provider.
    if (sql.includes('ai_user_channels') && !values?.length) return { rows: [] };
    throw new Error(`Unexpected test query: ${sql}`);
  } };
  const runtime = createAiListingRuntime({ repository, resolvePool: async () => pool,
    env: { AI_LISTING_CONCURRENCY: '1' }, authenticate: async () => account, checkAccount: async () => account,
    validateTarget: async () => ({}), generateImage: async input => {
      assert.equal(input.accountId, account.id); generated.push(input); return { generatedUrl: 'https://media.test/new.jpg' };
    },
    readJson: async req => req.body || {}, sendJson: (res, status, body) => Object.assign(res, { status, body }),
  });
  return { account, runtime, generated, repository, sourceReads:()=>sourceReads, task: () => task,
    async request(path, method = 'GET', body = {}) {
      const res = {}; await runtime.handleRoute({ method, body }, res, new URL(`https://app.test/api${path}`)); return res;
    },
  };
}

function assertPublicTaskImages(task) {
  for (const image of task.images || []) assert.deepEqual(Object.keys(image).sort(),
    ['sku', 'index', 'sourceUrl', 'generatedUrl', 'status'].sort());
  assert.doesNotMatch(JSON.stringify(task), /private-(?:channel-id|profile-id|attempt-channel|excluded-channel|attempt-id|provider-request)/);
}

test('task HTTP lists and detail hide channel telemetry from users while retaining admin telemetry and public images', async t => {
  for (const role of ['user', 'admin']) for (const path of [
    '/ai-listing/tasks?view=tasks', '/ai-listing/tasks?view=completed&storeId=store-a', '/ai-listing/tasks', '/ai-listing/tasks/task-a',
  ]) await t.test(`${role} ${path}`, async () => {
    const f = taskAccessFixture(role); const res = await f.request(path);
    assert.equal(res.status, 200);
    const task = res.body.task || res.body.tasks[0]; assert.equal(task.generationDurationMs, 2000);
    assert.deepEqual(task.collectionSource, {type:'COLLECTOR_ASSISTANT',taskNames:['汽车用品选品']});
    assertPublicTaskImages(task);
    if (role === 'admin') {
      assert.equal(task.generationChannel, 'private-channel-name');
      if (!path.includes('?view=')) assert.equal(task.channelHistory[0].name, 'private-channel-name');
    } else {
      assert.equal(Object.hasOwn(task, 'generationChannel'), false);
      assert.equal(Object.hasOwn(task, 'channelHistory'), false);
      assert.doesNotMatch(JSON.stringify(res.body), /private-channel-name/);
    }
  });
});

test('task HTTP actions retain image DTO privacy and ownership boundaries', async t => {
  for (const action of ['cancel', 'retry', 'approve', 'pause', 'resume', 'delete']) await t.test(action, async () => {
    const f = taskAccessFixture();
    if (action === 'retry') f.task().status = 'GENERATION_FAILED';
    if (action === 'resume') f.task().status = 'PAUSED';
    const denied = await f.request('/ai-listing/tasks/other-account-task/' + action, 'POST');
    assert.equal(denied.status, 404);
    const res = await f.request('/ai-listing/tasks/task-a/' + action, 'POST');
    assert.equal(res.status, 200); assertPublicTaskImages(res.body.task);
    assert.equal(Object.hasOwn(res.body.task, 'generationChannel'), false);
    assert.equal(Object.hasOwn(res.body.task, 'channelHistory'), false);
  });
  const f = taskAccessFixture(); f.task().status = 'SUBMITTING';
  const conflict = await f.request('/ai-listing/tasks/task-a/cancel', 'POST');
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'AI_LISTING_TASK_CONFLICT');
});

test('task HTTP channel status gives users counts only and keeps channel identities for admins', async () => {
  for (const role of ['user', 'admin']) {
    const res = await taskAccessFixture(role).request('/ai-listing/channels');
    assert.equal(res.status, 200); assert.equal(res.body.counts.total, 1);
    if (role === 'admin') assert.equal(res.body.channels[0].name, 'private-channel-name');
    else { assert.deepEqual(Object.keys(res.body), ['counts']); assert.doesNotMatch(JSON.stringify(res.body), /private-/); }
  }
});

test('task HTTP keeps the user wallet scoped to its owner and rejects admin operations', async () => {
  const f = taskAccessFixture(); const res = await f.request('/ai-listing/billing?accountId=another-account');
  assert.equal(res.status, 200); assert.deepEqual(res.body.wallets.map(w => w.account_id), [f.account.id]);
  assert.equal(Object.hasOwn(res.body, 'costs'), false); assert.equal(Object.hasOwn(res.body, 'costTotal'), false);
  for (const path of ['/ai-listing/billing', '/admin/ai-user-channels', '/admin/product-restrictions']) {
    assert.equal((await f.request(path, 'POST', { accountId: 'another-account', action: 'topup', amount: '100' })).status, 403);
  }
});

test('task runtime permits an ordinary account to generate its own task through the injected port', async () => {
  const f = taskAccessFixture(); f.task().status = 'QUEUED';
  Object.assign(f.task().images[0], { generatedUrl: null, status: 'PENDING' });
  try { await f.runtime.start(); } finally { await f.runtime.stop(); }
  assert.equal(f.generated.length, 1); assert.equal(f.task().status, 'AWAITING_REVIEW');
});

// Real 1K tiles were 430–1043 KB: below the old 1 MB conversion threshold.
test("sub-megabyte PNG tiles publish efficiently without changing pixel dimensions", async () => {
  const sharp = (await import("sharp")).default;
  const original = await sharp({ create: { width: 384, height: 512, channels: 3, background: "#d9c8a7" } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(original.length > 128 * 1024 && original.length < 1024 * 1024);
  const result = await prepareAiListingImageForPublication({ bytes: original, contentType: "image/png" });
  assert.equal(result.contentType, "image/jpeg");
  assert.ok(result.bytes.length < original.length / 2);
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.width, 384);
  assert.equal(meta.height, 512);
  const small = { bytes: await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer(), contentType: "image/png" };
  assert.equal(await prepareAiListingImageForPublication(small), small);
});

test('default collect-group handoff excludes already listed siblings for the current account',async()=>{
 const variants=[{sku:'2102714113',images:['https://source.test/listed.jpg']},{sku:'2102713933',images:['https://source.test/new.jpg']}];
 const record={id:'group',sku:'2102714113',name:'Светильник',variants,variantData:{variants},listingDraft:{variants}};
 const sources=await loadAiListingCollectSources({accountId:'owner',collectItemIds:['group'],config:{targetStoreId:'store'},
  pool:{query:async(sql,args)=>{assert.equal(args[0],'owner');return {rows:sql.includes('FROM ai_image_listing_tasks')?[{status:'COMPLETED',items:[{sku:'2102714113'}],results:[]}]:[]};}},
  readCollectItems:async()=>[record],
  buildListingItems:snapshot=>snapshot.listingDraft.variants.map(v=>({scraped_sku:v.sku})),
 });
 assert.deepEqual(sources[0].items.map(i=>i.sku),['2102713933']);
 assert.equal(record.listingDraft.variants.length,2,'stored capture remains complete');
});


test('collect loader emits known local source failures without aborting later products or database errors',async()=>{
  const errors=[],built=[];
  const args={accountId:'owner',collectItemIds:['a','b','c'],config:{targetStoreId:'store'},pool:{query:async()=>({rows:[]})},
    readCollectItems:async()=>['a','b','c'].map(id=>({id,sku:id,images:['https://source.test/'+id]})),
    buildListingItems:item=>{built.push(item.id);if(item.id==='b')throw Object.assign(new Error('bad source'),{code:'AI_LISTING_INVALID_INPUT'});return [{scraped_sku:item.sku}];},
    onSourceError:row=>errors.push(row)};
  const sources=await loadAiListingCollectSources(args);assert.deepEqual(sources.map(s=>s.collectItemId),['a','c']);assert.deepEqual(built,['a','b','c']);assert.equal(errors[0].collectItemId,'b');
  await assert.rejects(loadAiListingCollectSources({...args,pool:{query:async()=>{throw new Error('database unavailable');}}}),/database unavailable/);
});


test('an owned already-listed collect record gives a skip receipt without blocking a new product',async()=>{
 const rejected=[];const sources=await loadAiListingCollectSources({accountId:'owner',collectItemIds:['old','new'],config:{targetStoreId:'s'},
  pool:{query:async sql=>({rows:sql.includes('FROM ai_image_listing_tasks')?[{status:'COMPLETED',items:[{sku:'old'}],results:[]}]:[]})},
  readCollectItems:async()=>['old','new'].map(id=>({id,sku:id,images:['https://source.test/'+id]})),buildListingItems:item=>[{scraped_sku:item.sku}],
  onSourceError:row=>rejected.push(row)});
 assert.deepEqual(sources.map(x=>x.collectItemId),['new']);assert.equal(rejected[0]?.collectItemId,'old');assert.equal(rejected[0]?.error?.code,'AI_LISTING_ALREADY_LISTED');
});


test('active reservation displays before the first request without charging preparation as generation duration', async()=>{
 const reserved={task_id:'task-a',name:'reserved-channel',status:'RESERVED',created_at:'2026-01-01T00:00:03Z',completed_at:null};
 for(const role of ['admin','user']){
  const f=taskAccessFixture(role,[reserved]);f.task().status='GENERATING';f.task().generationStage='preparing';
  const res=await f.request('/ai-listing/tasks/task-a');assert.equal(res.status,200);
  assert.equal(res.body.task.generationDurationMs,null);
  if(role==='admin'){assert.equal(res.body.task.generationChannel,'reserved-channel');assert.deepEqual(res.body.task.channelHistory,[]);}
  else assert.equal(Object.hasOwn(res.body.task,'generationChannel'),false);
 }
 const old={task_id:'task-a',name:'old-channel',status:'SUCCEEDED',created_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:00:02Z'};
 const f=taskAccessFixture('admin',[old,reserved]);f.task().status='GENERATING';
 let res=await f.request('/ai-listing/tasks?view=tasks');assert.equal(res.body.tasks[0].generationChannel,'reserved-channel');assert.equal(res.body.tasks[0].generationDurationMs,2000);
 f.task().status='COMPLETED';res=await f.request('/ai-listing/tasks/task-a');assert.equal(res.body.task.generationChannel,'old-channel');assert.equal(res.body.task.channelHistory.length,1);
});

test('legacy GRID geometry failure survives restart and retries slicing the same paid bytes without another model request',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {default:sharp}=await import('sharp');
 const {createAiListingGridPort}=await import('../ai-listing-runtime.mjs');
 const {createAiListingResultStore}=await import('../ai-listing-image-cache.mjs');
 const directory=await mkdtemp(join(tmpdir(),'legacy-grid-failure-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const bytes=await sharp({create:{width:200,height:200,channels:3,background:'#fff'}}).png().toBuffer();
 const input={accountId:'a',taskId:'retained-grid',sku:'s',sources:[{index:0,sourceUrl:'https://source.test/a.png'}],
  prompt:'keep',image:{language:'ru',quality:'high'},requestKey:'paid-once'};
 let models=0,downloads=0,slicing=0;
 const dependencies={publication:{baseUrl:'https://media.test/',prefix:'images'},
  downloadImage:async()=>{downloads++;return {buffer:bytes,contentType:'image/png'};},recognizeText:async()=>[''],
  onProgress:async stage=>{if(stage==='slicing')slicing++;},putObject:async()=>assert.fail('invalid slices cannot be published'),
  runChannel:async(_input,generate)=>generate({profile:{imageModel:'fixture'},gateway:{generateImage:async()=>{
   models++;return {bytes,contentType:'image/png',requestId:'original-provider-request'};
  }}})};
 const firstStore=createAiListingResultStore({directory,minFreeBytes:0});
 await assert.rejects(createAiListingGridPort({...dependencies,resultStore:firstStore})(input),error=>{
  assert.equal(error.code,'AI_LISTING_GRID_GEOMETRY_INVALID');assert.equal(error.paidResultRetained,true);return true;
 });
 const restarted=createAiListingResultStore({directory,minFreeBytes:0});
 const retained=await restarted.load(input,'GRID');
 assert.deepEqual(retained.bytes,bytes);assert.equal(retained.diagnostic.reason,'separator_count');
 await assert.rejects(createAiListingGridPort({...dependencies,resultStore:restarted})({...input,requestKey:'retry'}),{code:'AI_LISTING_GRID_GEOMETRY_INVALID'});
 assert.equal(models,1);assert.equal(downloads,1);assert.equal(slicing,2);
 assert.deepEqual((await restarted.load(input,'GRID')).bytes,bytes);
});

for(const mode of ['SINGLE','GRID'])test(`${mode} refuses a new paid request when the required retained result is missing`,async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createAiListingGridPort}=await import('../ai-listing-runtime.mjs');
 const {createAiListingResultStore}=await import('../ai-listing-image-cache.mjs');
 const directory=await mkdtemp(join(tmpdir(),'missing-paid-result-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const resultStore=createAiListingResultStore({directory,minFreeBytes:0});
 const forbidden=async()=>assert.fail('missing paid output must stop before source download, paid admission or publication');
 const dependencies={publication:{baseUrl:'https://media.test/',prefix:'images'},resultStore,
  downloadImage:forbidden,recognizeText:forbidden,runChannel:forbidden,putObject:forbidden,loadProfile:forbidden};
 const input={accountId:'a',taskId:'missing-'+mode,sku:'s',index:0,sourceUrl:'https://source.test/a.png',
  sources:[{index:0,sourceUrl:'https://source.test/a.png'}],prompt:'keep',image:{language:'ru',quality:'high'},
  requestKey:'ordinary-retry',mustReusePaidResult:true,beforeRequest:forbidden};
 const port=mode==='GRID'?createAiListingGridPort(dependencies):createAiListingImagePort(dependencies);
 await assert.rejects(port(input),{code:'AI_LISTING_PAID_RESULT_MISSING'});
 await assert.rejects(port({...input,requestKey:'another-ordinary-retry'}),{code:'AI_LISTING_PAID_RESULT_MISSING'});
 assert.equal(await resultStore.load(input,mode),null);
});


test('HTTP pagination includes sources within bounded repository read and avoids a second source query', async()=>{
 const f=taskAccessFixture();f.repository.listPage=async input=>{
  assert.equal(input.includeCollectionSources,true);assert.equal(input.accountId,f.account.id);
  return {tasks:[{id:'task-a',status:'SUBMISSION_FAILED',collectionSource:{type:'COLLECTOR_ASSISTANT',taskNames:['原任务']}}],total:1};
 };
 const res=await f.request('/ai-listing/tasks?view=tasks&group=failed');assert.equal(res.status,200);
 assert.equal(f.sourceReads(),0);assert.deepEqual(res.body.tasks[0].collectionSource.taskNames,['原任务']);
});

test('HTTP retry preserves explicit selected SKUs for an already submitted task',async()=>{
 const f=taskAccessFixture();Object.assign(f.task(),{status:'SUBMITTED',submissionId:'existing',submissionStarted:true,
 submissionResults:[{sku:'sku-a',importStatus:'SUCCEEDED',stockStatus:'FAILED',errors:['PRODUCT_IS_NOT_CREATED']}]});
 const res=await f.request('/ai-listing/tasks/task-a/retry','POST',{expectedVersion:f.task().version,skus:['sku-a']});
 assert.equal(res.status,200,JSON.stringify(res.body));assert.deepEqual(f.task().submissionRetrySkus,['sku-a']);assert.equal(f.task().submissionId,'existing');
});

test('HTTP home stages pass through before pagination and invalid stages cannot silently broaden the task list',async()=>{
 const f=taskAccessFixture(),inputs=[];
 f.repository.listPage=async input=>{inputs.push(input);return {tasks:[],total:0,counts:{active:12,failed:4,errors:3}};};
 for(const stage of ['review','failed','enrichment','generating','submitting','attention']) {
  const group=['failed','attention'].includes(stage)?'all':'active';
  const res=await f.request(`/ai-listing/tasks?view=tasks&group=${group}&stage=${stage}&limit=5&offset=5`);
  assert.equal(res.status,200);assert.equal(inputs.at(-1).stage,stage);assert.equal(inputs.at(-1).group,group);
  assert.equal(inputs.at(-1).offset,'5');assert.equal(res.body.counts.active,12);
 }
 const accepted=inputs.length;
 for(const query of ['view=tasks&stage=not-a-stage','view=completed&stage=review','stage=review']) {
  const res=await f.request('/ai-listing/tasks?'+query);assert.equal(res.status,400);
 }
 assert.equal(inputs.length,accepted);
});
