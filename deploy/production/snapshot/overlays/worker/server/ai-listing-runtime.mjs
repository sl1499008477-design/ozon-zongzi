import {createAiRuntimeSettings,defaultAiRuntimeSettings} from './ai-runtime-settings.mjs';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createAiWorkerCapacity,readAiWorkerResources} from './ai-worker-capacity.mjs';
import { createImageWorkQueue } from "./ai-image-work-queue.mjs";
import {withoutListedSkus, findOzonCollectedSkuSources} from './collection-sku-rules.mjs';
import {buildCollectBoxListingItems} from './collect-box-listing-items.mjs';
import {createOzonWebCollectionService} from './ozon-web-collection.mjs';
import {getCollectorRunForAccount} from './collector-desktop-service.mjs';
import * as collectorSelection from './collector-selection-service.mjs';
import {createProductRestrictions,restrictionItems} from "./product-restrictions.mjs";
import {aiListingItemPrice,resolveAiListingSourceCategories} from './ai-listing-source-facts.mjs';
import {createPostgresAccountSharedOzonCategoryRepository} from "./account-shared-ozon-category-repository.mjs";
import {createAccountSharedOzonCategoryService} from "./account-shared-ozon-category-service.mjs";
import { createSkuBilling } from './ai-sku-billing.mjs';
import { createChannelPriceChecker } from './ai-channel-price-check.mjs';
import { createAiListingStoreRouting } from "./ai-listing-store-routing.mjs";
import sharp from "sharp";
import {prepareGrid, splitGrid} from "./ai-listing-grid.mjs";
import {recognizeListingText,listingOcrCapability} from "./ai-listing-ocr.mjs";
import { createAiListingPresets } from "./ai-listing-presets.mjs";
import { createAiUserChannels } from "./ai-user-channels.mjs";
import {readAiChannelTestSample,readAiChannelTestImage} from './ai-channel-test-sample.mjs';
import { randomBytes } from "node:crypto";
import { normalizeAiListingConfig, createAiListingService } from "./ai-listing-service.mjs";
import { createAiListingRepository } from "./ai-listing-repository.mjs";
import { createAiListingSubmissionPorts } from "./ai-listing-submission.mjs";
import {createOzonListingMedia} from './ozon-listing-media.mjs';
import { getPostgresPool } from "./db/connection.mjs";
import { listCollectItemsV3,readStoreCredentialV3 } from "./listing-pipeline.mjs";
import {createOzonCategoryService} from './ozon-category-service.mjs';
import {callOzonSellerApi} from './ozon-client.mjs';
import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import { parseAutoListingSkuWorkbook } from "./auto-listing-excel-import.mjs";
import { createAutoListingSourceImageDownloader, AUTO_LISTING_SOURCE_DOWNLOAD_POLICY } from "./auto-listing-source-downloader.mjs";
import { putObjectFromBuffer, getObjectBuffer } from "./object-storage.mjs";
import { listingAssetPublicationLocation } from "./runtime-config.mjs";
import { gatewayImageSize } from "./auto-listing-image-generator.mjs";

const ratios = new Set(["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"]);
const resolutions = { "1K": 1024, "2K": 2048, "4K": 4096 };
const invalid = () => Object.assign(new Error("AI 上架配置不受支持"), { statusCode: 400, code: "AI_LISTING_INVALID_INPUT" });

export function createAiListingRuntime({ authenticate, readJson, sendJson, collectSku, buildListingItems = buildCollectBoxListingItems,
  loadCollectorRun = ({accountId,runId}) => getCollectorRunForAccount(accountId,runId),
  loadCollectorGroups = input => collectorSelection.getCollectorRunProductGroups(input),
  loadSources, submitListing, readSubmission, generateImage, generateImageGroup, checkAccount: injectedCheckAccount,
  validateTarget: injectedValidateTarget, repository: injectedRepository, env = process.env,
  resolvePool = getPostgresPool, readResources = readAiWorkerResources, clock, publication: injectedPublication, getObject = getObjectBuffer } = {}) {
  let acceptingRequests=true;
  const fencedInput=input=>({...input,beforeRequest:async()=>{
    if(!acceptingRequests)throw Object.assign(new Error("AI 后台正在停止"),{code:"AI_LISTING_WORKER_STOPPING",deliveryState:"NOT_SENT"});
    await input.beforeRequest?.();
    if(!acceptingRequests)throw Object.assign(new Error("AI worker stopping"),{code:"AI_LISTING_WORKER_STOPPING",deliveryState:"NOT_SENT"});
  }});
  let initialization; let running = false; let priceTimer; let priceActive; let mode = "all";
  let settings=defaultAiRuntimeSettings(env),appliedRevision=null;
  const concurrency=settings.productConcurrency;
  let settingsStorePromise;
  const settingsStore=()=>settingsStorePromise ||= Promise.resolve().then(resolvePool).then(pool=>createAiRuntimeSettings({pool,env})).catch(error=>{settingsStorePromise=null;throw error;});
  let lanes = [];
  const capacity = createAiWorkerCapacity({ceiling:concurrency});
  let resourceTimer,resourceActive,previousResources,loopDelay;
  const localWork = createImageWorkQueue({concurrency:settings.localConcurrency});
  async function refreshCapacity(){
    resourceActive=(async()=>{
      const store=await settingsStore();
      const saved=await store.read();
      if(appliedRevision===null)capacity.configure({ceiling:saved.settings.productConcurrency,adaptiveEnabled:false});
      capacity.configure({ceiling:saved.settings.productConcurrency,adaptiveEnabled:saved.settings.adaptiveEnabled});
      localWork.setConcurrency(saved.settings.localConcurrency);
      settings=saved.settings;appliedRevision=saved.revision;
      let sample=null;
      try {
        sample=await readResources({previous:previousResources,eventLoopDelayMs:(loopDelay?.percentile(95)||0)/1e6});
        previousResources=sample;loopDelay?.reset();capacity.observe(sample);
      } catch { /* Settings still apply when resource sampling is unavailable. */ }
      const counts=await store.activeCounts();
      const resources=sample?Object.fromEntries(['memoryLimitBytes','memoryUsedBytes','memoryScope','cpuCores','cpuRatio','eventLoopDelayMs'].map(k=>[k,sample[k]??null])):null;
      await store.heartbeat({status:running?'running':'stopped',appliedRevision,effectiveProductConcurrency:capacity.capacity,
        ...counts,local:localWork.snapshot(),resources,adaptiveEnabled:settings.adaptiveEnabled});
    })();
    try{await resourceActive;}catch{ /* Leave the previous heartbeat to expire; never acknowledge a failed refresh. */ }
    finally{resourceActive=null;if(running){resourceTimer=setTimeout(()=>{void refreshCapacity();},5000);resourceTimer.unref?.();}}
  }
  const runLocalWork = work => localWork.run(work);
  const publication = () => injectedPublication || listingAssetPublicationLocation(env);
  const capabilities = async () => ({grid:generateImageGroup ? {available:true} : await listingOcrCapability()});
  async function initialize() {
    if (!initialization) initialization = (async () => {
      const pool = await resolvePool();
      let testCapability;
      const userChannels = createAiUserChannels({ pool, env, getRuntimeSettings:()=>settings,
        getTestSample:async()=>{
          const sample=await readAiChannelTestSample();
          const capability=await (testCapability ||= listingOcrCapability());
          return {...sample,available:capability.available,reason:capability.reason||null};
        },
        generateTestGrid:(input,onProgress)=>createAiListingGridPort({downloadImage:readAiChannelTestImage,recognizeText:recognizeListingText,
          runChannel:(input,generate)=>userChannels.run(input,generate),publication:publication(),putObject:putObjectFromBuffer,onProgress,runLocalWork})(fencedInput(input)),
      });
      const repository = injectedRepository || createAiListingRepository({ pool });
      const submission = createAiListingSubmissionPorts({ pool,
        prepareMedia:env.LISTING_ASSET_DOWNLOAD_BASE_URL?createOzonListingMedia({publication:publication(),downloadBaseUrl:env.LISTING_ASSET_DOWNLOAD_BASE_URL}):undefined });
      const sourceCategories=createOzonCategoryService({callOzonSellerApi});
      const validateTarget = injectedValidateTarget || submission.validateTarget;
      const checkAccount = injectedCheckAccount || (async ({ accountId }) => {
        const row = (await pool.query("SELECT id,role,status,expires_at FROM accounts WHERE id=$1", [accountId])).rows[0];
        if (!row || row.status !== "active" || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
          throw Object.assign(new Error("账号不可用"), { statusCode: 403, code: "AI_LISTING_ACCOUNT_UNAVAILABLE" });
        }
        return row;
      });
      async function accountFor(accountId) {
        const account = await checkAccount({ accountId });
        assertPermission(account, PERMISSIONS.TENANT_OPERATE);
        return account;
      }
      async function loadImageProfile({ accountId }) {
        if (generateImage || generateImageGroup) return null;
        await userChannels.assertAvailable(accountId);
        return null;
      }
      async function imageGeneration(input) {
        input=fencedInput(input);await input.beforeRequest();
        await accountFor(input.accountId);
        if (generateImage) return generateImage(input);
        {
          const config = publication();
          if (!config) throw Object.assign(new Error("公开图片存储未配置"), { code: "AI_LISTING_PUBLICATION_REQUIRED" });
          return createAiListingImagePort({runChannel: runTaskChannel,
            publication: config, putObject: putObjectFromBuffer,
            downloadImage: downloadAiListingSourceImage, runLocalWork,
          })(input);
        }
      }
      const runTaskChannel = (input, generate) => userChannels.run({...input, beforeRequest:async()=>{
        await accountFor(input.accountId); await input.beforeRequest?.();
      }}, generate);
      const restrictions=createProductRestrictions(pool);
      async function checkRestrictions(input){
        return restrictions.assertAllowed({...input,items:restrictionItems(input.source)});
      }
      const billing=createSkuBilling({pool});
      const webCollection = createOzonWebCollectionService({ getPool: async () => pool });
      const readSources = loadSources || (input => loadAiListingCollectSources({ ...input, pool, buildListingItems }));
      const service = createAiListingService({ repository, clock, reserveChannel: injectedRepository ? undefined : input => userChannels.reserveProduct(input), checkRestrictions:injectedRepository?undefined:checkRestrictions, billing: injectedRepository?undefined:billing,
        checkSource:injectedRepository?undefined:async({accountId,source,config})=>{
          const {store}=await validateTarget({accountId,config,validateWarehouse:false});
          for(const group of source.items)aiListingItemPrice(source,group,config,store);
          return resolveAiListingSourceCategories({accountId,source,pool,getCategoryTree:async()=>{
            const credential=await readStoreCredentialV3(config.targetStoreId,accountId);
            return (await sourceCategories.getCategoryTree({accountId,store:{...credential,ownerAccountId:accountId},language:'DEFAULT'})).items;
          }});
        },
        routeStores:createAiListingStoreRouting({pool,validateTarget}),
        loadSources: readSources,
        collectSku: async ({ accountId, sku, config, ...capture }) => {
          const account = await accountFor(accountId);
          await validateTarget({ accountId, config });
          if (!collectSku) return collectAiListingSkuSource({ accountId, sku, config, ...capture }, {
            webCollection, loadSources: readSources,
            findExisting: async ({ accountId, sku }) => (await findOzonCollectedSkuSources(pool, accountId, [sku])).get(sku),
          });
          const result = await collectSku({ account, sku, targetStoreId: config.targetStoreId });
          const categories=createAccountSharedOzonCategoryService({repository:createPostgresAccountSharedOzonCategoryRepository({pool})});
          const categoryResolution=(await categories.readForItems({accountId,collectItemIds:[result.item.id]}))[0]?.categoryResolution;
          return buildAiListingSource({...result.item,categoryResolution}, config.targetStoreId, buildListingItems);
        },
        generateImage: imageGeneration,
        generateImageGroup: async input => {
          input=fencedInput(input);await input.beforeRequest();
          await accountFor(input.accountId);
          if (generateImageGroup) return generateImageGroup(input);
          if (!(await capabilities()).grid.available) throw Object.assign(new Error('本机文字识别不可用'),{code:'AI_LISTING_OCR_UNAVAILABLE'});
          return createAiListingGridPort({downloadImage: downloadAiListingSourceImage,
            recognizeText: recognizeListingText, runChannel: runTaskChannel, runLocalWork,
            publication: publication(), putObject: putObjectFromBuffer})(input);
        },
        submitListing: async input => {
          try { await accountFor(input.accountId); await validateTarget(input); }
          catch (error) { error.definitelyNotSubmitted = true; throw error; }
          return (submitListing || submission.submitListing)(input);
        },
        readSubmission: async input => {
          await accountFor(input.accountId);
          return (readSubmission || submission.readSubmission)(input);
        },
      });
      async function taskTelemetry(account, tasks) {
        if (!tasks.length) return tasks;
        const collectionSources = repository.readCollectionSources
          ? await repository.readCollectionSources({accountId:account.id,taskIds:tasks.map(task=>task.id)}) : new Map();
        const rows=(await pool.query(`SELECT r.task_id,c.name,r.status,r.error_code,r.created_at,r.completed_at
          FROM ai_user_channel_requests r JOIN ai_user_channels c ON c.id=r.channel_id AND c.account_id=r.account_id
          WHERE r.account_id=$1 AND r.task_id=ANY($2::text[]) ORDER BY r.created_at`,
          [account.id, tasks.map(t=>t.id)])).rows;
        const byTask=new Map();
        for(const row of rows){if(!byTask.has(row.task_id))byTask.set(row.task_id,[]);byTask.get(row.task_id).push(row);}
        return tasks.map(task=>{
          const requests=byTask.get(task.id)||[];
          const last=requests.at(-1);
          return {...task,
            ...(collectionSources.has(task.id) ? {collectionSource:collectionSources.get(task.id)} : {}),
            generationDurationMs:requests.length?requests.reduce((sum,r)=>sum+Math.max(0,
              (r.completed_at?new Date(r.completed_at).getTime():r.status==='STARTED'&&task.status==='GENERATING'?Date.now():new Date(r.created_at).getTime())-new Date(r.created_at).getTime()),0):null,
            ...(account.role === "admin" ? {generationChannel:last?.name || null,
              channelHistory:requests.map(r=>({name:r.name,status:r.status,errorCode:r.error_code}))} : {})};
        });
      }
      return { service, repository, billing, restrictions, validateTarget, loadImageProfile, userChannels, priceChecker: createChannelPriceChecker({pool,env}), presets: createAiListingPresets(pool), taskTelemetry };
    })().catch(error => { initialization = null; throw error; });
    return initialization;
  }
  async function handleRoute(req, res, url) {
    let config;
    try { config = publication(); } catch { /* API remains available to report task errors */ }
    const assetPrefix = config ? new URL(`${config.prefix}/ai-image-listing/`, config.baseUrl).pathname : null;
    if (assetPrefix && url.pathname.startsWith(assetPrefix)) {
      const filename = url.pathname.slice(assetPrefix.length);
      if (!["GET", "HEAD"].includes(req.method) || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(filename)) {
        sendJson(res, 404, { message: "图片不存在" }); return true;
      }
      try {
        const bytes = await getObject(`${config.prefix}/ai-image-listing/${filename}`, { maxBytes: 32 * 1024 * 1024 });
        res.writeHead(200, { "Content-Type": `image/${filename.endsWith("jpg") ? "jpeg" : filename.split(".").pop()}`,
          "Content-Length": bytes.length, "Cache-Control": "public,max-age=31536000,immutable", "X-Content-Type-Options": "nosniff" });
        res.end(req.method === "HEAD" ? undefined : bytes);
      } catch { sendJson(res, 404, { message: "图片不存在" }); }
      return true;
    }
    const apiPath = url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;
    if(apiPath==='/admin/ai-runtime-settings'){
      try{
        const actor=await authenticate(req);
        if(actor?.role!=='admin'){sendJson(res,403,{message:'仅管理员可管理 AI 并发设置'});return true;}
        const store=await settingsStore();
        if(req.method==='GET')sendJson(res,200,await store.read());
        else if(req.method==='PUT')sendJson(res,200,await store.save(actor,await readJson(req,{maxBytes:4096})));
        else sendJson(res,405,{message:'不支持的请求方法'});
      }catch(error){const status=error.statusCode||error.status||500;sendJson(res,status,{message:status<500?error.message:'AI 并发设置暂不可用'});}
      return true;
    }
    if(apiPath==='/admin/product-restrictions'||apiPath.startsWith('/admin/product-restrictions/')){
      try{
        const actor=await authenticate(req);
        if(actor?.role!=='admin'){sendJson(res,403,{message:'仅管理员可管理禁售规则'});return true;}
        const {restrictions}=await initialize();
        const id=apiPath.slice('/admin/product-restrictions/'.length);
        let result;
        if(req.method==='GET'&&apiPath==='/admin/product-restrictions')result=await restrictions.overview(actor);
        else if(req.method==='POST'&&apiPath==='/admin/product-restrictions')result=await restrictions.save(actor,null,await readJson(req,{maxBytes:262144}));
        else if(req.method==='PUT'&&id&&!id.includes('/'))result=await restrictions.save(actor,id,await readJson(req,{maxBytes:262144}));
        else {sendJson(res,404,{message:'接口不存在'});return true;}
        sendJson(res,200,result);
      }catch(error){sendJson(res,error.statusCode||500,{message:error.statusCode?error.message:'禁售规则服务暂不可用'});}
      return true;
    }
    if (apiPath.startsWith("/admin/ai-user-channels")) {
      try {
        const actor=await authenticate(req);
        if (actor?.role !== "admin") throw Object.assign(new Error("仅管理员可管理用户通道"),{statusCode:403});
        const {userChannels}=await initialize();
        const match=/^\/admin\/ai-user-channels\/([^/]+)\/(status|check|models|test|test-review)$/.exec(apiPath);
        let result;
        if(req.method==="GET" && apiPath==="/admin/ai-user-channels") result=await userChannels.overview(actor);
        else if(req.method==="POST" && apiPath==="/admin/ai-user-channels") result=await userChannels.create(actor,await readJson(req,{maxBytes:16_384}));
        else if(req.method==="DELETE" && /^\/admin\/ai-user-channels\/[^/]+$/.test(apiPath)) result=await userChannels.remove(actor,decodeURIComponent(apiPath.split("/").pop()));
        else if(req.method==="POST" && match) result=match[2]==="test"?await userChannels.queueCapability(actor,decodeURIComponent(match[1]),await readJson(req,{maxBytes:1024})):match[2]==="test-review"?await userChannels.reviewCapability(actor,decodeURIComponent(match[1]),await readJson(req,{maxBytes:8192})):match[2]==="models"?await userChannels.updateModels(actor,decodeURIComponent(match[1]),await readJson(req,{maxBytes:4096})):match[2]==="check"?await userChannels.check(actor,decodeURIComponent(match[1])):await userChannels.setEnabled(actor,decodeURIComponent(match[1]),(await readJson(req,{maxBytes:1024})).enabled);
        else {sendJson(res,404,{message:"接口不存在"});return true;}
        sendJson(res,200,result);
      } catch(error) { sendJson(res,error.statusCode||400,{message:["AI_LISTING_CHANNEL_UNAVAILABLE","INVALID_CHANNEL_PRICING"].includes(error.code)||error.statusCode===403?error.message:"通道操作未完成，请检查连接和模型配置"}); }
      return true;
    }
    if (!apiPath.startsWith("/ai-listing/")) return false;
    try {
      const account = await authenticate(req);
      assertPermission(account, PERMISSIONS.TENANT_OPERATE);
      const { service, repository, billing, validateTarget, loadImageProfile, userChannels, presets, taskTelemetry } = await initialize();
      const path = apiPath.slice("/ai-listing".length);
      const scope = { accountId: account.id };
      if(path==='/capabilities'&&req.method==='GET'){sendJson(res,200,await capabilities());return true;}
      if(path==='/billing/records'){
        if(req.method==='GET')sendJson(res,200,await billing.records(account,Object.fromEntries(url.searchParams)));
        else sendJson(res,405,{message:'不支持的请求方法'});
        return true;
      }
      if(path==='/billing'){
        if(req.method==='GET')sendJson(res,200,await billing.snapshot(account));
        else if(req.method==='POST'){if(account.role!=='admin'){sendJson(res,403,{message:'仅管理员可定价和充值'});return true;}sendJson(res,200,await billing.configure(account,await readJson(req,{maxBytes:4096})));}
        else sendJson(res,405,{message:'不支持的请求方法'});
        return true;
      }
      const presetMatch = /^\/presets\/(prompts|configs)(?:\/([^/]+))?$/.exec(path);
      if (presetMatch) {
        const [,kind,id] = presetMatch;
        let result;
        if(req.method === "GET") result = id ? {item:await presets.get(account.id,kind,id)} : {items:await presets.list(account.id,kind)};
        else if(req.method === "POST" && !id || req.method === "PUT" && id) result = {item:await presets.save(account.id,kind,id,await readJson(req,{maxBytes:100_000}))};
        else if(req.method === "DELETE" && id) result = await presets.remove(account.id,kind,id);
        else {sendJson(res,405,{message:"不支持的请求方法"});return true;}
        sendJson(res,200,result);return true;
      }
      if (req.method === "GET" && path === "/channels") {
        const status = await userChannels.workingStatus(account.id);
        sendJson(res,200,account.role === "admin" ? status : {counts:status.counts}); return true;
      }
      if (req.method === "GET" && path === "/tasks") {
        if (url.searchParams.has('view')) {
          const view=url.searchParams.get('view');if(!['tasks','completed'].includes(view))throw invalid();
          const page=await repository.listPage({...scope,view,storeId:url.searchParams.get('storeId')||'',limit:url.searchParams.get('limit'),offset:url.searchParams.get('offset')});
          const tasks=(await taskTelemetry(account,page.tasks)).map(({channelHistory,...summary})=>summary);
          sendJson(res,200,{...page,tasks});
        } else sendJson(res, 200, { tasks: await taskTelemetry(account, await service.listTasks(scope)) });
        return true;
      }
      const match = /^\/tasks\/([^/]+)(?:\/(retry|cancel|approve))?$/.exec(path);
      if (req.method === "GET" && match && !match[2]) {
        const task=await service.getTask({ ...scope, taskId: decodeURIComponent(match[1]) });
        sendJson(res, 200, { task: (await taskTelemetry(account,[task]))[0] }); return true;
      }
      if (req.method !== "POST") { sendJson(res, 405, { message: "不支持的请求方法" }); return true; }
      const body = await readJson(req, { maxBytes: 3 * 1024 * 1024, requireBody: false });
      if (match?.[2]) {
        const taskId = decodeURIComponent(match[1]);
        if (match[2] === "approve") {
          assertPermission(account, PERMISSIONS.TENANT_OPERATE);
          const task = await service.getTask({ ...scope, taskId });
          await validateTarget({ ...scope, config: task.config });
        }
        if (match[2] === "retry") {
          const task = await service.getTask({ ...scope, taskId });
          if (task.images.some(image => !image.generatedUrl)) await loadImageProfile(scope);
        }
        const action = { retry: "retryTask", cancel: "cancelTask", approve: "approveTask" }[match[2]];
        sendJson(res, 200, { task: await service[action]({ ...scope, taskId }) }); return true;
      }
      if (path === '/tasks/from-collector-run') {
        if (!body || Object.keys(body).some(key => !['runId','collectItemIds'].includes(key))
          || typeof body.runId !== 'string' || !body.runId.trim() || body.runId.length > 500
          || !Array.isArray(body.collectItemIds) || !body.collectItemIds.length || body.collectItemIds.length > 100
          || body.collectItemIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 500)) throw invalid();
        const run = await loadCollectorRun({...scope,runId:body.runId});
        if (!run) throw Object.assign(new Error('采集运行不存在'),{statusCode:404,code:'AI_LISTING_COLLECTOR_RUN_NOT_FOUND'});
        const options = run.configurationSnapshot?.configuration || {};
        if (run.status !== 'COMPLETED' || options.autoSendToAiListing !== true || options.autoStartAiGeneration !== true) {
          throw Object.assign(new Error('本次采集未完成或未开启自动生图'),{statusCode:409,code:'AI_LISTING_COLLECTOR_RUN_NOT_READY'});
        }
        const frozen = options.aiListingConfigSnapshot?.config;
        if (frozen?.manualReview !== true && options.aiAutoSubmitConfirmed !== true) {
          throw Object.assign(new Error('本次运行尚未确认自动上架'),{statusCode:409,code:'AI_LISTING_COLLECTOR_CONFIRMATION_REQUIRED'});
        }
        const groups = await loadCollectorGroups({...scope,runId:run.id,collectItemIds:[...new Set(body.collectItemIds)]});
        const result = await service.createFromCollectorRun({...scope,runId:run.id,groups,config:frozen},{beforeCreate:async raw => {
          if (typeof raw?.prompt !== 'string' || !raw.prompt.trim()) throw Object.assign(new Error('本次运行缺少冻结的生图配置'),{statusCode:409,code:'AI_LISTING_COLLECTOR_CONFIG_REQUIRED'});
          const selected = validateAiListingOptions(raw);
          if(selected.generationMode==='GRID'&&!(await capabilities()).grid.available)throw Object.assign(new Error('当前环境不支持智能拼图切片'),{statusCode:422,code:'AI_LISTING_OCR_UNAVAILABLE'});
          await validateTarget({...scope,config:selected});
          for(const target of selected.fallbackStores||[])await validateTarget({...scope,config:{...selected,...target}});
          await loadImageProfile(scope);
          return selected;
        }});
        sendJson(res,201,result);return true;
      }
      if (!["/tasks/from-collect-box", "/imports/excel"].includes(path)) { sendJson(res, 404, { message: "接口不存在" }); return true; }
      // Resolve the owned selection once; the task stores content, never a live reference.
      const prompt = body?.promptId ? await presets.get(account.id,"prompts",body.promptId) : null;
      const selected = validateAiListingOptions(prompt ? {...body.config,prompt:prompt.content} : body?.config);
      if(selected.generationMode==='GRID'&&!(await capabilities()).grid.available)throw Object.assign(new Error('当前环境不支持智能拼图切片，请选择逐张生图'),{statusCode:422,code:'AI_LISTING_OCR_UNAVAILABLE'});
      if (!selected.manualReview) assertPermission(account, PERMISSIONS.TENANT_OPERATE);
      await validateTarget({ ...scope, config: selected });
      for(const target of selected.fallbackStores||[])await validateTarget({...scope,config:{...selected,...target}});
      await loadImageProfile(scope);
      if (path === "/tasks/from-collect-box") {
        const errors=[];
        const tasks = await service.createFromCollect({ ...scope, collectItemIds: body.collectItemIds, selectedSkus: body.selectedSkus, idempotencyKey: body.idempotencyKey, config: selected },{onSourceError:row=>errors.push(row)});
        sendJson(res, 201, { tasks, errors });
      } else {
        if (typeof body.contentBase64 !== "string" || body.contentBase64.length > 2_796_204
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) throw invalid();
        const parsed = await parseAutoListingSkuWorkbook({ name: body.name, buffer: Buffer.from(body.contentBase64, "base64") });
        const tasks = parsed.acceptedRows.length ? await service.createFromSkus({ ...scope, skus: parsed.acceptedRows.map(row => row.sku),
          idempotencyKey: body.idempotencyKey, config: selected }) : [];
        sendJson(res, 201, { tasks, errors: [...parsed.rejectedRows, ...parsed.duplicateRows] });
      }
    } catch (error) {
      const status = Number(error.statusCode || error.status) || (error.code==='RFBS_VALIDATION_REQUIRED'?503:500);
      const safeStatus = status >= 400 && status < 600 ? status : 500;
      const code = /^(AI_LISTING_|AUTO_LISTING_EXCEL_|PERMISSION_FORBIDDEN|RFBS_)[A-Z_]*$/.test(error.code || "") ? error.code : "AI_LISTING_REQUEST_FAILED";
      sendJson(res, safeStatus, { code, message: code==='RFBS_VALIDATION_REQUIRED'?'RFBS 仓库验证暂未完成，请稍后重试':code.startsWith('AI_LISTING_COLLECTOR_') || ["AI_LISTING_BILLING_INVALID", "AI_LISTING_PRESET_INVALID", "AI_LISTING_MODEL_UNAVAILABLE", "AI_LISTING_PROFILE_REQUIRED", "AI_LISTING_CHANNEL_UNAVAILABLE","AI_LISTING_LOGISTICS_REQUIRED","AI_LISTING_SKU_LIMIT","AI_LISTING_OCR_UNAVAILABLE","AI_LISTING_CATEGORY_UNRESOLVED","AI_LISTING_ENRICHMENT_FAILED"].includes(code) ? error.message : safeStatus === 403 ? "没有操作权限或店铺仓库不可用" : safeStatus === 404 ? "任务或来源不存在" : safeStatus === 400 ? "请检查 AI 上架输入和图片配置" : "AI 上架请求未完成，请检查配置后重试" });
    }
    return true;
  }
  async function checkPrices() {
    if (!running) return;
    priceActive=(async()=>{if(mode==='worker'&&appliedRevision===null)return;const {priceChecker,billing}=await initialize();if(!injectedRepository)await billing.recover();await priceChecker.runDue();})();
    try { await priceActive; } catch { console.warn('[ai-pricing] daily check unavailable'); }
    finally {priceActive=null;if(running){priceTimer=setTimeout(()=>{void checkPrices();},60_000);priceTimer.unref?.();}}
  }
  async function tick(lane) {
    if (!running) return;
    lane.active = (async () => { if(mode==='worker'&&(appliedRevision===null||(lane.phase==='generate'&&lane.index>=capacity.capacity)||(lane.phase==='capability'&&capacity.capacity===0)))return; const { service,userChannels } = await initialize(); if(!running)return; if(lane.phase==='capability')await userChannels.processNextCapability();else await service.processNext({ phase: lane.phase, ...(mode==='worker'?{capacity:capacity.capacity}:{}) }); })();
    try { await lane.active; } finally {
      lane.active = null;
      if (running) { lane.timer = setTimeout(() => { void tick(lane).catch(() => {}); }, 1000); lane.timer.unref?.(); }
    }
  }
  return { handleRoute,
    async start({ mode: selectedMode = "all" } = {}) {
      if (running) return;
      if (!["all", "prepare", "worker"].includes(selectedMode)) throw new Error("AI 执行模式无效");
      mode = selectedMode;
      const phases = mode === "prepare" ? ["prepare"] : mode === "worker"
        ? [...Array(20).fill("generate"), "finalize", "capability"] : Array(concurrency).fill("all");
      lanes = phases.map((phase,index) => ({phase,index, timer: null, active: null}));
      running = true;acceptingRequests=true;
      if(mode==='worker'){appliedRevision=null;capacity.configure({ceiling:0,adaptiveEnabled:false});loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();await refreshCapacity();}
      if (mode !== "prepare") void checkPrices();
      await Promise.allSettled(lanes.map(lane => tick(lane)));
    },
    async stop() {
      running = false;acceptingRequests=false;
      clearTimeout(resourceTimer);loopDelay?.disable();await resourceActive?.catch(()=>{});
      clearTimeout(priceTimer);
      await priceActive?.catch(()=>{});
      for (const lane of lanes) clearTimeout(lane.timer);
      await Promise.allSettled(lanes.map(lane => lane.active));
      if(mode==='worker')await settingsStore().then(store=>store.heartbeat({status:'stopped',appliedRevision})).catch(()=>{});
    },
  };
}

export function validateAiListingOptions(raw) {
  const config = normalizeAiListingConfig(raw);
  if (!/^\d+(?:\.\d{1,6})?$/.test(config.priceMultiplier)
    || !ratios.has(config.image.ratio) || !Object.hasOwn(resolutions, config.image.resolution)
    || !["low", "medium", "high", "auto"].includes(config.image.quality)
    || !["ru", "en", "zh"].includes(config.image.language)) throw invalid();
  return config;
}

// Ozon fetches public images under a short body-read deadline. Preserve pixels'
// dimensions while reducing lossless tiles, including the sub-1 MB files that
// timed out in multi-variant imports. Keep small PNGs and all existing JPEGs intact.
export async function prepareAiListingImageForPublication(result) {
  if (result.contentType !== "image/png" || result.bytes.length <= 128 * 1024) return result;
  const bytes = await sharp(result.bytes).flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
  return bytes.length < result.bytes.length ? { ...result, bytes, contentType: "image/jpeg" } : result;
}

// Prepare the original before claiming a paid AI channel. Local download failures
// must not cool down otherwise healthy gateway accounts.
export async function downloadAiListingSourceImage(sourceUrl, downloader = createAutoListingSourceImageDownloader()) {
  const { timeoutMs, maxBytes, maxPixels, maxRedirects, forbidHttpsDowngrade } = AUTO_LISTING_SOURCE_DOWNLOAD_POLICY;
  const result = await downloader.downloadSourceImage({ sourceUrl, timeoutMs, maxBytes, maxPixels, maxRedirects, forbidHttpsDowngrade });
  return { buffer: result.bytes, contentType: result.contentType };
}

export function createAiListingImagePort({ loadProfile, gateway, downloadImage, putObject, publication,
  runChannel, runLocalWork = work => work() }) {
  return async input => {
    const { accountId, taskId, requestKey, sourceUrl, prompt, image } = input;
    await input.onProgress?.('preparing');
    const downloaded = await runLocalWork(async () => {await input.beforeRequest?.();return downloadImage(sourceUrl, { forbidHttpsDowngrade: true });});
    await input.onProgress?.('image');
    const generate = async ({ gateway: selectedGateway, profile }) => {
      const [width, height] = image.ratio.split(":").map(Number);
      const longest = resolutions[image.resolution];
      const targetSize = `${Math.round(longest * width / Math.max(width, height))}x${Math.round(longest * height / Math.max(width, height))}`;
      const size = gatewayImageSize(profile.imageModel, image.ratio, targetSize);
      const adapterProfile = Object.fromEntries(["id", "accountId", "configVersion", "baseUrl", "apiKeyEnvName",
        "textProtocol", "imageProtocol", "textModel", "imageModel", "enabled", "connectionId", "connectionVersion"]
        .filter(key => profile[key] !== undefined).map(key => [key, profile[key]]));
      const generationConfig = { profileId: profile.id, configVersion: profile.configVersion,
        textModel: profile.textModel, imageModel: profile.imageModel };
      try {
        const result = await selectedGateway.generateImage({ profile: adapterProfile, model: profile.imageModel,
          correlationId: taskId, requestKey, prompt: `${prompt}\n输出图片语言：${image.language}`,
          sourceImages: [{ bytes: downloaded.buffer, contentType: downloaded.contentType }], size, quality: image.quality });
        return { ...result, generationConfig };
      } catch (error) { error.generationConfig = generationConfig; throw error; }
    };
    let result = runChannel ? await runChannel(input, generate) : await generate({gateway, profile: await loadProfile({accountId})});
    await input.onProgress?.('saving');
    return runLocalWork(async () => {
      try {
        if (!["image/png", "image/jpeg", "image/webp"].includes(result.contentType) || !result.bytes?.length
          || result.bytes.length > 32 * 1024 * 1024 || !publication) throw new Error("image storage boundary");
        const generationConfig = result.generationConfig;
        result = await prepareAiListingImageForPublication(result);
        const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[result.contentType];
        const objectKey = `${publication.prefix}/ai-image-listing/${randomBytes(32).toString("hex")}.${extension}`;
        await putObject({ key: objectKey, contentType: result.contentType,
          buffer: Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes) });
        return { generatedUrl: new URL(objectKey, publication.baseUrl).href, objectKey, contentType: result.contentType,
          gatewayRequestId: result.requestId || null, usage: result.usage, generationConfig };
      } catch {
        throw Object.assign(new Error("AI 上架图片保存失败"), { stage: "upload", code: "AI_LISTING_STORAGE_FAILED" });
      }
    });
  };
}

// One local slot covers real downloads/decoding; remote AI waiting never holds it.
export function createAiListingGridPort({downloadImage, recognizeText, runChannel, putObject, publication,
  onProgress=async()=>{}, runLocalWork=work=>work()}) {
  return async input => {
    if (!publication) throw Object.assign(new Error("公开图片存储未配置"), {code:"AI_LISTING_PUBLICATION_REQUIRED"});
    const progress=async stage=>{await input.onProgress?.(stage);await onProgress(stage);};
    await progress('preparing');
    const prepared=await runLocalWork(async()=>{
      await input.beforeRequest?.();
      const sources=[];
      for(const source of input.sources) sources.push((await downloadImage(source.sourceUrl)).buffer);
      const facts=await recognizeText(sources);
      return prepareGrid({sources,facts,prompt:input.prompt,language:input.image.language});
    });
    await progress('image');
    const result=await runChannel(input, async ({gateway,profile}) => {
      const adapterProfile=Object.fromEntries(["id","accountId","configVersion","baseUrl","apiKeyEnvName",
        "textProtocol","imageProtocol","textModel","imageModel","enabled","connectionId","connectionVersion"]
        .filter(key=>profile[key]!==undefined).map(key=>[key,profile[key]]));
      const generated=await gateway.generateImage({profile:adapterProfile,model:profile.imageModel,
        correlationId:input.taskId,requestKey:input.requestKey,prompt:prepared.prompt,
        sourceImages:[{bytes:prepared.bytes,contentType:"image/png"}],
        size:`${prepared.layout.width}x${prepared.layout.height}`,quality:input.image.quality});
      return {...generated,gatewayRequestId:generated.requestId||null,
        generationConfig:{profileId:profile.id,configVersion:profile.configVersion,textModel:profile.textModel,
          imageModel:profile.imageModel,generationMode:"GRID",layout:prepared.layout}};
    });
    prepared.bytes=null;
    await progress('slicing');
    return runLocalWork(async()=>{
      const tiles=await splitGrid(result.bytes,prepared.layout,input.sources.length);
      const images=[];
      await progress('saving');
      try {
        for(let i=0;i<tiles.length;i++) {
          const output=await prepareAiListingImageForPublication({bytes:tiles[i],contentType:"image/png"});
          tiles[i]=null;
          const {width,height}=await sharp(output.bytes).metadata();
          const ext=output.contentType==="image/png"?"png":"jpg";
          const objectKey=`${publication.prefix}/ai-image-listing/${randomBytes(32).toString("hex")}.${ext}`;
          await putObject({key:objectKey,contentType:output.contentType,buffer:output.bytes});
          images.push({sku:input.sku,index:input.sources[i].index,generatedUrl:new URL(objectKey,publication.baseUrl).href,
            objectKey,contentType:output.contentType,width,height,generationConfig:result.generationConfig});
        }
      } catch {throw Object.assign(new Error("AI 上架图片保存失败"),{stage:"upload",code:"AI_LISTING_STORAGE_FAILED"});}
      return {images};
    });
  };
}

function imageList(...candidates) {
  for (const candidate of candidates) {
    const values = (Array.isArray(candidate) ? candidate : [candidate]).map(value => typeof value === "string" ? value : value?.url || value?.src || value?.file_name || value?.value).filter(Boolean);
    if (values.length) return values;
  }
  return [];
}

// Excel supplies SKU identities, not product data. Reuse the same client capture
// job and V4 saved source as Web links; polling must never launch a server browser.
export async function collectAiListingSkuSource({ accountId, sku, config, taskId, collectionJobId, collectionAttempt = 0 },
  { findExisting, webCollection, loadSources }) {
  let collectItemId = collectionJobId ? null : await findExisting({ accountId, sku });
  if (!collectItemId) {
    const job = collectionJobId ? await webCollection.get({ accountId, id: collectionJobId })
      : await webCollection.create({ accountId, sku, scope: 'CURRENT', requestId: `ai-${taskId}-${collectionAttempt}` });
    if (['FAILED', 'CANCELLED'].includes(job.status)) throw Object.assign(new Error(job.message || '商品采集失败，请重试'), {
      code: 'AI_LISTING_COLLECTION_FAILED',
    });
    if (job.status !== 'COMPLETED') throw Object.assign(new Error(job.message || '等待已登录的扩展采集商品'), {
      code: 'AI_LISTING_COLLECTION_PENDING', collectionJobId: job.id,
      collectionStage: job.status === 'PROCESSING' ? 'capturing' : 'waiting_extension',
    });
    collectItemId = job.result?.collectItemId;
  }
  if (!collectItemId || collectItemId.startsWith('listed:')) throw Object.assign(new Error('商品已上架或采集记录不可用，请在采集箱核对'), {
    code: 'AI_LISTING_ALREADY_LISTED',
  });
  const sources = await loadSources({ accountId, collectItemIds: [collectItemId], config, excludeSubmittedSkus: true });
  const source = sources.find(item => item.collectItemId === collectItemId);
  if (!source) throw Object.assign(new Error('商品已上架或采集记录已删除，请在采集箱核对'), { code: 'AI_LISTING_SOURCE_NOT_FOUND' });
  if (!source.items.some(item => item.sku === sku)) throw Object.assign(new Error(`SKU ${sku} 已上架或已从草稿移除，未改为处理其他变体`), { code: 'AI_LISTING_ALREADY_LISTED' });
  // Excel is explicitly SKU-based; a saved group may contain siblings absent
  // from the workbook. Batch grouping later merges only the requested rows.
  return { ...source, items: source.items.filter(item => item.sku === sku),
    ...(source.enrichmentJobs ? { enrichmentJobs: source.enrichmentJobs.filter(job => job.sku === sku) } : {}) };
}

export async function loadAiListingCollectSources({ pool, accountId, collectItemIds, config, buildListingItems,
  readCollectItems = listCollectItemsV3, onSourceError, excludeSubmittedSkus = false }) {
  if (!collectItemIds.length) return [];
  // Read job state first: a completion observed here must precede the draft snapshot below.
  // A concurrent completion after this read costs one poll, never freezes an older incomplete draft.
  const jobs = (await pool.query(`SELECT DISTINCT ON (collect_item_id,sku) collect_item_id,sku,status
    FROM collector_ozon_enrichment_jobs WHERE account_id=$1 AND collect_item_id=ANY($2::text[])
    ORDER BY collect_item_id,sku,created_at DESC,id DESC`, [accountId, collectItemIds])).rows;
  const records = await readCollectItems({ accountId, ids: collectItemIds, limit: collectItemIds.length });
  const categories = createAccountSharedOzonCategoryService({ repository: createPostgresAccountSharedOzonCategoryRepository({ pool }) });
  const resolutions = new Map((await categories.readForItems({ accountId, collectItemIds }))
    .map(row => [row.collectItemId, row.categoryResolution]));
  const jobsByItem = new Map();
  for (const job of jobs) {
    const entries = jobsByItem.get(job.collect_item_id) || [];
    entries.push({ sku: job.sku, status: job.status }); jobsByItem.set(job.collect_item_id, entries);
  }
  const completed=(await pool.query(`SELECT status,body->'source'->'items' AS items,body->'submissionResults' AS results
    FROM ai_image_listing_tasks WHERE account_id=$1 AND (status='COMPLETED' OR body->'submissionResults' @> '[{"importStatus":"SUCCEEDED"}]'::jsonb)`,[accountId]))
    .rows.map(row=>({status:row.status,source:{items:row.items},submissionResults:row.results}));
  if (excludeSubmittedSkus) {
    const skus = [...new Set(records.flatMap(item => item.listingDraft?.variants?.length
      ? item.listingDraft.variants.map(variant => String(variant.sku)) : [String(item.sku)]))];
    if (skus.length) {
      const listed = (await pool.query(`SELECT DISTINCT item.sku FROM submission_items item
        JOIN submission_jobs job ON job.id=item.job_id
        JOIN submission_snapshots snapshot ON snapshot.id=item.snapshot_id AND snapshot.id=job.snapshot_id AND snapshot.account_id=job.account_id
        LEFT JOIN collect_items collect ON collect.id=job.collect_item_id AND collect.account_id=job.account_id
        WHERE job.account_id=$1 AND item.status='SUCCEEDED' AND item.sku=ANY($2::text[])
          AND lower(COALESCE(NULLIF(item.source,''),collect.source)) IN ('ozon','auto_listing_excel_sku')`, [accountId, skus])).rows;
      completed.push({status:'COMPLETED',source:{items:listed}});
    }
  }
  const sources=[];const remaining=withoutListedSkus(records,completed);
  if(onSourceError){
    const remainingIds=new Set(remaining.map(item=>item.id));
    for(const item of records)if(!remainingIds.has(item.id))onSourceError({collectItemId:item.id,error:Object.assign(new Error('商品已成功上架，无需重复创建任务'),{code:'AI_LISTING_ALREADY_LISTED'})});
  }
  for(const item of remaining){
    try {sources.push({...buildAiListingSource({ ...item, categoryResolution: resolutions.get(item.id) || item.categoryResolution }, config.targetStoreId, buildListingItems),enrichmentJobs: jobsByItem.get(item.id) || []});}
    catch(error){if(!onSourceError)throw error;onSourceError({collectItemId:item.id,error});}
  }
  return sources;
}

export function buildAiListingSource(item, targetStoreId, buildListingItems = buildCollectBoxListingItems) {
  const snapshot = structuredClone(item);
  const sku = String(item.sku || item.listingDraft?.sku || "");
  const variants = item.listingDraft?.variants || [];
  const items = buildListingItems(snapshot, targetStoreId).map(listingItem => {
    const rowSku = String(listingItem.scraped_sku || sku);
    const variant = variants.find(v => String(v.sku || v.product_id) === rowSku) || {};
    const sourceVariant = listingItem._sourceVariant || {};
    const gallery = (sourceVariant.attributes || []).find(attribute => Number(attribute.id || attribute.key) === 4195);
    const sourceGallery = imageList(gallery?.values, gallery?.collection, gallery?.value);
    const images = rowSku === sku
      ? imageList(item.images, item.listingDraft?.images, sourceVariant.images, variant.images, variant.image, item.image)
      : imageList(sourceVariant.images, variant.images, sourceGallery, sourceVariant.media?.images, variant.image, sourceVariant.image);
    const categoryResolution=snapshot.categoryResolution || snapshot.listingDraft?.categoryResolution;
    return { sku: rowSku, images, ...(categoryResolution?.status==='ACTIVE'?{categoryResolution:structuredClone(categoryResolution)}:{}), listingItem: { ...listingItem, images } };
  });
  return { collectItemId: String(item.id), sku, name: String(item.name || item.listingDraft?.title || sku),
    thumbnail: items[0]?.images[0] || "", items, sourceSnapshot: snapshot };
}
